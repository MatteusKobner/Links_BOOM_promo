const HEADERS_ROW = 4;
const PRODUCTS_SHEET = 'Produtos';
const HISTORY_SHEET = 'Historico';

function doGet() {
  return jsonResponse(getProducts());
}

function doPost(event) {
  const settings = getSettings();
  if (!event || !event.parameter || event.parameter.key !== settings.webhookSecret) {
    return webhookResponse('Unauthorized');
  }

  const update = JSON.parse(event.postData && event.postData.contents || '{}');
  const message = update.message;
  if (!message || !message.chat || message.chat.type !== 'private') return webhookResponse('Ignored');

  // O Telegram pode repetir uma entrega. O bloqueio evita duas gravações simultâneas.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cache = CacheService.getScriptCache();
    const updateId = Number(update.update_id);
    const cacheKey = Number.isSafeInteger(updateId) ? `telegram_update_${updateId}` : '';
    const cachedReply = cacheKey && cache.get(cacheKey);
    if (cachedReply) {
      const previous = JSON.parse(cachedReply);
      if (!previous.sent) {
        sendTelegramMessage(message.chat.id, previous.text, settings.botToken);
        cache.put(cacheKey, JSON.stringify({ text: previous.text, sent: true }), 21600);
      }
      return webhookResponse('OK');
    }

    const properties = PropertiesService.getScriptProperties();
    const allowedChatId = properties.getProperty('ALLOWED_CHAT_ID');
    let reply;
    if (!allowedChatId) {
      const setupCode = normalizeTelegramText(settings.setupCode);
      const receivedText = normalizeTelegramText(message.text);
      const receivedCode = receivedText.replace(/^\/start(?:@[\w_]+)?\s*/i, '').trim();
      if (!/^\/start(?:@[\w_]+)?\s+/i.test(receivedText) || receivedCode !== setupCode) {
        reply = `Comando inválido. Envie:\n/start ${setupCode}`;
      } else {
        properties.setProperty('ALLOWED_CHAT_ID', String(message.chat.id));
        reply = 'Conta vinculada. Use /ajuda para ver os comandos.';
      }
    } else if (String(message.chat.id) !== allowedChatId) {
      return webhookResponse('Ignored');
    } else {
      reply = handleCommand(message.text || '');
    }

    if (cacheKey) cache.put(cacheKey, JSON.stringify({ text: reply, sent: false }), 21600);
    sendTelegramMessage(message.chat.id, reply, settings.botToken);
    if (cacheKey) cache.put(cacheKey, JSON.stringify({ text: reply, sent: true }), 21600);
    return webhookResponse('OK');
  } finally {
    lock.releaseLock();
  }
}

function installWebhook() {
  const settings = getSettings();
  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl || !/^https:\/\/script\.google\.com\/macros\/s\//.test(webAppUrl)) {
    throw new Error('Defina WEB_APP_URL com a URL /exec da implantação do aplicativo da Web.');
  }
  const webhookUrl = `${webAppUrl}?key=${encodeURIComponent(settings.webhookSecret)}`;
  const apiBase = `https://api.telegram.org/bot${settings.botToken}`;
  const webhookResponse = UrlFetchApp.fetch(`${apiBase}/setWebhook`, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ url: webhookUrl, max_connections: 1 })
  });
  const commandsResponse = UrlFetchApp.fetch(`${apiBase}/setMyCommands`, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ commands: [
      { command: 'ajuda', description: 'Ver comandos disponíveis' },
      { command: 'produtos', description: 'Listar produtos e preços' },
      { command: 'preco', description: 'Atualizar somente o preço' },
      { command: 'link', description: 'Atualizar somente o link' },
      { command: 'atualizar', description: 'Atualizar preço e link' },
      { command: 'ativar', description: 'Exibir produto no site' },
      { command: 'desativar', description: 'Ocultar produto no site' }
    ] })
  });
  const webhookResult = JSON.parse(webhookResponse.getContentText());
  const commandsResult = JSON.parse(commandsResponse.getContentText());
  if (!webhookResult.ok || !commandsResult.ok) throw new Error('Falha ao configurar o bot. Verifique as execuções.');
  return 'Webhook e comandos configurados.';
}

// Execute no editor. O registro não inclui o token nem a URL com o segredo.
function diagnosticarWebhook() {
  const settings = getSettings();
  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${settings.botToken}/getWebhookInfo`);
  const result = JSON.parse(response.getContentText());
  if (!result.ok) throw new Error('Não foi possível consultar o estado do webhook.');
  const info = result.result;
  const summary = {
    webhookAtivo: Boolean(info.url),
    mensagensPendentes: info.pending_update_count,
    ultimoErro: info.last_error_message || 'nenhum'
  };
  console.log(JSON.stringify(summary));
  return summary;
}

function handleCommand(text) {
  const [rawCommand, productId, ...args] = normalizeTelegramText(text).split(/\s+/);
  const command = rawCommand.replace(/@[\w_]+$/, '').toLowerCase();
  if (command === '/ajuda' || command === '/start') {
    return 'Use:\n/preco ID 51,00\n/link ID https://meli.la/...\n/atualizar ID 51,00 https://meli.la/...\n/ativar ID\n/desativar ID\n/produtos';
  }
  if (command === '/produtos') {
    const products = getProducts();
    return products.length ? products.map(product => `• ${product.id} — ${product.price}`).join('\n') : 'Nenhum produto ativo encontrado.';
  }
  if (!productId) return 'Informe o ID do produto. Use /produtos para ver a lista.';

  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  const row = findProductRow(sheet, headers.id, productId);
  if (!row) return `Não encontrei o produto: ${productId}`;

  if (command === '/ativar' || command === '/desativar') {
    updateProduct(sheet, headers, row, { ativo: command === '/ativar' });
    appendHistory(productId, '', '', command.slice(1));
    return `${productId}: ${command === '/ativar' ? 'ativado' : 'desativado'}.`;
  }
  if (command === '/preco') return updatePrice(sheet, headers, row, productId, args[0]);
  if (command === '/link') return updateLink(sheet, headers, row, productId, args[0]);
  if (command === '/atualizar') {
    const [price, url] = args;
    const amount = parsePrice(price);
    if (!Number.isFinite(amount) || amount <= 0) return 'Erro: informe um preço válido, por exemplo 51,00.';
    if (url && !isAffiliateUrl(url)) return 'Erro: use um link https://meli.la/... válido.';
    updateProduct(sheet, headers, row, url ? { preço: amount, 'link de afiliado': url } : { preço: amount }, true);
    appendHistory(productId, price, url || '', 'atualizar');
    return `${productId}: preço atualizado para ${formatPrice(amount)}${url ? ' e link atualizado' : ''}.`;
  }
  return 'Comando não reconhecido. Use /ajuda.';
}

function updatePrice(sheet, headers, row, productId, rawPrice) {
  const price = parsePrice(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return 'Erro: informe um preço válido, por exemplo 51,00.';
  updateProduct(sheet, headers, row, { preço: price }, true);
  appendHistory(productId, rawPrice, '', 'preço');
  return `${productId}: preço atualizado para ${formatPrice(price)}.`;
}

function updateLink(sheet, headers, row, productId, url) {
  if (!isAffiliateUrl(url)) return 'Erro: use um link https://meli.la/... válido.';
  updateProduct(sheet, headers, row, { 'link de afiliado': url });
  appendHistory(productId, '', url, 'link');
  return `${productId}: link atualizado.`;
}

function updateProduct(sheet, headers, row, changes, priceVerified = false) {
  Object.entries(changes).forEach(([header, value]) => sheet.getRange(row, headers[header]).setValue(value));
  if (priceVerified) sheet.getRange(row, headers.data_verificacao).setValue(new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
}

function getProducts() {
  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  const rowCount = sheet.getLastRow() - HEADERS_ROW;
  if (rowCount <= 0) return [];
  const values = sheet.getRange(HEADERS_ROW + 1, 1, rowCount, sheet.getLastColumn()).getValues();
  return values.filter(row => row[headers.id - 1] && row[headers.ativo - 1] !== false).map(row => ({
    id: String(row[headers.id - 1]),
    name: String(row[headers.nome - 1] || ''),
    description: String(row[headers.descrição - 1] || ''),
    price: formatPrice(row[headers.preço - 1]),
    originalPrice: row[headers['preço antigo'] - 1] ? formatPrice(row[headers['preço antigo'] - 1]) : '',
    store: String(row[headers.loja - 1] || 'Mercado Livre'),
    url: String(row[headers['link de afiliado'] - 1] || ''),
    badge: String(row[headers.selo - 1] || ''),
    features: String(row[headers.características - 1] || '').split('|').map(item => item.trim()).filter(Boolean),
    active: row[headers.ativo - 1] !== false,
    image: String(row[headers.imagem - 1] || ''),
    alt: String(row[headers['texto alternativo'] - 1] || ''),
    data_verificacao: toIso(row[headers.data_verificacao - 1])
  }));
}

function getSettings() {
  const properties = PropertiesService.getScriptProperties();
  const settings = {
    spreadsheetId: properties.getProperty('SPREADSHEET_ID'),
    botToken: properties.getProperty('TELEGRAM_BOT_TOKEN'),
    webhookSecret: properties.getProperty('TELEGRAM_WEBHOOK_SECRET'),
    allowedChatId: properties.getProperty('ALLOWED_CHAT_ID'),
    setupCode: properties.getProperty('SETUP_CODE')
  };
  if (!settings.spreadsheetId || !settings.botToken || !settings.webhookSecret || !settings.setupCode) {
    throw new Error('Configure as propriedades do script antes de usar o bot.');
  }
  return settings;
}

function getProductSheet() {
  return SpreadsheetApp.openById(getSettings().spreadsheetId).getSheetByName(PRODUCTS_SHEET);
}

function getHeaders(sheet) {
  return sheet.getRange(HEADERS_ROW, 1, 1, sheet.getLastColumn()).getValues()[0].reduce((map, header, index) => {
    map[String(header).trim()] = index + 1;
    return map;
  }, {});
}

function findProductRow(sheet, idColumn, productId) {
  const rowCount = sheet.getLastRow() - HEADERS_ROW;
  if (rowCount <= 0) return 0;
  const ids = sheet.getRange(HEADERS_ROW + 1, idColumn, rowCount, 1).getValues().flat();
  const offset = ids.findIndex(value => String(value) === productId);
  return offset === -1 ? 0 : HEADERS_ROW + 1 + offset;
}

function appendHistory(productId, price, url, action) {
  const spreadsheet = SpreadsheetApp.openById(getSettings().spreadsheetId);
  const sheet = spreadsheet.getSheetByName(HISTORY_SHEET) || spreadsheet.insertSheet(HISTORY_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(['data', 'produto', 'ação', 'preço informado', 'link informado']);
  sheet.appendRow([new Date(), productId, action, price, url]);
}

function sendTelegramMessage(chatId, text, botToken) {
  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: chatId, text })
  });
  if (!JSON.parse(response.getContentText()).ok) throw new Error('O Telegram não aceitou a resposta do bot.');
}

function parsePrice(value) {
  const input = String(value || '').trim().replace(/^R\$\s*/i, '');
  // Aceita o formato brasileiro e rejeita 51.00 para evitar gravar 5100 por engano.
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(input)) return NaN;
  return Number(input.replace(/\./g, '').replace(',', '.'));
}

function isAffiliateUrl(value) {
  return /^https:\/\/meli\.la\/[A-Za-z0-9]+$/.test(String(value || ''));
}

function normalizeTelegramText(value) {
  return String(value || '').normalize('NFKC').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatPrice(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `R$ ${amount.toFixed(2).replace('.', ',')}` : '';
}

function toIso(value) {
  return value instanceof Date && !isNaN(value) ? value.toISOString() : '';
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function webhookResponse(text) {
  // ContentService redireciona a resposta. Telegram precisa receber HTTP 2xx.
  return HtmlService.createHtmlOutput(text);
}
