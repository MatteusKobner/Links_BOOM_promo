import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const headers = ['id', 'nome', 'descrição', 'preço', 'preço antigo', 'loja', 'link de afiliado', 'selo', 'características', 'ativo', 'imagem', 'texto alternativo', 'data_verificacao'];
function fixture() {
  let time = Date.now();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const product = ['frigideira', 'Frigideira', '', 51, 78.9, 'Mercado Livre', 'https://meli.la/1bwg6dp', '', '', true, '', '', ''];
  const rows = [[], [], [], headers.slice(), product];
  const properties = new Map([
    ['SPREADSHEET_ID', 'sheet-id'], ['TELEGRAM_BOT_TOKEN', 'test-token'],
    ['TELEGRAM_WEBHOOK_SECRET', 'secret'], ['SETUP_CODE', 'DO-NOT-DISCLOSE'], ['ALLOWED_CHAT_ID', '123'], ['CATALOG_READ_KEY', 'r'.repeat(40)]
  ]);
  const cache = new Map(); const sent = []; const history = []; const receipts = []; const requests = [];
  let failSend = false; let failWrite = false; let flushes = 0; let uuid = 0; let messageId = 1000; let failEdit = false;
  let productWrites = 0, failedProductWrite = Infinity;
  function sheet(data) { return {
    getLastRow: () => data.length, getLastColumn: () => headers.length,
    getRange(row, column, count = 1, width = 1) { return {
      getValues: () => data.slice(row - 1, row - 1 + count).map(current => current.slice(column - 1, column - 1 + width)),
      setValue(value) {
        if (data === rows && (failWrite || ++productWrites === failedProductWrite)) throw Error('simulated');
        data[row - 1][column - 1] = value; return this;
      },
      setValues(values) { values.forEach((v, i) => v.forEach((x, j) => { data[row - 1 + i][column - 1 + j] = x; })); return this; },
      setNumberFormat() { return this; }
    }; },
    appendRow(row) { data.push(row); }, deleteRows(start, count) { data.splice(start - 1, count); }
  }; }
  const sheets = { Produtos: sheet(rows), Historico: sheet(history), BotRecebimentos: sheet(receipts) };
  const context = {
    Date: Clock, console,
    Utilities: {
      getUuid: () => (++uuid).toString(16).padStart(32, '0'),
      formatDate: (date, timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value) }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets[name] }), flush: () => { flushes++; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    UrlFetchApp: { fetch: (url, options) => {
      const method = url.split('/').at(-1);
      if (failSend || (failEdit && method === 'editMessageText')) throw Error('SECRET-URL-' + url);
      const payload = JSON.parse(options.payload);
      sent.push(payload); requests.push({ method, payload });
      const result = method === 'sendMessage' ? { message_id: ++messageId } : true;
      return { getContentText: () => JSON.stringify({ ok: true, result }) };
    } },
    HtmlService: { createHtmlOutput: text => ({ html: text }) },
    ContentService: { createTextOutput: text => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  runInNewContext(source, context);
  const event = (text, id = 100, chatId = 123, date = Math.floor(time / 1000)) => ({ parameter: { key: 'secret' }, postData: { contents: JSON.stringify({ update_id: id, message: { text, date, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false } } }) } });
  const callback = (data, id = 101, user = 123, menuId = 1001) => ({ parameter: { key: 'secret' }, postData: { contents: JSON.stringify({ update_id: id,
    callback_query: { id: 'callback-' + id, data, from: { id: user, is_bot: false }, message: { message_id: menuId, chat: { id: 123, type: 'private' } } }
  }) } });
  return { context, rows, product, properties, cache, sent, requests, history, receipts, event, callback,
    advance: ms => { time += ms; }, setTime: value => { time = value; },
    failSend: value => { failSend = value; }, failEdit: value => { failEdit = value; }, failWrite: value => { failWrite = value; },
    failWriteAt: value => { productWrites = 0; failedProductWrite = value; }, flushes: () => flushes };
}

test('preço BR; preço verificado limpa valor antigo, link isolado não renova TTL', () => {
  const f = fixture(), c = f.context;
  assert.equal(c.parsePrice('1.234,56'), 1234.56);
  assert.ok(Number.isNaN(c.parsePrice('51.00')));
  assert.match(c.handleCommand('/atualizar frigideira 52,00 https://meli.la.evil.test/a'), /^Erro:/);
  assert.equal(f.product[3], 51);
  assert.equal(f.history.length, 0);
  c.handleCommand('/preco frigideira 52,00');
  assert.equal(f.product[3], 52); assert.equal(f.product[4], '');
  f.product[12] = '';
  c.handleCommand('/link frigideira https://meli.la/AbC123');
  assert.equal(f.product[6], 'https://meli.la/AbC123'); assert.equal(f.product[12], '');
});

test('sem ID autorizado não revela código nem vincula um estranho; entradas inválidas ignoradas', () => {
  const f = fixture(); f.properties.delete('ALLOWED_CHAT_ID');
  f.context.doPost(f.event('/start DO-NOT-DISCLOSE', 1, 999));
  assert.equal(f.sent.length, 0); assert.equal(f.properties.has('ALLOWED_CHAT_ID'), false);
  f.properties.set('ALLOWED_CHAT_ID', '123');
  f.context.doPost(f.event('/preco frigideira 99,00', 2, 999));
  f.context.doPost({ parameter: { key: 'wrong' } });
  f.context.doPost({ parameter: { key: 'secret' }, postData: { contents: '{' } });
  f.context.doPost({ parameter: { key: 'secret' }, postData: { contents: 'null' } });
  assert.equal(f.product[3], 51); assert.equal(f.receipts.length, 0);
});

test('deduplicação durável após 7h sem cache; TTL usa data do envio', () => {
  const f = fixture(); const event = f.event('/preco frigideira 52,00');
  f.advance(60 * 60 * 1000);
  assert.equal(f.context.doPost(event).html, 'OK');
  const verified = f.product[12].getTime(); const date = JSON.parse(event.postData.contents).message.date * 1000;
  assert.equal(verified, date); assert.ok(f.flushes() >= 3);
  f.advance(7 * 60 * 60 * 1000); f.cache.clear();
  f.context.doPost(event);
  assert.equal(f.product[12].getTime(), verified); assert.equal(f.history.length, 2); assert.equal(f.sent.length, 1);
});

test('mensagem antiga e data futura não gravam; IDs fora de ordem continuam válidos', () => {
  const f = fixture(); const old = f.event('/preco frigideira 52,00');
  f.advance(25 * 60 * 60 * 1000); f.context.doPost(old);
  f.context.doPost(f.event('/preco frigideira 90,00', 300, 123, Math.floor(Date.now() / 1000) + 99 * 3600));
  assert.equal(f.product[3], 51);
  f.context.doPost(f.event('/preco frigideira 60,00', 200));
  f.context.doPost(f.event('/preco frigideira 61,00', 199)); assert.equal(f.product[3], 61);
});

test('falha no envio permite reenviar resposta sem repetir escrita e sem expor token', () => {
  const f = fixture(), event = f.event('/preco frigideira 52,00'); f.failSend(true);
  assert.throws(() => f.context.doPost(event), error => !error.message.includes('test-token') && /Falha na comunicação/.test(error.message));
  assert.equal(f.history.length, 2); f.failSend(false); f.context.doPost(event);
  assert.equal(f.sent.length, 1); assert.equal(f.history.length, 2);
});

test('recibo interrompido e erro de escrita não são reexecutados silenciosamente', () => {
  const f = fixture(); f.context.openReceipt(100);
  f.context.doPost(f.event('/preco frigideira 99,00'));
  assert.equal(f.product[3], 51); assert.match(f.sent[0].text, /resultado incerto/);
  f.failWrite(true); f.context.doPost(f.event('/preco frigideira 99,00', 101)); f.failWrite(false);
  f.context.doPost(f.event('/preco frigideira 99,00', 101)); assert.equal(f.product[3], 51);
});

test('cadastro neutraliza fórmulas, preserva link e rejeita campos excedentes/ID duplicado', () => {
  const f = fixture(), c = f.context;
  const command = '/adicionar garrafa-1l | =1+1 | =IMPORTXML("url";"x") | 79,90 | https://meli.la/AbC123 | /assets/garrafa.webp | =1+1 | =1+1; inox | =1+1';
  assert.match(c.handleCommand(command), /produto adicionado/);
  const row = f.rows[5];
  for (const column of [1, 2, 7, 8, 11]) assert.ok(row[column].startsWith("'="));
  assert.equal(row[6], 'https://meli.la/AbC123'); assert.equal(row[3], 79.9);
  assert.match(c.handleCommand(command), /^Erro: já existe/);
  assert.match(c.handleCommand(command + ' | campo extra'), /^Erro:/);
  assert.match(c.handleCommand('/ajuda'), /\/adicionar produto-exemplo/);
  assert.equal(c.isProductImage('/assets/../secret'), false);
  assert.equal(c.isProductImage('https://user:pass@evil.test/a'), false);
});

test('tutorial mostra exemplos; imagem troca caminho sem renovar preço ou link', () => {
  const f = fixture(), c = f.context;
  assert.match(c.handleCommand('/ajuda'), /\/preco frigideira-24cm-antiaderente 56,90/);
  assert.match(c.handleCommand('/ajuda imagens'), /não publica anexos/);
  assert.match(c.handleCommand('/imagem frigideira \/assets\/nova-foto.png'), /imagem atualizada/);
  assert.equal(f.product[10], '/assets/nova-foto.png');
  assert.equal(f.product[12], '');
  assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
  assert.equal(f.history.at(-1)[2], 'imagem');
  assert.match(c.handleCommand('/imagem frigideira /assets/../secreto'), /^Erro:/);
  assert.match(c.handleCommand('/imagem frigideira https://user:pass@evil.test/a'), /^Erro:/);
  assert.equal(f.product[10], '/assets/nova-foto.png');
});

test('foto enviada pelo Telegram responde com tutorial sem baixar nem gravar imagem', () => {
  const f = fixture();
  const event = f.event('/ajuda');
  const update = JSON.parse(event.postData.contents);
  delete update.message.text;
  update.message.photo = [{ file_id: 'foto-teste' }];
  event.postData.contents = JSON.stringify(update);
  assert.equal(f.context.doPost(event).html, 'OK');
  assert.match(f.sent[0].text, /não publica anexos/);
  assert.equal(f.product[10], '');
});

test('comandos rejeitam argumentos extras, preço excessivo e nomes inexistentes sem gravar', () => {
  const f = fixture(), c = f.context;
  for (const command of [
    '/preco frigideira 52,00 extra',
    '/link frigideira https://meli.la/AbC123 extra',
    '/atualizar frigideira 52,00 https://meli.la/AbC123 extra',
    '/ativar frigideira extra',
    '/produtos 1 extra',
    '/preco frigideira 1.000.000.000,01'
  ]) assert.match(c.handleCommand(command), /^Erro:/);
  assert.match(c.handleCommand('/comando-inexistente frigideira'), /Comando não reconhecido/);
  assert.equal(f.product[3], 51);
  assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
  assert.equal(f.product[9], true);
  assert.equal(f.history.length, 0);
});

test('cabeçalhos ausentes falham antes de gravar; catálogo exige chave e esconde preços vencidos', () => {
  const f = fixture(), c = f.context;
  assert.deepEqual(JSON.parse(c.doGet().text), { error: 'Unauthorized' });
  const data = JSON.parse(c.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text);
  assert.equal(data[0].price, ''); assert.equal(data[0].originalPrice, '');
  f.rows[3][12] = 'coluna incorreta';
  assert.throws(() => c.handleCommand('/preco frigideira 52,00'), /Cabeçalhos/);
  assert.equal(f.product[3], 51);
});

test('recibos vencidos são eliminados e comandos antigos seguem rejeitados', () => {
  const f = fixture(); const old = f.event('/preco frigideira 52,00');
  f.context.doPost(old); f.advance(49 * 3600 * 1000);
  f.context.doPost(f.event('/preco frigideira 53,00', 101));
  assert.equal(f.receipts.length, 2); f.context.doPost(old); assert.equal(f.product[3], 53);
});

test('verificar renova a data do envio, preserva preço e afiliado e invalida cache sem repetir a operação', () => {
  const f = fixture();
  f.product[7] = 'Benefício antigo';
  f.product[10] = '/assets/frigideira.webp';
  const before = f.product.slice();
  f.cache.set('catalog_v2', 'cache antigo');
  const event = f.event('/verificar@boompromo_atualiza_bot frigideira');
  const expectedDate = JSON.parse(event.postData.contents).message.date * 1000;
  f.advance(60000);
  assert.equal(f.context.doPost(event).html, 'OK');
  assert.equal(f.product[12].getTime(), expectedDate);
  for (const index of [0, 1, 2, 3, 5, 6, 8, 9, 10, 11]) assert.equal(f.product[index], before[index]);
  assert.equal(f.product[4], '');
  assert.equal(f.product[7], '');
  assert.equal(f.cache.has('catalog_v2'), false);
  assert.equal(f.history.at(-1)[2], 'verificar');
  assert.match(f.sent[0].text, /R\$ 51,00/);
  f.advance(3600000);
  f.context.doPost(event);
  assert.equal(f.product[12].getTime(), expectedDate);
  assert.equal(f.history.length, 2);
  assert.equal(f.sent.length, 1);
});

test('verificar rejeita preço inválido ou argumentos extras sem alterar produto ou histórico', () => {
  for (const price of ['', 'inválido', '51,00', true, 0, -1, NaN, Infinity, 1000000001]) {
    const f = fixture();
    f.product[3] = price;
    assert.match(f.context.handleCommand('/verificar frigideira'), /^Erro:/);
    assert.equal(f.product[12], '');
    assert.equal(f.product[4], 78.9);
    assert.equal(f.history.length, 0);
  }
  const f = fixture();
  assert.match(f.context.handleCommand('/verificar frigideira extra'), /^Erro:/);
  assert.match(f.context.handleCommand('/verificar inexistente'), /Não encontrei/);
  assert.equal(f.context.handleCommand('/verificar').kind, 'reviewPanel');
  assert.equal(f.product[12], '');
  assert.equal(f.history.length, 0);
});

test('verificar mantém autorização e TTL de 48 horas; ajuda e menu apresentam o comando', () => {
  const f = fixture();
  f.context.doPost(f.event('/verificar frigideira', 1, 999));
  assert.equal(f.product[12], '');
  assert.equal(f.history.length, 0);
  f.context.doPost(f.event('/verificar frigideira', 2));
  const read = () => JSON.parse(f.context.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text)[0];
  assert.equal(read().price, 'R$ 51,00');
  f.advance(48 * 3600000 + 1000);
  assert.equal(read().price, '');
  assert.match(f.context.handleCommand('/ajuda'), /\/verificar frigideira-24cm-antiaderente/);
  f.properties.set('WEB_APP_URL', 'https://script.google.com/macros/s/test-deployment/exec');
  f.context.installWebhook();
  assert.ok(f.sent.at(-1).commands.some(item => item.command === 'verificar'));
});

function openPanel(f, selectProduct = true) {
  f.context.doPost(f.event('/conferir'));
  const list = f.requests.find(request => request.method === 'sendMessage').payload;
  const open = list.reply_markup.inline_keyboard.flat().find(button => button.callback_data?.includes(':o:'));
  if (selectProduct && open) {
    f.context.doPost(f.callback(open.callback_data, 50));
    return lastEdit(f);
  }
  return list;
}
function verifyData(panel) {
  return panel.reply_markup.inline_keyboard.flat().find(button => button.callback_data?.includes(':v:')).callback_data;
}
function lastEdit(f) { return f.requests.filter(request => request.method === 'editMessageText').at(-1)?.payload; }
function lastNotice(f) { return f.requests.filter(request => request.method === 'answerCallbackQuery').at(-1)?.payload.text; }

test('painel envia preço e oferta exatos, vincula a mensagem e não altera produtos ao listar', () => {
  const f = fixture();
  f.product[0] = 'a'.repeat(100);
  const panel = openPanel(f);
  assert.match(panel.text, /Preço cadastrado: R\$ 51,00/);
  assert.equal(panel.reply_markup.inline_keyboard[0][0].url, f.product[6]);
  for (const button of panel.reply_markup.inline_keyboard.flat()) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  const session = JSON.parse([...f.cache.values()][0]);
  assert.deepEqual(session.messageIds, [1001]);
  assert.equal(f.history.length, 0);
  assert.equal(f.product[12], '');
  assert.match(f.context.handleCommand('/ajuda'), /\/conferir/);
  assert.match(f.context.handleCommand('/conferir 999'), /^Erro:/);
  assert.match(f.context.handleCommand('/conferir inválido'), /^Erro:/);
});

test('botão confirma preço e atualiza painel; dois cliques ou reentregas não repetem a gravação', () => {
  const f = fixture();
  f.product[7] = 'Selo antigo';
  f.product[10] = '/assets/foto.png';
  const panel = openPanel(f), data = verifyData(panel);
  f.advance(60000);
  f.context.doPost(f.callback(data));
  const stamp = f.product[12].getTime();
  assert.equal(f.product[3], 51);
  assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
  assert.equal(f.product[10], '/assets/foto.png');
  assert.equal(f.product[4], ''); assert.equal(f.product[7], '');
  assert.equal(f.history.at(-1)[2], 'verificar');
  assert.match(lastEdit(f).text, /Verificado hoje/);
  assert.match(lastEdit(f).reply_markup.inline_keyboard[0][1].text, /Verificado/);
  f.advance(1000);
  f.context.doPost(f.callback(data));
  f.context.doPost(f.callback(data, 102));
  assert.equal(f.product[12].getTime(), stamp);
  assert.equal(f.history.length, 2);
});

test('botões antigos recusam preço, link, data ou visibilidade alterados e IDs duplicados', () => {
  for (const change of [
    f => { f.product[3] = 99; }, f => { f.product[6] = 'https://meli.la/AbC123'; },
    f => { f.product[12] = new f.context.Date(); }, f => { f.product[9] = false; },
    f => { f.rows.push(f.product.slice()); }
  ]) {
    const f = fixture(), data = verifyData(openPanel(f));
    change(f);
    const before = f.product.slice();
    f.context.doPost(f.callback(data));
    assert.deepEqual(f.product, before);
    assert.equal(f.history.length, 0);
    assert.match(lastNotice(f), /cadastro mudou/);
  }
});

test('callback exige dono, chat privado, segredo, mensagem vinculada e dados válidos', () => {
  const f = fixture(), data = verifyData(openPanel(f));
  const unauthorized = [f.callback(data, 101, 999), f.callback(data, 102)];
  unauthorized[1].parameter.key = 'wrong';
  const group = f.callback(data, 103);
  const parsed = JSON.parse(group.postData.contents); parsed.callback_query.message.chat.type = 'group';
  group.postData.contents = JSON.stringify(parsed); unauthorized.push(group);
  for (const event of unauthorized) assert.match(f.context.doPost(event).html, /^(Ignored|Unauthorized)$/);
  assert.equal(f.receipts.length, 3); // comando da lista e seleção do produto
  for (const [i, value] of [data, 'bc:' + '0'.repeat(32) + ':v:0', 'invalid-data'].entries()) {
    f.context.doPost(f.callback(value, 200 + i, 123, i === 0 ? 9999 : 1001));
  }
  assert.equal(f.history.length, 0); assert.equal(f.product[12], '');
});

test('sessão expirada ou removida do cache pede nova lista, sem renovar data', () => {
  for (const expire of [f => f.advance(3600001), f => f.cache.clear()]) {
    const f = fixture(), data = verifyData(openPanel(f)); expire(f);
    f.context.doPost(f.callback(data));
    assert.match(lastNotice(f), /expirou|não é mais válida/);
    assert.equal(f.history.length, 0); assert.equal(f.product[12], '');
  }
});

test('paginação inclui todos os ativos, preserva confirmação ao voltar e invalida botões da página anterior', () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    const row = f.product.slice(); row[0] = 'produto-' + i; row[1] = 'Produto ' + i; f.rows.push(row);
  }
  const initial = openPanel(f, false);
  assert.match(initial.text, /Página 1\/2/); assert.match(JSON.stringify(initial.reply_markup), /Produto 5/);
  f.context.doPost(f.callback(actionData(initial, 'o'), 50));
  const data = verifyData(lastEdit(f));
  f.context.doPost(f.callback(data));
  f.context.doPost(f.callback(actionData(lastEdit(f), 'b'), 102));
  const next = lastEdit(f).reply_markup.inline_keyboard.flat().find(button => button.text.includes('Próxima')).callback_data;
  f.context.doPost(f.callback(next, 103));
  const second = lastEdit(f);
  assert.match(second.text, /Página 2\/2/); assert.match(JSON.stringify(second.reply_markup), /Frigideira/);
  f.context.doPost(f.callback(data, 104));
  assert.match(lastNotice(f), /expirou/);
  const previous = second.reply_markup.inline_keyboard.flat().find(button => button.text.includes('Anterior')).callback_data;
  f.context.doPost(f.callback(previous, 105));
  assert.match(JSON.stringify(lastEdit(f).reply_markup), /✅ Produto 5/);
  assert.equal(f.history.length, 2);
});

test('falha ao editar a mensagem reenvia apenas a apresentação, sem confirmar de novo', () => {
  const f = fixture(), data = verifyData(openPanel(f)); f.failEdit(true);
  assert.throws(() => f.context.doPost(f.callback(data)), error => !error.message.includes('test-token'));
  const stamp = f.product[12].getTime();
  assert.equal(f.history.length, 2);
  f.advance(1000); f.failEdit(false); f.context.doPost(f.callback(data));
  assert.match(lastEdit(f).text, /Verificado hoje/);
  assert.equal(f.product[12].getTime(), stamp); assert.equal(f.history.length, 2);
});

test('gravação incerta bloqueia outro clique e orienta conferir histórico', () => {
  const f = fixture(), data = verifyData(openPanel(f)); f.failWrite(true);
  f.context.doPost(f.callback(data)); f.failWrite(false);
  assert.match(lastNotice(f), /gravação parcial/);
  f.context.doPost(f.callback(data, 102));
  assert.match(lastNotice(f), /Resultado incerto/);
  assert.equal(f.product[12], ''); assert.equal(f.history.length, 0);
});

test('painel aberto antes da meia-noite permite conferir de novo no dia seguinte', () => {
  const f = fixture(); f.setTime(Date.parse('2026-10-31T02:50:00Z'));
  f.product[12] = new f.context.Date(Date.parse('2026-10-31T02:45:00Z'));
  const panel = openPanel(f), data = verifyData(panel);
  assert.match(panel.text, /Verificado hoje/);
  f.advance(20 * 60000);
  f.context.doPost(f.callback(data));
  assert.equal(f.product[12].getTime(), Date.parse('2026-10-31T03:10:00Z'));
  assert.equal(f.history.at(-1)[2], 'verificar');
});

test('reenvio de edição já aplicada aceita message is not modified e encerra o recibo', () => {
  const f = fixture(), data = verifyData(openPanel(f)); f.failEdit(true);
  assert.throws(() => f.context.doPost(f.callback(data)));
  f.failEdit(false);
  const fetcher = f.context.UrlFetchApp.fetch;
  f.context.UrlFetchApp.fetch = (url, options) => {
    const response = fetcher(url, options);
    return url.endsWith('/editMessageText') ? { getContentText: () => JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }) } : response;
  };
  assert.equal(f.context.doPost(f.callback(data)).html, 'OK');
  assert.equal(f.receipts.at(-1)[2], 'sent');
  assert.equal(f.history.length, 2);
});

test('installWebhook habilita cliques e registra /conferir no menu', () => {
  const f = fixture();
  f.properties.set('WEB_APP_URL', 'https://script.google.com/macros/s/test-deployment/exec');
  f.context.installWebhook();
  assert.deepEqual(Array.from(f.requests[0].payload.allowed_updates), ['message', 'callback_query']);
  assert.ok(f.requests[1].payload.commands.some(command => command.command === 'conferir'));
});

function actionData(panel, action) {
  return panel.reply_markup.inline_keyboard.flat().find(button => button.callback_data?.includes(':' + action + ':')).callback_data;
}
function respond(f, text, id, replyId) {
  const event = f.event(text, id);
  const update = JSON.parse(event.postData.contents);
  update.message.reply_to_message = { message_id: replyId || f.context.getProductFlow()?.promptId };
  event.postData.contents = JSON.stringify(update);
  return { event, response: f.context.doPost(event) };
}
function newDraft(f, values = ['Produto novo', '/pular', '72,50', 'https://meli.la/AbC123', '/pular'], commandId = 100) {
  f.context.doPost(f.event('/adicionar', commandId));
  values.forEach((value, index) => respond(f, value, 201 + index));
  return f.requests.filter(request => request.method === 'sendMessage').at(-1).payload;
}
function lastSendId(f) { return 1000 + f.requests.filter(request => request.method === 'sendMessage').length; }

test('painel inclui ações e inativos, mas catálogo público continua ocultando inativos', () => {
  const f = fixture(); f.product[9] = false;
  const panel = openPanel(f);
  assert.match(panel.text, /Inativo/);
  for (const action of ['r', 'l', 'i', 'a', 'b']) assert.ok(actionData(panel, action));
  assert.ok(!panel.reply_markup.inline_keyboard.flat().some(button => button.callback_data?.includes(':v:')));
  const catalog = JSON.parse(f.context.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text);
  assert.equal(catalog.length, 0);
  f.context.handleCommand('/painel');
  assert.equal(f.product[9], false); assert.equal(f.history.length, 0);
});

test('botão mudar preço pede só o valor; resposta vinculada preserva afiliado e renova data uma única vez', () => {
  const f = fixture(); f.product[7] = 'Benefício antigo';
  const panel = openPanel(f);
  f.context.doPost(f.callback(actionData(panel, 'r')));
  assert.match(f.requests.at(-1).payload.text, /MUDAR PREÇO/);
  assert.equal(f.requests.at(-1).payload.reply_markup.force_reply, true);
  const input = respond(f, 'R$ 60,90', 102);
  assert.equal(f.product[3], 60.9); assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
  assert.equal(f.product[4], ''); assert.equal(f.product[7], '');
  const stamp = f.product[12].getTime();
  assert.equal(f.history.at(-1)[2], 'preço');
  assert.match(f.requests.at(-1).payload.text, /preço atualizado para R\$ 60,90/);
  f.advance(1000); f.context.doPost(input.event);
  assert.equal(f.product[12].getTime(), stamp); assert.equal(f.history.length, 2);
});

test('mudar link pelo painel invalida conferência; trocar só a foto preserva a data', () => {
  for (const [action, value, column, history] of [
    ['l', 'https://meli.la/NovoABC', 6, 'link'], ['i', '/assets/nova-foto.png', 10, 'imagem']
  ]) {
    const f = fixture(); f.product[12] = new f.context.Date(Date.now() - 3600000);
    const stamp = f.product[12].getTime(), panel = openPanel(f);
    f.context.doPost(f.callback(actionData(panel, action)));
    respond(f, value, 102);
    assert.equal(f.product[column], value); assert.equal(f.product[3], 51);
    assert.equal(action === 'l' ? f.product[12] : f.product[12].getTime(), action === 'l' ? '' : stamp);
    assert.equal(f.history.at(-1)[2], history);
  }
});

test('ativar e desativar pelo painel não renova preço; cliques duplicados não invertem visibilidade', () => {
  const f = fixture(), panel = openPanel(f), deactivate = actionData(panel, 'd');
  f.context.doPost(f.callback(deactivate));
  assert.equal(f.product[9], false); assert.equal(f.product[12], '');
  assert.match(lastEdit(f).text, /Inativo/);
  f.context.doPost(f.callback(deactivate, 102));
  assert.equal(f.product[9], false); assert.equal(f.history.length, 2);
  f.context.doPost(f.callback(actionData(lastEdit(f), 'a'), 103));
  assert.equal(f.product[9], true); assert.equal(f.product[12], '');
  assert.equal(f.history.at(-1)[2], 'ativar');
});

test('entrada inválida, resposta sem vínculo, outro remetente e foto anexa não alteram o preço', () => {
  const f = fixture(), panel = openPanel(f);
  f.context.doPost(f.callback(actionData(panel, 'r')));
  f.context.doPost(f.event('80,00', 102));
  assert.equal(f.product[3], 51);
  respond(f, '51.00', 103);
  assert.match(f.requests.at(-1).payload.text, /usando vírgula/);
  const unauthorized = f.event('80,00', 104, 999);
  assert.equal(f.context.doPost(unauthorized).html, 'Ignored');
  const photo = f.event('', 105), parsed = JSON.parse(photo.postData.contents);
  delete parsed.message.text; parsed.message.photo = [{ file_id: 'foto' }];
  parsed.message.reply_to_message = { message_id: f.context.getProductFlow().promptId };
  photo.postData.contents = JSON.stringify(parsed); f.context.doPost(photo);
  assert.match(f.requests.at(-1).payload.text, /não publica anexos/);
  assert.equal(f.product[3], 51); assert.equal(f.product[12], ''); assert.equal(f.history.length, 0);
});

test('resposta ao preço antigo não sobrescreve edição posterior; cancelar e expirar não gravam', () => {
  for (const alter of [
    f => { f.product[3] = 99; }, f => { f.context.handleCommand('/cancelar'); }, f => f.advance(3600001)
  ]) {
    const f = fixture(), panel = openPanel(f);
    f.context.doPost(f.callback(actionData(panel, 'r')));
    const promptId = f.context.getProductFlow().promptId;
    alter(f); const before = f.product.slice();
    respond(f, '80,00', 102, promptId);
    assert.deepEqual(f.product, before); assert.equal(f.history.length, 0);
  }
});

test('iniciar outra ação invalida a pergunta anterior; /painel interrompe pedido pendente', () => {
  const f = fixture(), panel = openPanel(f);
  f.context.doPost(f.callback(actionData(panel, 'r')));
  const old = f.context.getProductFlow().promptId;
  f.context.doPost(f.callback(actionData(panel, 'l'), 102));
  respond(f, '80,00', 103, old);
  assert.equal(f.product[3], 51); assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
  f.context.handleCommand('/painel');
  assert.equal(f.context.getProductFlow(), null);
  assert.equal(f.history.length, 0);
});

test('cadastro guiado só salva após confirmar; gera ID, preserva link e deduplica o clique', () => {
  const f = fixture(), summary = newDraft(f);
  assert.match(summary.text, /CONFIRMAR NOVO PRODUTO/);
  assert.equal(f.rows.length, 5); assert.equal(f.history.length, 0);
  const data = summary.reply_markup.inline_keyboard[0][0].callback_data, menuId = lastSendId(f);
  f.advance(60000);
  f.context.doPost(f.callback(data, 300, 123, menuId));
  assert.equal(f.rows.length, 6);
  const row = f.rows[5];
  assert.equal(row[0], 'produto-novo'); assert.equal(row[1], 'Produto novo');
  assert.equal(row[2], ''); assert.equal(row[3], 72.5);
  assert.equal(row[6], 'https://meli.la/AbC123'); assert.equal(row[9], true); assert.equal(row[10], '');
  assert.equal(row[12].getTime(), f.context.Date.now());
  assert.equal(f.history.at(-1)[2], 'adicionar');
  assert.match(lastEdit(f).text, /Produto novo/);
  f.context.doPost(f.callback(data, 300, 123, menuId));
  f.context.doPost(f.callback(data, 301, 123, menuId));
  assert.equal(f.rows.length, 6); assert.equal(f.history.length, 2);
});

test('novo produto pelo botão funciona mesmo com catálogo vazio; resumo cancelado não cadastra', () => {
  const f = fixture(); f.rows.splice(4);
  const panel = openPanel(f);
  assert.match(panel.text, /Nenhum produto cadastrado/);
  f.context.doPost(f.callback(actionData(panel, 'n')));
  assert.equal(f.context.getProductFlow().type, 'add');
  f.context.handleCommand('/cancelar');
  const summary = newDraft(f, undefined, 150), menuId = lastSendId(f);
  f.context.doPost(f.callback(summary.reply_markup.inline_keyboard[0][1].callback_data, 300, 123, menuId));
  assert.equal(f.rows.length, 4); assert.equal(f.history.length, 0);
  assert.match(lastNotice(f), /cancelado/);
});

test('wizard neutraliza fórmulas e mantém separadores no texto sem interpretar novos campos', () => {
  const f = fixture(), summary = newDraft(f, ['=1+1 | Nome', '=IMPORTXML("url";"x") | descrição', '65,90', 'https://meli.la/AbC123', '/assets/foto.png']);
  f.context.doPost(f.callback(summary.reply_markup.inline_keyboard[0][0].callback_data, 300, 123, lastSendId(f)));
  const row = f.rows[5];
  assert.ok(row[1].startsWith("'=1+1")); assert.ok(row[2].startsWith("'=IMPORTXML"));
  assert.equal(row[6], 'https://meli.la/AbC123'); assert.equal(row[10], '/assets/foto.png');
});

test('cadastro evita ID existente e não aceita confirmação por outra mensagem ou usuário', () => {
  const f = fixture(), summary = newDraft(f, ['Frigideira', '/pular', '65,90', 'https://meli.la/AbC123', '/pular']);
  assert.match(f.context.getProductFlow().draft.id, /^frigideira-[a-f0-9]{8}$/);
  const data = summary.reply_markup.inline_keyboard[0][0].callback_data;
  f.context.doPost(f.callback(data, 300, 123, 9999));
  f.context.doPost(f.callback(data, 301, 999, lastSendId(f)));
  assert.equal(f.rows.length, 5); assert.equal(f.history.length, 0);
});

test('falha de gravação no assistente não permite que outra resposta ou clique repita a operação', () => {
  const f = fixture(), panel = openPanel(f);
  f.context.doPost(f.callback(actionData(panel, 'r')));
  const promptId = f.context.getProductFlow().promptId;
  f.failWrite(true); respond(f, '80,00', 102, promptId); f.failWrite(false);
  assert.equal(f.context.getProductFlow().state, 'processing');
  respond(f, '80,00', 103, promptId);
  assert.equal(f.product[3], 51); assert.equal(f.history.length, 0);
  assert.match(f.requests.at(-1).payload.text, /Resultado incerto/);
});

test('assistente rejeita URL maliciosa sem gravar e mantém a etapa atual', () => {
  const f = fixture(); f.context.doPost(f.event('/adicionar'));
  respond(f, 'Nome', 201); respond(f, '/pular', 202); respond(f, '65,90', 203);
  respond(f, 'https://meli.la.evil.test/a', 204);
  assert.equal(f.context.getProductFlow().step, 'link');
  respond(f, 'https://meli.la/AbC123', 205);
  respond(f, 'https://user:pass@evil.test/a.png', 206);
  assert.equal(f.context.getProductFlow().step, 'image');
  assert.equal(f.rows.length, 5); assert.equal(f.history.length, 0);
  respond(f, '/pular', 207);
  assert.match(f.requests.at(-1).payload.text, /CONFIRMAR NOVO PRODUTO/);
});

test('pergunta repetida não avança cadastro; confirmação expirada não escreve', () => {
  const f = fixture(); f.context.doPost(f.event('/adicionar'));
  const first = respond(f, 'Nome', 201);
  f.context.doPost(first.event);
  assert.equal(f.context.getProductFlow().step, 'description');
  respond(f, '/pular', 202); respond(f, '65,90', 203);
  respond(f, 'https://meli.la/AbC123', 204); respond(f, '/pular', 205);
  const summary = f.requests.at(-1).payload, messageId = lastSendId(f);
  f.advance(3600001);
  f.context.doPost(f.callback(summary.reply_markup.inline_keyboard[0][0].callback_data, 300, 123, messageId));
  assert.equal(f.rows.length, 5); assert.equal(f.history.length, 0);
  assert.match(lastNotice(f), /expirou/);
});

test('falha ao enviar o painel depois de mudar preço reenvia resposta sem repetir a escrita', () => {
  const f = fixture(), panel = openPanel(f);
  f.context.doPost(f.callback(actionData(panel, 'r')));
  const input = f.event('80,00', 102), parsed = JSON.parse(input.postData.contents);
  parsed.message.reply_to_message = { message_id: f.context.getProductFlow().promptId };
  input.postData.contents = JSON.stringify(parsed);
  f.failSend(true);
  assert.throws(() => f.context.doPost(input), error => !error.message.includes('test-token'));
  const stamp = f.product[12].getTime();
  assert.equal(f.product[3], 80); assert.equal(f.history.length, 2);
  f.failSend(false); f.advance(1000); f.context.doPost(input);
  assert.equal(f.product[12].getTime(), stamp); assert.equal(f.history.length, 2);
  assert.match(f.requests.at(-1).payload.text, /preço atualizado/);
});

test('lista inicial exibe só produtos, navegação e adicionar, sem todas as funções expandidas', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    const row = f.product.slice(); row[0] = 'outro-' + i; row[1] = 'Outro ' + i; f.rows.push(row);
  }
  const list = openPanel(f, false), buttons = list.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.filter(button => button.callback_data.includes(':o:')).length, 5);
  for (const button of buttons) assert.match(button.callback_data, /^bc:[a-f0-9]{32}:[opn]:\d+$/);
  assert.ok(buttons[0].text.includes('Outro 4'));
  assert.ok(buttons[0].text.includes('R$ 51,00'));
  assert.equal(f.history.length, 0);
});

test('clicar no produto abre apenas suas funções; editar mantém selecionado e voltar retorna à lista', () => {
  const f = fixture(), other = f.product.slice();
  other[0] = 'outro'; other[1] = 'Outro produto'; other[3] = 25; other[6] = 'https://meli.la/Outro'; f.rows.push(other);
  const list = openPanel(f, false);
  const select = list.reply_markup.inline_keyboard.flat().filter(button => button.callback_data.includes(':o:'))[1];
  f.context.doPost(f.callback(select.callback_data, 50));
  const detail = lastEdit(f);
  assert.match(detail.text, /ID: frigideira/);
  assert.ok(!detail.text.includes('Outro produto'));
  for (const action of ['r', 'l', 'i', 'd', 'v', 'b']) assert.ok(actionData(detail, action));
  f.context.doPost(f.callback(actionData(detail, 'r')));
  respond(f, '59,90', 102);
  const updated = f.requests.at(-1).payload;
  assert.match(updated.text, /ID: frigideira/);
  assert.equal(f.product[3], 59.9); assert.equal(other[3], 25);
  f.context.doPost(f.callback(actionData(updated, 'b'), 103, 123, lastSendId(f)));
  assert.ok(actionData(lastEdit(f), 'o'));
  assert.ok(!lastEdit(f).reply_markup.inline_keyboard.flat().some(button => /:[rliadv]:/.test(button.callback_data)));
});

test('ação antiga ou adulterada de outro produto não começa edição nem altera dados', () => {
  const f = fixture(), other = f.product.slice();
  other[0] = 'outro'; other[1] = 'Outro'; f.rows.push(other);
  const selected = openPanel(f), action = actionData(selected, 'r').replace(/:r:0$/, ':r:1');
  f.context.doPost(f.callback(action));
  assert.match(lastNotice(f), /Abra o produto/);
  assert.equal(f.context.getProductFlow(), null);
  assert.equal(f.product[3], 51); assert.equal(other[3], 51); assert.equal(f.history.length, 0);
});

test('voltar à lista cancela pergunta pendente sem mudar produto', () => {
  const f = fixture(), detail = openPanel(f);
  f.context.doPost(f.callback(actionData(detail, 'r')));
  const oldPrompt = f.context.getProductFlow().promptId;
  f.context.doPost(f.callback(actionData(detail, 'b'), 102));
  assert.equal(f.context.getProductFlow(), null);
  respond(f, '99,00', 103, oldPrompt);
  assert.equal(f.product[3], 51); assert.equal(f.history.length, 0);
});

test('novo link invalida preço e benefícios; repetir o mesmo link não apaga uma conferência válida', () => {
  const f = fixture(), c = f.context;
  f.product[12] = new c.Date(c.Date.now()); f.product[7] = 'Benefício antigo';
  const stamp = f.product[12].getTime();
  c.handleCommand('/link frigideira ' + f.product[6]);
  assert.equal(f.product[12].getTime(), stamp); assert.equal(f.product[4], 78.9);
  assert.match(c.handleCommand('/link frigideira https://meli.la/NovoLink'), /Confira o preço/);
  assert.equal(f.product[6], 'https://meli.la/NovoLink'); assert.equal(f.product[3], 51);
  assert.equal(f.product[12], ''); assert.equal(f.product[4], ''); assert.equal(f.product[7], '');
  const read = () => JSON.parse(c.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text)[0];
  assert.equal(read().price, ''); assert.equal(read().url, 'https://meli.la/NovoLink');
  c.handleCommand('/verificar frigideira');
  assert.equal(read().price, 'R$ 51,00');
  c.handleCommand('/atualizar frigideira 60,00 https://meli.la/OutroLink');
  assert.equal(read().price, 'R$ 60,00'); assert.equal(read().url, 'https://meli.la/OutroLink');
});

test('falha parcial ao trocar link ou preço com link deixa a verificação inválida', () => {
  for (const [command, failedWrite] of [
    ['/link frigideira https://meli.la/NovoLink', 4],
    ['/atualizar frigideira 60,00 https://meli.la/NovoLink', 5]
  ]) {
    const f = fixture(); f.product[12] = new f.context.Date(f.context.Date.now());
    f.context.doGet({ parameter: { catalog_key: 'r'.repeat(40) } });
    f.failWriteAt(failedWrite); f.context.doPost(f.event(command));
    assert.equal(f.product[12], ''); assert.equal(f.product[6], 'https://meli.la/1bwg6dp');
    const publicProduct = JSON.parse(f.context.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text)[0];
    assert.equal(publicProduct.price, ''); assert.equal(publicProduct.originalPrice, '');
    assert.match(f.sent.at(-1).text, /gravação parcial/);
  }
});

test('fonte pública remove valores monetários dos textos sem remover especificações ou editar a planilha', () => {
  const f = fixture(), c = f.context;
  f.product[1] = 'Produto por R$ 51,00'; f.product[2] = 'Oferta por 51 reais';
  f.product[5] = 'Loja BRL 51'; f.product[7] = 'Economize 1 real';
  f.product[8] = 'Frete R$ 9,90 | 130.000 RPM | 24 cm'; f.product[11] = 'Apenas 51 BRL';
  for (const date of [new c.Date(c.Date.now()), new c.Date(c.Date.now() - 49 * 3600000)]) {
    f.product[12] = date; c.invalidateCatalog();
    const product = JSON.parse(c.doGet({ parameter: { catalog_key: 'r'.repeat(40) } }).text)[0];
    assert.equal(product.name, 'Produto'); assert.equal(product.description, '');
    assert.equal(product.store, 'Mercado Livre'); assert.equal(product.badge, ''); assert.equal(product.alt, '');
    assert.deepEqual(product.features, ['130.000 RPM', '24 cm']);
    assert.equal(product.url, f.product[6]);
  }
  assert.equal(f.product[2], 'Oferta por 51 reais'); assert.equal(f.product[3], 51);
});

test('cadastro por comando e perguntas rejeita preço nos textos e aceita especificações técnicas', () => {
  const f = fixture(), c = f.context;
  for (const index of [1, 2, 6, 7, 8]) {
    const fields = ['novo', 'Soprador 130.000 RPM', 'Com 3 níveis', '51,00', 'https://meli.la/Novo', '', '', '', ''];
    fields[index] = 'Oferta por R$ 51,00';
    assert.match(c.addProductFromFields(fields), /apenas no campo de preço/);
  }
  assert.equal(f.rows.length, 5);
  c.doPost(f.event('/adicionar'));
  respond(f, 'Produto por R$ 51,00', 201);
  assert.equal(c.getProductFlow().step, 'name');
  respond(f, 'Soprador 130.000 RPM', 202);
  assert.equal(c.getProductFlow().step, 'description');
  respond(f, 'Apenas 51 reais', 203);
  assert.equal(c.getProductFlow().step, 'description');
  respond(f, 'Com 3 níveis, pagamento no Pix', 204);
  assert.equal(c.getProductFlow().step, 'price'); assert.equal(f.rows.length, 5);
});

test('reentrega de edição visual antiga não volta ao produto anterior nem repete escrita', () => {
  const f = fixture(), other = f.product.slice();
  other[0] = 'outro'; other[1] = 'Outro produto'; f.rows.push(other);
  const list = openPanel(f, false), select = list.reply_markup.inline_keyboard.flat().filter(b => b.callback_data.includes(':o:'));
  const failed = f.callback(select[1].callback_data, 101);
  f.failEdit(true); assert.throws(() => f.context.doPost(failed)); f.failEdit(false);
  f.context.doPost(f.callback(select[0].callback_data, 102));
  const currentPanel = lastEdit(f); assert.match(currentPanel.text, /ID: outro/);
  const count = f.requests.filter(r => r.method === 'editMessageText').length;
  f.context.doPost(failed);
  assert.equal(f.requests.filter(r => r.method === 'editMessageText').length, count);
  assert.equal(lastEdit(f), currentPanel);
  f.context.doPost(f.callback(actionData(currentPanel, 'r'), 103));
  assert.equal(f.context.getProductFlow().product.id, 'outro'); assert.equal(f.history.length, 0);
});

test('recibo de painel antigo não reenvia menu superado, expirado ou sem revisão', () => {
  const f = fixture();
  const stale = f.context.handleCommand('/painel');
  f.context.sendTelegramMessage(123, stale, 'test-token');
  f.context.doPost(f.callback(actionData(stale, 'o'), 101));
  const count = f.requests.filter(r => r.method === 'sendMessage').length;
  f.context.sendTelegramMessage(123, stale, 'test-token');
  const legacy = { ...stale }; delete legacy.viewRevision;
  f.context.sendTelegramMessage(123, legacy, 'test-token');
  f.advance(3600001);
  f.context.sendTelegramMessage(123, stale, 'test-token');
  assert.equal(f.requests.filter(r => r.method === 'sendMessage').length, count);
});
