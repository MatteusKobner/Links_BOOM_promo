const HEADERS_ROW = 4;
const PRODUCTS_SHEET = 'Produtos';
const HISTORY_SHEET = 'Historico';

const RECEIPTS_SHEET = 'BotRecebimentos';
const MAX_COMMAND_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_PRICE = 1000000000;
const REVIEW_PAGE_SIZE = 5;
const REVIEW_SESSION_SECONDS = 3600;
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
  if (update && update.callback_query) return handleReviewUpdate(update, settings);
  const message = update && update.message;
  const updateId = update && update.update_id;
  const isText = message && typeof message.text === 'string';
  const isPhoto = message && Array.isArray(message.photo) && message.photo.length > 0;
  // Sem vinculação pelo chat: somente o ID configurado pelo dono no editor é aceito.
  if (!settings.allowedChatId || !message || !message.chat || message.chat.type !== 'private' ||
      String(message.chat.id) !== settings.allowedChatId || !message.from || message.from.is_bot ||
      String(message.from.id) !== settings.allowedChatId || !Number.isSafeInteger(updateId) || updateId < 0 ||
      (!isText && !isPhoto) || (isText && message.text.length > 4000) || !Number.isSafeInteger(message.date)) {
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
      try { reply = handleMessage(message); }
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
  if (index >= 0) return { sheet, row: index + 2, state: recent[index][2], reply: decodeReply(recent[index][3]) };
  if (recent.length >= 10000) throw new Error('Limite de comandos atingido.');
  sheet.appendRow([String(updateId), new Date(), 'processing', '']);
  SpreadsheetApp.flush(); // persistir ANTES de qualquer mutação de produto
  return { sheet, row: sheet.getLastRow(), state: 'new', reply: '' };
}

function saveReceipt(receipt, state, reply) {
  const stored = typeof reply === 'string' ? reply : 'BOOM_REPLY_V1:' + JSON.stringify(reply);
  receipt.sheet.getRange(receipt.row, 3, 1, 2).setValues([[state, sheetLiteral(stored)]]);
  SpreadsheetApp.flush();
}

function decodeReply(value) {
  const text = String(value || '');
  if (text.startsWith('BOOM_REPLY_V1:')) {
    try { return JSON.parse(text.slice('BOOM_REPLY_V1:'.length)); } catch (_) { /* recibo antigo/corrompido */ }
  }
  return text;
}

// As sessões guardam só a página visível, com no máximo cinco produtos.
// O token não contém ID do dono, credenciais ou informações de outros produtos.
function reviewSessionKey(token) { return 'review_v1_' + token; }
function telegramExcerpt(value, length) { return Array.from(String(value || '')).slice(0, length).join(''); }

function saveReviewSession(session, preserveView = false) {
  const remaining = Math.floor((session.createdAt + REVIEW_SESSION_SECONDS * 1000 - Date.now()) / 1000);
  if (remaining < 1) throw new Error('Sessão expirada.');
  // Recibos antigos só podem reenviar a mesma versão visual ainda em uso.
  if (!preserveView) session.viewRevision = (session.viewRevision || 0) + 1;
  CacheService.getScriptCache().put(reviewSessionKey(session.token), JSON.stringify(session), remaining);
}

function currentReviewSession(panel, chatId, messageId) {
  if (!panel || !Number.isSafeInteger(panel.viewRevision) || panel.viewRevision < 1) return null;
  const stored = CacheService.getScriptCache().get(reviewSessionKey(panel.sessionId));
  if (!stored) return null;
  const session = JSON.parse(stored);
  if (session.token !== panel.sessionId || session.owner !== String(chatId) ||
      session.viewRevision !== panel.viewRevision || session.busy ||
      session.createdAt > Date.now() || Date.now() - session.createdAt >= REVIEW_SESSION_SECONDS * 1000 ||
      (messageId !== undefined && !session.messageIds.includes(messageId))) return null;
  return session;
}

function reviewToday(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now() &&
    Utilities.formatDate(date, 'America/Sao_Paulo', 'yyyy-MM-dd') ===
    Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
}

function createReviewPage(page, messageId, selectedId) {
  const products = getProducts(true).filter(product => isProductId(product.id)).reverse();
  if (selectedId) {
    const position = products.findIndex(product => product.id === selectedId);
    if (position >= 0) page = Math.floor(position / REVIEW_PAGE_SIZE) + 1;
  }
  const pages = Math.max(1, Math.ceil(products.length / REVIEW_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) return 'Erro: página inválida. Use /conferir.';
  const session = {
    token: Utilities.getUuid().replace(/-/g, ''),
    owner: getSettings().allowedChatId, createdAt: Date.now(), page, pages,
    messageIds: messageId ? [messageId] : [], selectedIndex: null,
    items: products.slice((page - 1) * REVIEW_PAGE_SIZE, page * REVIEW_PAGE_SIZE).map(product => ({
      id: product.id, name: telegramExcerpt(product.name, 90), amount: parsePrice(product.price),
      url: product.url, verifiedAt: product.data_verificacao, active: product.active,
      image: product.image, priceText: product.price,
      state: isValidPrice(parsePrice(product.price)) && reviewToday(product.data_verificacao) ? 'verified' : 'pending'
    }))
  };
  if (selectedId) {
    const index = session.items.findIndex(product => product.id === selectedId);
    if (index >= 0) session.selectedIndex = index;
  }
  // JSON converte NaN em null. Isso continua inválido e nunca habilita confirmação.
  saveReviewSession(session);
  return renderReviewPage(session);
}

function renderReviewPage(session) {
  if (Number.isInteger(session.selectedIndex) && session.items[session.selectedIndex]) return renderProductMenu(session);
  const lines = ['BOOM Promo — produtos', `Página ${session.page}/${session.pages} · ativos e inativos`,
    '', 'Toque no nome de um produto para abrir suas funções.'];
  const keyboard = [];
  session.items.forEach((product, index) => {
    const status = !product.active ? '⏸️' : product.state === 'verified' && reviewToday(product.verifiedAt) ? '✅' : '🟢';
    keyboard.push([{ text: `${status} ${telegramExcerpt(product.name, 44)} · ${formatPrice(product.amount) || 'sem preço'}`,
      callback_data: `bc:${session.token}:o:${index}` }]);
  });
  const navigation = [];
  if (session.page > 1) navigation.push({ text: '⬅️ Anterior', callback_data: `bc:${session.token}:p:${session.page - 1}` });
  if (session.page < session.pages) navigation.push({ text: 'Próxima ➡️', callback_data: `bc:${session.token}:p:${session.page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: '➕ Adicionar produto', callback_data: `bc:${session.token}:n:0` }]);
  if (!session.items.length) lines.push('Nenhum produto cadastrado. Toque em Adicionar produto.');
  lines.push('', '✅ Verificado hoje · 🟢 Ativo · ⏸️ Inativo', 'Lista válida por até 1 hora. Para reabrir, envie /painel.');
  return { kind: 'reviewPanel', sessionId: session.token, viewRevision: session.viewRevision, text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

function renderProductMenu(session) {
  const index = session.selectedIndex;
  const product = session.items[index];
  const verified = product.state === 'verified' && reviewToday(product.verifiedAt);
  const lines = [product.name, `Preço cadastrado: ${formatPrice(product.amount) || 'inválido'}`, `ID: ${product.id}`,
    `${product.active ? '🟢 Ativo' : '⏸️ Inativo'} · ${verified ? '✅ Verificado hoje' : 'A conferir'}`, '',
    'Escolha uma função para este produto. Abra a oferta e confira as condições antes de verificar o preço.',
    'Confirmar preço limpa preço antigo e selo. /cancelar interrompe um pedido.'];
  const keyboard = [], first = [];
  if (isAffiliateUrl(product.url)) first.push({ text: '🔗 Abrir oferta', url: product.url });
  if (product.active && isValidPrice(product.amount) && isAffiliateUrl(product.url)) {
    first.push({ text: verified ? '✅ Verificado' : '✅ Preço continua igual', callback_data: `bc:${session.token}:v:${index}` });
  }
  if (first.length) keyboard.push(first);
  keyboard.push([
    { text: '✏️ Mudar preço', callback_data: `bc:${session.token}:r:${index}` },
    { text: '🔗 Mudar link', callback_data: `bc:${session.token}:l:${index}` }
  ], [
    { text: '🖼️ Trocar foto', callback_data: `bc:${session.token}:i:${index}` },
    { text: product.active ? '⏸️ Desativar' : '▶️ Ativar', callback_data: `bc:${session.token}:${product.active ? 'd' : 'a'}:${index}` }
  ], [{ text: '⬅️ Voltar aos produtos', callback_data: `bc:${session.token}:b:0` }]);
  return { kind: 'reviewPanel', sessionId: session.token, viewRevision: session.viewRevision, text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

function handleReviewUpdate(update, settings) {
  const query = update.callback_query;
  const message = query && query.message;
  // O remetente de callback é query.from; message.from é o próprio bot.
  if (!settings.allowedChatId || !query || !query.from || query.from.is_bot ||
      String(query.from.id) !== settings.allowedChatId || !message || !message.chat ||
      message.chat.type !== 'private' || String(message.chat.id) !== settings.allowedChatId ||
      !Number.isSafeInteger(message.message_id) || message.message_id <= 0 ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0 ||
      typeof query.id !== 'string' || !query.id || query.id.length > 200 ||
      typeof query.data !== 'string' || query.data.length > 64) return webhookResponse('Ignored');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const receipt = openReceipt(update.update_id);
    if (receipt.state === 'sent') {
      answerReviewCallback(query.id, 'Este clique já foi processado.', settings.botToken);
      return webhookResponse('OK');
    }
    let reply = receipt.reply;
    if (receipt.state === 'processing') {
      reply = { notice: 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.' };
    } else if (receipt.state === 'new') {
      commandVerifiedAt = new Date();
      try { reply = query.data.startsWith('bf:') ? applyFlowCallback(query, settings) : applyReviewCallback(query, settings); }
      catch (_) { reply = { notice: 'Não foi possível concluir. Confira /produtos e o Historico; pode ter ocorrido gravação parcial.' }; }
      finally { commandVerifiedAt = null; }
    }
    saveReceipt(receipt, 'done', reply);
    answerReviewCallback(query.id, reply.notice, settings.botToken, !reply.panel && !reply.prompt);
    if (reply.prompt) sendTelegramMessage(message.chat.id, reply.prompt, settings.botToken);
    if (reply.panel && currentReviewSession(reply.panel, message.chat.id, message.message_id)) {
      telegramRequest('editMessageText', settings.botToken, {
        chat_id: message.chat.id, message_id: message.message_id,
        text: reply.panel.text, reply_markup: reply.panel.reply_markup,
        link_preview_options: { is_disabled: true }
      });
    }
    saveReceipt(receipt, 'sent', reply);
    return webhookResponse('OK');
  } finally { lock.releaseLock(); }
}

function applyReviewCallback(query, settings) {
  const match = /^bc:([a-f0-9]{32}):([vprliadnob]):([0-9]{1,4})$/.exec(query.data);
  if (!match) return { notice: 'Botão inválido. Envie /conferir.' };
  const cache = CacheService.getScriptCache();
  const stored = cache.get(reviewSessionKey(match[1]));
  if (!stored) return { notice: 'Esta lista expirou. Envie /conferir para abrir outra.' };
  const session = JSON.parse(stored);
  if (session.owner !== settings.allowedChatId || session.token !== match[1] ||
      !session.messageIds.includes(query.message.message_id) || session.createdAt > Date.now() ||
      Date.now() - session.createdAt >= REVIEW_SESSION_SECONDS * 1000) {
    return { notice: 'Esta lista não é mais válida. Envie /conferir.' };
  }
  if (session.busy) return { notice: 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.' };
  const index = Number(match[3]);
  if (match[2] === 'b') {
    if (index !== 0) return { notice: 'Botão inválido. Envie /painel.' };
    clearProductFlow();
    session.selectedIndex = null;
    saveReviewSession(session);
    return { notice: 'Lista de produtos.', panel: renderReviewPage(session) };
  }
  if (match[2] === 'p') {
    const panel = createReviewPage(index, query.message.message_id);
    if (typeof panel === 'string') return { notice: panel };
    cache.remove(reviewSessionKey(session.token));
    return { notice: 'Lista atualizada.', panel };
  }
  if (match[2] === 'n') {
    if (index !== 0) return { notice: 'Botão inválido. Envie /painel.' };
    return { notice: 'Vamos cadastrar um produto.', prompt: startProductFlow() };
  }
  const product = session.items[index];
  if (!product || !isProductId(product.id)) return { notice: 'Produto inválido. Envie /conferir.' };
  if (product.state === 'processing') return { notice: 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.' };
  if (!unchangedProduct(product)) {
    return { notice: 'O cadastro mudou desde que você abriu a lista. Envie /conferir e confira novamente.' };
  }
  if (match[2] === 'o') {
    clearProductFlow();
    session.selectedIndex = index;
    saveReviewSession(session);
    return { notice: 'Funções do produto.', panel: renderReviewPage(session) };
  }
  if (session.selectedIndex !== index) return { notice: 'Abra o produto na lista antes de usar suas funções.' };
  if (['r', 'l', 'i'].includes(match[2])) {
    return { notice: 'Responda ao pedido que enviei abaixo.', prompt: startEditFlow(match[2], session, index) };
  }
  if (match[2] === 'a' || match[2] === 'd') {
    if ((match[2] === 'a') === product.active) return { notice: 'A visibilidade deste produto já está nessa condição. Envie /painel.' };
    clearProductFlow();
    session.busy = true;
    saveReviewSession(session);
    const result = handleCommand((match[2] === 'a' ? '/ativar ' : '/desativar ') + product.id);
    if (result.startsWith('Erro:') || result.startsWith('Não encontrei')) return { notice: result.slice(0, 190) };
    const panel = createReviewPage(session.page, query.message.message_id, product.id);
    cache.remove(reviewSessionKey(session.token));
    return { notice: result, panel: typeof panel === 'string' ? null : panel };
  }
  if (!product.active || !isValidPrice(product.amount) || !isAffiliateUrl(product.url)) {
    return { notice: 'Produto inativo ou preço/link inválido. Corrija pelo painel antes de verificar.' };
  }
  if (product.state === 'verified' && reviewToday(product.verifiedAt)) {
    return { notice: 'Este preço já foi verificado hoje.', panel: renderReviewPage(session) };
  }
  // Registrar ANTES da mutação: outro clique não repete uma gravação incerta.
  product.state = 'processing';
  saveReviewSession(session);
  const result = handleCommand('/verificar ' + product.id);
  if (result.startsWith('Erro:') || result.startsWith('Não encontrei')) return { notice: result.slice(0, 190) };
  product.state = 'verified';
  product.verifiedAt = commandVerifiedAt.toISOString();
  saveReviewSession(session);
  return { notice: 'Preço confirmado. A data no site será atualizada em até 45 segundos.', panel: renderReviewPage(session) };
}

function answerReviewCallback(id, text, token, showAlert = false) {
  try { telegramRequest('answerCallbackQuery', token, { callback_query_id: id, text: String(text || '').slice(0, 190), show_alert: showAlert }); }
  catch (_) { /* Telegram pode ter encerrado a animação; não repetir a alteração por isso. */ }
}

// Um pedido por dono. Respostas só são aceitas quando vinculadas à pergunta atual.
function productFlowKey() { return 'product_flow_v1_' + getSettings().allowedChatId; }
function clearProductFlow() { CacheService.getScriptCache().remove(productFlowKey()); }

function saveProductFlow(flow) {
  const remaining = Math.floor((flow.createdAt + REVIEW_SESSION_SECONDS * 1000 - Date.now()) / 1000);
  if (remaining < 1) throw new Error('Pedido expirado.');
  CacheService.getScriptCache().put(productFlowKey(), JSON.stringify(flow), remaining);
}

function getProductFlow() {
  const raw = CacheService.getScriptCache().get(productFlowKey());
  if (!raw) return null;
  try {
    const flow = JSON.parse(raw);
    if (flow.owner === getSettings().allowedChatId && flow.createdAt <= Date.now() &&
        Date.now() - flow.createdAt < REVIEW_SESSION_SECONDS * 1000) return flow;
  } catch (_) { /* cache inválido não autoriza nenhuma gravação */ }
  clearProductFlow();
  return null;
}

function unchangedProduct(snapshot) {
  const matches = getProducts(true).filter(product => product.id === snapshot.id);
  const current = matches[0];
  if (matches.length !== 1) return false;
  const amount = parsePrice(current.price);
  const samePrice = isValidPrice(snapshot.amount) ? amount === snapshot.amount : current.price === snapshot.priceText;
  return samePrice && current.url === snapshot.url && current.data_verificacao === snapshot.verifiedAt &&
    current.active === snapshot.active && current.image === snapshot.image;
}

function startProductFlow() {
  return productFlowPrompt({ type: 'add', state: 'input', step: 'name', draft: {},
    token: Utilities.getUuid().replace(/-/g, ''), owner: getSettings().allowedChatId, createdAt: Date.now() });
}

function startEditFlow(action, session, index) {
  return productFlowPrompt({ type: 'edit', state: 'input', step: action, product: session.items[index],
    menuToken: session.token, page: session.page,
    token: Utilities.getUuid().replace(/-/g, ''), owner: getSettings().allowedChatId, createdAt: Date.now() });
}

function productFlowPrompt(flow, error = '') {
  const prompts = {
    name: 'NOVO PRODUTO — qual é o nome? (até 160 caracteres)',
    description: 'Envie uma descrição curta, sem valores em reais. Pode incluir condições como pagamento no Pix. Para deixar sem descrição, responda /pular.',
    price: 'Qual é o preço atual que você conferiu na loja? Use vírgula. Exemplo: 65,90',
    link: 'Envie o link completo de afiliado: https://meli.la/...',
    image: 'Envie o caminho da foto já publicada (/assets/foto.png) ou uma URL HTTPS direta. Para cadastrar sem foto, responda /pular. Fotos anexadas ao Telegram não são publicadas no site.'
  };
  let question = prompts[flow.step];
  if (flow.type === 'edit') {
    const current = flow.product;
    question = flow.step === 'r' ? `MUDAR PREÇO — ${current.name}\nPreço cadastrado: ${formatPrice(current.amount) || 'inválido'}\nDigite o novo preço que você conferiu, por exemplo 56,90.` :
      flow.step === 'l' ? `MUDAR LINK — ${current.name}\nEnvie o novo link completo de afiliado https://meli.la/...\nSe o destino mudar, será preciso conferir o preço novamente.` :
      `TROCAR FOTO — ${current.name}\nEnvie /assets/foto.png ou uma URL HTTPS direta. A foto precisa estar publicada; este bot não envia anexos ao site.`;
  }
  flow.promptNonce = Utilities.getUuid().replace(/-/g, '');
  flow.promptId = null;
  saveProductFlow(flow);
  return { kind: 'inputPrompt', flowToken: flow.token, promptNonce: flow.promptNonce,
    text: (error ? error + '\n\n' : '') + question + '\n\nResponda a esta mensagem. Para interromper, envie /cancelar.' };
}

function handleMessage(message) {
  if (typeof message.text !== 'string') {
    const flow = getProductFlow();
    if (flow && flow.state === 'input' && flow.promptId &&
        message.reply_to_message && message.reply_to_message.message_id === flow.promptId) {
      return productFlowPrompt(flow, 'O bot não publica anexos. Responda com texto ou uma URL de imagem já publicada.');
    }
    return handleCommand('/ajuda imagens');
  }
  const text = message.text.trim();
  const command = /^\/[\w-]+(?:@[\w_]+)?(?=\s|$)/.exec(text);
  if (command && command[0].split('@')[0].toLowerCase() !== '/pular') return handleCommand(text);
  const flow = getProductFlow();
  if (!flow) return 'Nenhum pedido válido aguardando resposta. Envie /painel para escolher uma ação.';
  if (flow.state === 'processing') return 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.';
  if (flow.state !== 'input') return 'Use os botões Confirmar cadastro ou Cancelar no resumo do produto.';
  if (!flow.promptId || !message.reply_to_message || message.reply_to_message.message_id !== flow.promptId) {
    return 'Use Responder no pedido mais recente do bot e envie o valor. Ou envie /cancelar e abra /painel.';
  }
  const value = normalizeTelegramText(text);
  if (flow.type === 'edit') return applyEditInput(flow, value);
  const skip = value.toLowerCase() === '/pular';
  const step = flow.step;
  if (step === 'name' && (!value || value.length > 160 || skip)) return productFlowPrompt(flow, 'Informe um nome com até 160 caracteres.');
  if (step === 'description' && value.length > 1200) return productFlowPrompt(flow, 'A descrição deve ter até 1200 caracteres.');
  if (['name', 'description'].includes(step) && hasMonetaryText(value)) return productFlowPrompt(flow, monetaryTextError());
  if (step === 'price' && !isValidPrice(parsePrice(value))) return productFlowPrompt(flow, priceError());
  if (step === 'link' && (!isAffiliateUrl(value) || value.length > 200)) return productFlowPrompt(flow, 'Envie um link curto de afiliado https://meli.la/... válido.');
  if (step === 'image' && !skip && (!value || !isProductImage(value))) return productFlowPrompt(flow, 'Use uma foto já publicada em /assets/, uma URL HTTPS direta ou /pular.');
  flow.draft[step] = skip ? '' : value;
  const steps = ['name', 'description', 'price', 'link', 'image'];
  const next = steps.indexOf(step) + 1;
  if (next < steps.length) {
    flow.step = steps[next];
    return productFlowPrompt(flow);
  }
  flow.state = 'confirm';
  flow.draft.id = generateProductId(flow.draft.name);
  flow.promptNonce = Utilities.getUuid().replace(/-/g, '');
  flow.confirmationMessageIds = [];
  saveProductFlow(flow);
  return { kind: 'productDraft', flowToken: flow.token, promptNonce: flow.promptNonce,
    text: `CONFIRMAR NOVO PRODUTO\n\n${flow.draft.name}\nPreço: ${formatPrice(parsePrice(flow.draft.price))}\nLink: ${flow.draft.link}\nDescrição: ${telegramExcerpt(flow.draft.description, 350) || 'sem descrição'}\nFoto: ${telegramExcerpt(flow.draft.image, 180) || 'Foto em breve'}\nID: ${flow.draft.id}\n\nConfira os dados e as condições de pagamento. O produto só será salvo ao tocar em Confirmar cadastro.`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Confirmar cadastro', callback_data: `bf:${flow.token}:save` },
      { text: 'Cancelar', callback_data: `bf:${flow.token}:cancel` }
    ]] }
  };
}

function applyEditInput(flow, value) {
  if (flow.step === 'r' && !isValidPrice(parsePrice(value))) return productFlowPrompt(flow, priceError());
  if (flow.step === 'l' && (!isAffiliateUrl(value) || value.length > 200)) return productFlowPrompt(flow, 'Envie um link curto https://meli.la/... válido.');
  if (flow.step === 'i' && (!value || !isProductImage(value))) return productFlowPrompt(flow, 'Envie /assets/foto.png ou uma URL HTTPS direta de imagem.');
  const cache = CacheService.getScriptCache();
  const raw = cache.get(reviewSessionKey(flow.menuToken));
  if (!raw || !unchangedProduct(flow.product)) {
    clearProductFlow();
    return 'O painel expirou ou o produto mudou. Nada foi alterado. Envie /painel e escolha o produto novamente.';
  }
  const menu = JSON.parse(raw);
  if (menu.busy || flow.product.state === 'processing') return 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.';
  // As duas travas são persistidas antes de escrever; reentregas não repetem operações.
  flow.state = 'processing';
  saveProductFlow(flow);
  menu.busy = true;
  saveReviewSession(menu);
  const command = { r: '/preco', l: '/link', i: '/imagem' }[flow.step];
  if (!command) throw new Error('Pedido inválido.');
  const input = flow.step === 'r' ? parsePrice(value).toFixed(2).replace('.', ',') : value;
  const result = handleCommand(`${command} ${flow.product.id} ${input}`);
  if (result.startsWith('Erro:') || result.startsWith('Não encontrei')) return result + ' Envie /painel para recomeçar.';
  clearProductFlow();
  cache.remove(reviewSessionKey(flow.menuToken));
  const panel = createReviewPage(flow.page, undefined, flow.product.id);
  if (typeof panel === 'string') return result + '\nEnvie /painel para continuar.';
  panel.text = result + '\n\n' + panel.text;
  return panel;
}

function generateProductId(name) {
  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'produto';
  const ids = new Set(getProducts(true).map(product => product.id));
  if (!ids.has(base)) return base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = base + '-' + Utilities.getUuid().replace(/-/g, '').slice(-8);
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error('Não foi possível gerar um ID livre.');
}

function applyFlowCallback(query, settings) {
  const match = /^bf:([a-f0-9]{32}):(save|cancel)$/.exec(query.data);
  const flow = getProductFlow();
  if (!match || !flow || flow.token !== match[1] || flow.owner !== settings.allowedChatId ||
      !Array.isArray(flow.confirmationMessageIds) || !flow.confirmationMessageIds.includes(query.message.message_id)) {
    return { notice: 'Este pedido expirou ou foi substituído. Envie /painel para recomeçar.' };
  }
  if (flow.state === 'processing') return { notice: 'Resultado incerto. Confira /produtos e o Historico antes de tentar novamente.' };
  if (flow.state !== 'confirm' || flow.type !== 'add') return { notice: 'Pedido inválido. Envie /painel.' };
  if (match[2] === 'cancel') {
    clearProductFlow();
    return { notice: 'Cadastro cancelado. Nenhum produto foi criado.', panel: createReviewPage(1, query.message.message_id) };
  }
  flow.state = 'processing';
  saveProductFlow(flow);
  const draft = flow.draft;
  const result = addProductFromFields([draft.id, draft.name, draft.description, draft.price, draft.link, draft.image]);
  if (result.startsWith('Erro:')) {
    clearProductFlow();
    return { notice: result.slice(0, 190) };
  }
  clearProductFlow();
  const panel = createReviewPage(1, query.message.message_id, draft.id);
  panel.text = result + '\n\n' + panel.text;
  return { notice: 'Produto cadastrado. O site será atualizado em até 45 segundos.', panel };
}

function installWebhook() {
  const settings = getSettings();
  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(webAppUrl)) {
    throw new Error('Defina WEB_APP_URL com a URL /exec da implantação do aplicativo da Web.');
  }
  const webhookUrl = `${webAppUrl}?key=${encodeURIComponent(settings.webhookSecret)}`;
  telegramRequest('setWebhook', settings.botToken, { url: webhookUrl, max_connections: 1, allowed_updates: ['message', 'callback_query'] });
  telegramRequest('setMyCommands', settings.botToken, { commands: [
      { command: 'ajuda', description: 'Ver comandos disponíveis' },
      { command: 'painel', description: 'Gerenciar produtos usando botões' },
      { command: 'produtos', description: 'Listar produtos e preços' },
      { command: 'conferir', description: 'Conferir preços usando botões' },
      { command: 'preco', description: 'Atualizar somente o preço' },
      { command: 'verificar', description: 'Confirmar um preço que continua igual' },
      { command: 'link', description: 'Atualizar somente o link' },
      { command: 'imagem', description: 'Trocar a foto de um produto' },
      { command: 'atualizar', description: 'Atualizar preço e link' },
      { command: 'adicionar', description: 'Cadastrar produto com assistente' },
      { command: 'cancelar', description: 'Cancelar um pedido pendente' },
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
  if (command === '/cancelar') {
    clearProductFlow();
    return 'Pedido cancelado. Nada pendente será salvo. Use /painel para continuar.';
  }
  if (command === '/painel' || command === '/conferir' || (command === '/verificar' && !productId)) {
    if (args.length || (productId && !/^[1-9]\d*$/.test(productId))) return 'Erro: use /conferir ou /conferir 2.';
    clearProductFlow();
    return createReviewPage(Number(productId || 1));
  }
  if (command === '/ajuda' || command === '/start') {
    if (/^(imagens?|fotos?)$/i.test(productId || '')) {
      return 'FOTOS NO SITE\nO bot não publica anexos do Telegram. Primeiro coloque a foto na pasta assets do site (nome simples, sem espaços) e espere a publicação. Depois envie:\n/imagem jogo-panelas-ceramica-5pc /assets/jogo-panelas-pretas-v2.png\nPara produto novo, inclua o caminho da imagem no /adicionar, depois do link. Também é aceita uma URL https direta de imagem pública; link de compartilhamento do Drive não serve. Trocar foto não verifica o preço. Envie /ajuda para os demais comandos.';
    }
    return 'BOOM Promo — guia rápido\nGerenciar sem IDs: /painel — toque no nome do produto e escolha Mudar preço, Mudar link, Trocar foto, Ativar/Desativar ou Verificar. Use Anterior/Próxima para navegar. Para novo produto, toque em Adicionar produto ou envie /adicionar. Responda às perguntas e confirme o resumo. /cancelar interrompe o pedido. /conferir também abre o painel.\n1. Veja os IDs: /produtos\n2. Mude o preço: /preco frigideira-24cm-antiaderente 56,90\n3. Mude o link (exige nova conferência): /link ID https://meli.la/CODIGO\n4. Preço e link: /atualizar ID 51,00 https://meli.la/CODIGO\n5. Novo produto (troque os dados):\n/adicionar produto-exemplo | Nome | Descrição | 51,00 | https://meli.la/CODIGO\n6. Foto já publicada: /imagem ID /assets/foto.png\n7. Ocultar/mostrar: /desativar ID ou /ativar ID\n8. Preço continua igual? Após conferir na loja, envie /verificar frigideira-24cm-antiaderente\nFotos: /ajuda imagens\nUse vírgula no preço; não escreva as palavras ID ou CODIGO. Valores devem ser conferidos manualmente e aparecer apenas no campo de preço, nunca na descrição.';
  }
  if (command === '/produtos') {
    if (args.length) return 'Erro: use /produtos ou /produtos 2.';
    const products = getProducts();
    const page = /^\d+$/.test(productId || '1') ? Number(productId || 1) : 0;
    const pages = Math.max(1, Math.ceil(products.length / 30));
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return 'Erro: página inválida. Use /produtos 1.';
    return products.length ? products.slice((page - 1) * 30, page * 30).map(product => `• ${product.id} — ${product.price || 'sem preço'}`).join('\n') + `\nPágina ${page}/${pages}. Use /produtos N para outra página.` : 'Nenhum produto ativo encontrado.';
  }
  if (command === '/adicionar') return productId ? addProductFromCommand(normalizedText) : startProductFlow();
  if (!['/ativar', '/desativar', '/preco', '/verificar', '/link', '/imagem', '/atualizar'].includes(command)) {
    return 'Comando não reconhecido. Use /ajuda.';
  }
  if (!productId) return 'Informe o ID do produto. Use /produtos para ver a lista.';

  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  const row = findProductRow(sheet, headers.id, productId);
  if (!row) return `Não encontrei o produto: ${productId}`;

  if (command === '/verificar') {
    if (args.length) return 'Erro: use /verificar ID, somente depois de conferir o preço na loja.';
    const storedPrice = sheet.getRange(row, headers.preço).getValues()[0][0];
    // Mesma representação numérica lida pelo catálogo; não confirma texto malformatado.
    const price = typeof storedPrice === 'number' || typeof storedPrice === 'string' ? Number(storedPrice) : NaN;
    if (!isValidPrice(price)) return 'Erro: o produto não tem um preço válido. Confira na loja e use /preco ID VALOR.';
    // Confirma somente o preço atual: não revive um desconto ou benefício antigo.
    updateProduct(sheet, headers, row, { selo: '' }, true);
    appendHistory(productId, formatPrice(price), '', 'verificar');
    return `${productId}: preço confirmado em ${formatPrice(price)}. Data de verificação atualizada. Preço antigo e selo foram limpos, pois não foram reconfirmados.`;
  }

  if (command === '/ativar' || command === '/desativar') {
    if (args.length) return `Erro: use ${command} ID.`;
    updateProduct(sheet, headers, row, { ativo: command === '/ativar' });
    appendHistory(productId, '', '', command.slice(1));
    return `${productId}: ${command === '/ativar' ? 'ativado' : 'desativado'}.`;
  }
  if (command === '/preco') {
    if (args.length !== 1) return 'Erro: use /preco ID 51,00.';
    return updatePrice(sheet, headers, row, productId, args[0]);
  }
  if (command === '/link') {
    if (args.length !== 1) return 'Erro: use /link ID https://meli.la/CODIGO.';
    return updateLink(sheet, headers, row, productId, args[0]);
  }
  if (command === '/imagem') {
    const image = args[0];
    if (!image || args.length !== 1 || !isProductImage(image)) return 'Erro: use /imagem ID /assets/foto.png ou uma URL https direta de imagem pública.';
    updateProduct(sheet, headers, row, { imagem: image });
    appendHistory(productId, '', '', 'imagem');
    return `${productId}: imagem atualizada. O preço não foi verificado novamente.`;
  }
  if (command === '/atualizar') {
    if (args.length < 1 || args.length > 2) return 'Erro: use /atualizar ID 51,00 https://meli.la/CODIGO.';
    const [price, url] = args;
    const amount = parsePrice(price);
    if (!isValidPrice(amount)) return priceError();
    if (url && !isAffiliateUrl(url)) return 'Erro: use um link https://meli.la/... válido.';
    updateProduct(sheet, headers, row, url ? { preço: amount, 'link de afiliado': url } : { preço: amount }, true);
    appendHistory(productId, price, url || '', 'atualizar');
    return `${productId}: preço atualizado para ${formatPrice(amount)}${url ? ' e link atualizado' : ''}.`;
  }
}

function addProductFromCommand(text) {
  const payload = text.replace(/^\/adicionar(?:@[\w_]+)?\s*/i, '');
  const fields = payload.split('|').map(value => value.trim());
  return addProductFromFields(fields);
}

function addProductFromFields(fields) {
  const [id, name, description, rawPrice, url, image = '', alt = '', rawFeatures = '', badge = ''] = fields;
  if (fields.length < 5 || fields.length > 9 || !id || !name || !rawPrice || !url) {
    return 'Erro: use /adicionar ID | Nome | Descrição | 51,00 | https://meli.la/... | imagem opcional | alt opcional | características | selo opcional';
  }
  if (name.length > 160 || description.length > 1200 || alt.length > 240 || badge.length > 80 || rawFeatures.length > 400) return 'Erro: texto muito longo. Reduza os campos do produto.';
  if ([name, description, alt, rawFeatures, badge].some(hasMonetaryText)) return monetaryTextError();
  if (!isProductId(id)) return 'Erro: o ID deve usar letras minúsculas, números e hífens. Exemplo: garrafa-termica-1l.';
  const price = parsePrice(rawPrice);
  if (!isValidPrice(price)) return priceError();
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
  if (!isValidPrice(price)) return priceError();
  updateProduct(sheet, headers, row, { preço: price }, true);
  appendHistory(productId, rawPrice, '', 'preço');
  return `${productId}: preço atualizado para ${formatPrice(price)}.`;
}

function updateLink(sheet, headers, row, productId, url) {
  if (!isAffiliateUrl(url)) return 'Erro: use um link https://meli.la/... válido.';
  const changed = String(sheet.getRange(row, headers['link de afiliado']).getValues()[0][0]) !== url;
  if (changed) {
    // Invalidar ANTES de trocar o destino, inclusive se a próxima escrita falhar.
    sheet.getRange(row, headers.data_verificacao).setValue('');
    sheet.getRange(row, headers['preço antigo']).setValue('');
    sheet.getRange(row, headers.selo).setValue('');
    SpreadsheetApp.flush();
    invalidateCatalog();
  }
  updateProduct(sheet, headers, row, { 'link de afiliado': url });
  appendHistory(productId, '', url, 'link');
  return `${productId}: link atualizado.${changed ? ' Confira o preço na nova oferta e use Verificar ou Mudar preço para exibi-lo novamente no site.' : ''}`;
}

function updateProduct(sheet, headers, row, changes, priceVerified = false) {
  if (priceVerified) {
    sheet.getRange(row, headers.data_verificacao).setValue('');
    // Preço antigo e benefício não foram reconfirmados junto com o preço atual.
    sheet.getRange(row, headers['preço antigo']).setValue('');
    sheet.getRange(row, headers.selo).setValue('');
    SpreadsheetApp.flush();
    invalidateCatalog();
  }
  Object.entries(changes).forEach(([header, value]) => sheet.getRange(row, headers[header]).setValue(sheetLiteral(value)));
  if (priceVerified) {
    sheet.getRange(row, headers.data_verificacao).setValue(commandVerifiedAt || new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
  }
  invalidateCatalog();
}

function getProducts(includeInactive = false) {
  const sheet = getProductSheet();
  const headers = getHeaders(sheet);
  const rowCount = sheet.getLastRow() - HEADERS_ROW;
  if (rowCount <= 0) return [];
  const values = sheet.getRange(HEADERS_ROW + 1, 1, rowCount, sheet.getLastColumn()).getValues();
  return values.filter(row => row[headers.id - 1] && (includeInactive || isActive(row[headers.ativo - 1]))).map(row => ({
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
  if (text && (text.kind === 'inputPrompt' || text.kind === 'productDraft')) {
    const flow = getProductFlow();
    // Reentregas de uma pergunta antiga não substituem a etapa atual.
    if (!flow || flow.token !== text.flowToken || flow.promptNonce !== text.promptNonce) return;
    if (flow.state !== (text.kind === 'inputPrompt' ? 'input' : 'confirm')) return;
    const response = telegramRequest('sendMessage', botToken, {
      chat_id: chatId, text: text.text, link_preview_options: { is_disabled: true },
      reply_markup: text.kind === 'inputPrompt' ? { force_reply: true, input_field_placeholder: 'Digite sua resposta ou /cancelar' } : text.reply_markup
    });
    if (response.result && Number.isSafeInteger(response.result.message_id)) {
      if (text.kind === 'inputPrompt') flow.promptId = response.result.message_id;
      else flow.confirmationMessageIds = flow.confirmationMessageIds.concat(response.result.message_id).slice(-3);
      saveProductFlow(flow);
    }
    return;
  }
  if (text && text.kind === 'reviewPanel') {
    const session = currentReviewSession(text, chatId);
    if (!session) return;
    const response = telegramRequest('sendMessage', botToken, {
      chat_id: chatId, text: text.text, reply_markup: text.reply_markup,
      link_preview_options: { is_disabled: true }
    });
    if (response.result && Number.isSafeInteger(response.result.message_id)) {
      session.messageIds = session.messageIds.concat(response.result.message_id).slice(-3);
      saveReviewSession(session, true);
    }
    return;
  }
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
    // Uma reentrega pode repetir somente a edição visual já concluída.
    if (method === 'editMessageText' && result.error_code === 400 &&
        /message is not modified/i.test(String(result.description || ''))) return { ok: true };
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
  const safe = Object.assign({}, product, {
    name: publicProductText(product.name) || 'Produto', description: publicProductText(product.description),
    store: publicProductText(product.store) || 'Mercado Livre', alt: publicProductText(product.alt),
    badge: publicProductText(product.badge),
    features: (Array.isArray(product.features) ? product.features : []).map(publicProductText).filter(Boolean)
  });
  const age = Date.now() - Date.parse(product.data_verificacao);
  if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000 || !product.price) {
    return Object.assign(safe, { price: '', originalPrice: '', badge: '' });
  }
  return safe;
}

// Valores monetários pertencem ao campo de preço, onde há controle de validade.
// Especificações numéricas como 130.000 RPM, 24 cm e Wi-Fi 6 permanecem intactas.
function hasMonetaryText(value) {
  const normalized = String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  return /(?:R\s*\$|\bBRL\b)\s*\d|\d\s*(?:rea(?:l|is)\b|BRL\b|R\s*\$)/i.test(normalized);
}

function publicProductText(value) { return hasMonetaryText(value) ? '' : String(value || ''); }
function monetaryTextError() { return 'Erro: deixe os valores em reais apenas no campo de preço, não nos textos do produto.'; }

function parsePrice(value) {
  const input = String(value || '').trim().replace(/^R\$\s*/i, '');
  // Aceita o formato brasileiro e rejeita 51.00 para evitar gravar 5100 por engano.
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(input)) return NaN;
  return Number(input.replace(/\./g, '').replace(',', '.'));
}

function isValidPrice(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_PRICE;
}

function priceError() {
  return 'Erro: informe um preço entre R$ 0,01 e R$ 1.000.000.000,00, usando vírgula. Exemplo: 51,00.';
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
