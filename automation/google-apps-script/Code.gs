const HEADERS_ROW = 4;
const PRODUCTS_SHEET = 'Produtos';
const HISTORY_SHEET = 'Historico';

const RECEIPTS_SHEET = 'BotRecebimentos';
const MAX_COMMAND_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 48 * 60 * 60 * 1000;
const REQUIRED_HEADERS = ['id', 'nome', 'descrição', 'preço', 'preço antigo', 'loja', 'link de afiliado', 'selo', 'características', 'ativo', 'imagem', 'texto alternativo', 'data_verificacao'];
let commandVerifiedAt = null;

function doGet(event) {
  // Chave exclusiva de leitura, compartilhada somente com o servidor da Vercel.
  const key = PropertiesService.getScriptProperties().getProperty('CATALOG_READ_KEY');
  if (!key || key.length < 32 || !event || !event.parameter || event.parameter.catalog_key !== key) {
    return jsonResponse({ error: 'Unauthorized' });
  }
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('catalog_v2');
    const products = cached ? JSON.parse(cached) : getProducts();
    if (!cached) {
      const serialized = JSON.stringify(products);
      if (serialized.length < 20000) cache.put('catalog_v2', serialized, 15);
    }
    return jsonResponse(products.map(hideExpiredPrices));
  } catch (_) {
    return jsonResponse({ error: 'Catálogo indisponível' });
  }
}

function doPost(event) {
  const settings = getSettings();
  if (!event || !event.parameter || event.parameter.key !== settings.webhookSecret) {
    return webhookResponse('Unauthorized');
  }
  const contents = event.postData && event.postData.contents;
  if (typeof contents !== 'string' || contents.length > 20000) return webhookResponse('Ignored');
  let update;
  try { update = JSON.parse(contents); } catch (_) { return webhookResponse('Ignored'); }
  const message = update && update.message;
  const updateId = update && update.update_id;
  // Sem vinculação pelo chat: somente o ID configurado pelo dono no editor é aceito.
  if (!settings.allowedChatId || !message || !message.chat || message.chat.type !== 'private' ||
      String(message.chat.id) !== settings.allowedChatId || !message.from || message.from.is_bot ||
      String(message.from.id) !== settings.allowedChatId || !Number.isSafeInteger(updateId) || updateId < 0 ||
      typeof message.text !== 'string' || message.text.length > 4000 || !Number.isSafeInteger(message.date)) {
    return webhookResponse('Ignored');
  }
  const sentAt = message.date * 1000;
  if (Date.now() - sentAt > MAX_COMMAND_AGE_MS || sentAt > Date.now() + 60000) return webhookResponse('Ignored');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const receipt = openReceipt(updateId);
    if (receipt.state === 'sent') return webhookResponse('OK');
    let reply = receipt.reply;
    if (receipt.state === 'processing') {
      // Uma interrupção pode ter ocorrido depois da gravação. Nunca execute outra vez.
      reply = 'Este comando ficou com resultado incerto. Confira /produtos e o Historico na planilha antes de enviar um novo comando.';
    } else if (receipt.state === 'new') {
      commandVerifiedAt = new Date(Math.min(sentAt, Date.now()));
      try { reply = handleCommand(message.text); }
      catch (_) { reply = 'Não foi possível concluir o comando. Pode ter ocorrido uma gravação parcial. Confira /produtos e o Historico antes de tentar novamente.'; }
      finally { commandVerifiedAt = null; }
    }
    saveReceipt(receipt, 'done', reply);
    sendTelegramMessage(message.chat.id, reply, settings.botToken);
    saveReceipt(receipt, 'sent', reply);
    return webhookResponse('OK');
  } finally {
    lock.releaseLock();
  }
}

function openReceipt(updateId) {
  const spreadsheet = SpreadsheetApp.openById(getSettings().spreadsheetId);
  const sheet = spreadsheet.getSheetByName(RECEIPTS_SHEET) || spreadsheet.insertSheet(RECEIPTS_SHEET);
  if (!sheet.getLastRow()) sheet.appendRow(['update_id', 'recebido_em', 'estado', 'resposta']);
  const count = sheet.getLastRow() - 1;
  const rows = count > 0 ? sheet.getRange(2, 1, count, 4).getValues() : [];
  // Retenção maior que a janela de aceitação de mensagens. Remover cache não afeta este registro.
  let expired = 0;
  while (expired < rows.length && rows[expired][1] instanceof Date &&
         Date.now() - rows[expired][1].getTime() > RECEIPT_RETENTION_MS) expired++;
  if (expired) sheet.deleteRows(2, expired);
  const recent = rows.slice(expired);
  const index = recent.findIndex(row => String(row[0]) === String(updateId));
  if (index >= 0) return { sheet, row: index + 2, state: recent[index][2], reply: String(recent[index][3] || '') };
  if (recent.length >= 10000) throw new Error('Limite de comandos atingido.');
  sheet.appendRow([String(updateId), new Date(), 'processing', '']);
  SpreadsheetApp.flush(); // persistir ANTES de qualquer mutação de produto
  return { sheet, row: sheet.getLastRow(), state: 'new', reply: '' };
}

function saveReceipt(receipt, state, reply) {
  receipt.sheet.getRange(receipt.row, 3, 1, 2).setValues([[state, sheetLiteral(reply)]]);
  SpreadsheetApp.flush();
}

function installWebhook() {
  const settings = getSettings();
  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(webAppUrl)) {
    throw new Error('Defina WEB_APP_URL com a URL /exec da implantação do aplicativo da Web.');
  }
  const webhookUrl = `${webAppUrl}?key=${encodeURIComponent(settings.webhookSecret)}`;
  telegramRequest('setWebhook', settings.botToken, { url: webhookUrl, max_connections: 1, allowed_updates: ['message'] });
  telegramRequest('setMyCommands', settings.botToken, { commands: [
      { command: 'ajuda', description: 'Ver comandos disponíveis' },
      { command: 'produtos', description: 'Listar produtos e preços' },
      { command: 'preco', description: 'Atualizar somente o preço' },
      { command: 'link', description: 'Atualizar somente o link' },
      { command: 'atualizar', description: 'Atualizar preço e link' },
      { command: 'adicionar', description: 'Cadastrar produto completo' },
      { command: 'ativar', description: 'Exibir produto no site' },
      { command: 'desativar', description: 'Ocultar produto no site' }
    ]
  });
  return 'Webhook e comandos configurados.';
}

// Execute no editor. O registro não inclui o token nem a URL com o segredo.
function diagnosticarWebhook() {
  const settings = getSettings();
  const result = telegramRequest('getWebhookInfo', settings.botToken);
  const info = result.result;
  const summary = {
    webhookAtivo: Boolean(info.url),
    mensagensPendentes: info.pending_update_count,
    haErro: Boolean(info.last_error_message)
  };
  console.log(JSON.stringify(summary));
  return summary;
}

function handleCommand(text) {
  const normalizedText = normalizeTelegramText(text);
  const [rawCommand, productId, ...args] = normalizedText.split(/\s+/);
  const command = rawCommand.replace(/@[\w_]+$/, '').toLowerCase();
  if (command === '/ajuda' || command === '/start') {
    return 'Use:\n/preco ID 51,00\n/link ID https://meli.la/...\n/atualizar ID 51,00 https://meli.la/...\n/adicionar ID | Nome | Descrição | 51,00 | https://meli.la/... | imagem opcional | alt opcional | característica 1; característica 2 | selo opcional\n/ativar ID\n/desativar ID\n/produtos';
  }
  if (command === '/produtos') {
    const products = getProducts();
    const page = /^\d+$/.test(productId || '1') ? Number(productId || 1) : 0;
    const pages = Math.max(1, Math.ceil(products.length / 30));
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return 'Erro: página inválida. Use /produtos 1.';
    return products.length ? products.slice((page - 1) * 30, page * 30).map(product => `• ${product.id} — ${product.price || 'sem preço'}`).join('\n') + `\nPágina ${page}/${pages}. Use /produtos N para outra página.` : 'Nenhum produto ativo encontrado.';
  }
  if (command === '/adicionar') return addProductFromCommand(normalizedText);
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

function addProductFromCommand(text) {
  const payload = text.replace(/^\/adicionar(?:@[\w_]+)?\s*/i, '');
  const fields = payload.split('|').map(value => value.trim());
  const [id, name, description, rawPrice, url, image = '', alt = '', rawFeatures = '', badge = ''] = fields;
  if (fields.length < 5 || fields.length > 9 || !id || !name || !rawPrice || !url) {
    return 'Erro: use /adicionar ID | Nome | Descrição | 51,00 | https://meli.la/... | imagem opcional | alt opcional | características | selo opcional';
  }
  if (name.length > 160 || description.length > 1200 || alt.length > 240 || badge.length > 80 || rawFeatures.length > 400) return 'Erro: texto muito longo. Reduza os campos do produto.';
  if (!isProductId(id)) return 'Erro: o ID deve usar letras minúsculas, números e hífens. Exemplo: garrafa-termica-1l.';
  const price = parsePrice(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return 'Erro: informe um preço válido, por exemplo 51,00.';
  if (!isAffiliateUrl(url)) return 'Erro: use um link https://meli.la/... válido.';
  if (!isProductImage(image)) return 'Erro: a imagem deve estar vazia, começar com /assets/ ou usar uma URL https://.';

  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  if (sheet.getLastRow() - HEADERS_ROW >= 1000) return 'Erro: limite de 1000 produtos atingido.';
  if (findProductRow(sheet, headers.id, id)) return `Erro: já existe um produto com o ID ${id}.`;
  const features = rawFeatures.split(';').map(value => value.trim()).filter(Boolean).slice(0, 4).join(' | ');
  const newRow = Array(sheet.getLastColumn()).fill('');
  const values = {
    id,
    nome: name,
    descrição: description,
    preço: price,
    loja: 'Mercado Livre',
    'link de afiliado': url,
    selo: badge,
    características: features,
    ativo: true,
    imagem: image,
    'texto alternativo': alt || name,
    data_verificacao: commandVerifiedAt || new Date()
  };
  Object.entries(values).forEach(([header, value]) => { newRow[headers[header] - 1] = sheetLiteral(value); });
  sheet.appendRow(newRow);
  invalidateCatalog();
  const row = sheet.getLastRow();
  sheet.getRange(row, headers.preço).setNumberFormat('R$ #,##0.00');
  sheet.getRange(row, headers.data_verificacao).setNumberFormat('dd/MM/yyyy HH:mm');
  appendHistory(id, rawPrice, url, 'adicionar');
  return `${id}: produto adicionado por ${formatPrice(price)}.`;
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
  Object.entries(changes).forEach(([header, value]) => sheet.getRange(row, headers[header]).setValue(sheetLiteral(value)));
  if (priceVerified) sheet.getRange(row, headers.data_verificacao).setValue(commandVerifiedAt || new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
  invalidateCatalog();
}

function getProducts() {
  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  const rowCount = sheet.getLastRow() - HEADERS_ROW;
  if (rowCount <= 0) return [];
  const values = sheet.getRange(HEADERS_ROW + 1, 1, rowCount, sheet.getLastColumn()).getValues();
  return values.filter(row => row[headers.id - 1] && isActive(row[headers.ativo - 1])).map(row => ({
    id: String(row[headers.id - 1]),
    name: String(row[headers.nome - 1] || ''),
    description: String(row[headers.descrição - 1] || ''),
    price: formatPrice(row[headers.preço - 1]),
    originalPrice: row[headers['preço antigo'] - 1] ? formatPrice(row[headers['preço antigo'] - 1]) : '',
    store: String(row[headers.loja - 1] || 'Mercado Livre'),
    url: String(row[headers['link de afiliado'] - 1] || ''),
    badge: String(row[headers.selo - 1] || ''),
    features: String(row[headers.características - 1] || '').split('|').map(item => item.trim()).filter(Boolean),
    active: isActive(row[headers.ativo - 1]),
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
    allowedChatId: properties.getProperty('ALLOWED_CHAT_ID')
  };
  if (!settings.spreadsheetId || !settings.botToken || !settings.webhookSecret) {
    throw new Error('Configure as propriedades do script antes de usar o bot.');
  }
  return settings;
}

function getProductSheet() {
  const sheet = SpreadsheetApp.openById(getSettings().spreadsheetId).getSheetByName(PRODUCTS_SHEET);
  if (!sheet) throw new Error('Aba Produtos ausente.');
  return sheet;
}

function getHeaders(sheet) {
  const map = Object.create(null);
  sheet.getRange(HEADERS_ROW, 1, 1, sheet.getLastColumn()).getValues()[0].forEach((header, index) => {
    const name = String(header).trim();
    if (name && Object.prototype.hasOwnProperty.call(map, name)) throw new Error('Cabeçalho duplicado.');
    if (name) map[name] = index + 1;
  });
  if (REQUIRED_HEADERS.some(header => !map[header])) throw new Error('Cabeçalhos obrigatórios ausentes.');
  return map;
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
  sheet.appendRow([new Date(), productId, action, price, url].map(sheetLiteral));
}

function sendTelegramMessage(chatId, text, botToken) {
  // Divide listas grandes sem usar HTML ou Markdown interpretável pelo Telegram.
  const chars = Array.from(String(text || 'Sem resposta.'));
  for (let offset = 0; offset < chars.length; offset += 1800) {
    telegramRequest('sendMessage', botToken, { chat_id: chatId, text: chars.slice(offset, offset + 1800).join('') });
  }
}

function telegramRequest(method, token, payload) {
  try {
    const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify(payload || {})
    });
    const result = JSON.parse(response.getContentText());
    if (!result.ok) throw new Error('Telegram recusou a operação.');
    return result;
  } catch (_) {
    // Exceções do UrlFetch podem conter a URL com token. Nunca propagá-las.
    throw new Error('Falha na comunicação com o Telegram. Verifique a configuração no editor.');
  }
}

function sheetLiteral(value) {
  return typeof value === 'string' && /^[\s]*[=+@'-]/.test(value) ? "'" + value : value;
}

function invalidateCatalog() {
  try { CacheService.getScriptCache().remove('catalog_v2'); } catch (_) { /* expira em 15 s */ }
}

function isActive(value) {
  return value === true || value === 1 || /^(true|verdadeiro|1)$/i.test(String(value).trim());
}

function hideExpiredPrices(product) {
  const age = Date.now() - Date.parse(product.data_verificacao);
  if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000 || !product.price) {
    return Object.assign({}, product, { price: '', originalPrice: '' });
  }
  return product;
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

function isProductId(value) {
  return String(value || '').length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

function isProductImage(value) {
  const image = String(value || '');
  return image.length <= 2000 && (!image || /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(image) || /^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:[/?#][^\s\\]*)?$/.test(image));
}

function normalizeTelegramText(value) {
  return String(value || '').normalize('NFKC').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatPrice(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? `R$ ${amount.toFixed(2).replace('.', ',')}` : '';
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
