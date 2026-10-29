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
  const cache = new Map(); const sent = []; const history = []; const receipts = [];
  let failSend = false; let failWrite = false; let flushes = 0;
  function sheet(data) { return {
    getLastRow: () => data.length, getLastColumn: () => headers.length,
    getRange(row, column, count = 1, width = 1) { return {
      getValues: () => data.slice(row - 1, row - 1 + count).map(current => current.slice(column - 1, column - 1 + width)),
      setValue(value) { if (failWrite && data === rows) throw Error('simulated'); data[row - 1][column - 1] = value; return this; },
      setValues(values) { values.forEach((v, i) => v.forEach((x, j) => { data[row - 1 + i][column - 1 + j] = x; })); return this; },
      setNumberFormat() { return this; }
    }; },
    appendRow(row) { data.push(row); }, deleteRows(start, count) { data.splice(start - 1, count); }
  }; }
  const sheets = { Produtos: sheet(rows), Historico: sheet(history), BotRecebimentos: sheet(receipts) };
  const context = {
    Date: Clock, console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value) }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets[name] }), flush: () => { flushes++; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    UrlFetchApp: { fetch: (url, options) => { if (failSend) throw Error('SECRET-URL-' + url); sent.push(JSON.parse(options.payload)); return { getContentText: () => '{"ok":true}' }; } },
    HtmlService: { createHtmlOutput: text => ({ html: text }) },
    ContentService: { createTextOutput: text => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  runInNewContext(source, context);
  const event = (text, id = 100, chatId = 123, date = Math.floor(time / 1000)) => ({ parameter: { key: 'secret' }, postData: { contents: JSON.stringify({ update_id: id, message: { text, date, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false } } }) } });
  return { context, rows, product, properties, cache, sent, history, receipts, event, advance: ms => { time += ms; }, failSend: value => { failSend = value; }, failWrite: value => { failWrite = value; }, flushes: () => flushes };
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
