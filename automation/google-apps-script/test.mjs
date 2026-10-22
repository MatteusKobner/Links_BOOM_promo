import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const headers = ['id', 'nome', 'descrição', 'preço', 'preço antigo', 'loja', 'link de afiliado', 'selo', 'características', 'ativo', 'imagem', 'texto alternativo', 'data_verificacao'];
const product = ['frigideira', 'Frigideira', '', 51, '', 'Mercado Livre', 'https://meli.la/1bwg6dp', '', '', true, '', '', ''];
const rows = [headers, product];
const properties = new Map([
  ['SPREADSHEET_ID', 'sheet-id'], ['TELEGRAM_BOT_TOKEN', 'test-token'],
  ['TELEGRAM_WEBHOOK_SECRET', 'secret'], ['SETUP_CODE', 'setup-code'], ['ALLOWED_CHAT_ID', '123']
]);
const cache = new Map();
const sent = [];
const history = [];
const productSheet = {
  getLastRow: () => 5,
  getLastColumn: () => headers.length,
  getRange(row, column, count = 1, width = 1) {
    return {
      getValues: () => row === 4 ? [headers] : [product.slice(column - 1, column - 1 + width)],
      setValue(value) { product[column - 1] = value; return this; },
      setNumberFormat() { return this; }
    };
  }
};
const historySheet = {
  getLastRow: () => history.length,
  appendRow: row => history.push(row)
};
const spreadsheet = {
  getSheetByName: name => name === 'Produtos' ? productSheet : historySheet
};
const context = {
  Date, JSON, Number, String, Object, Boolean, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: key => properties.get(key) || '',
    setProperty: (key, value) => properties.set(key, value)
  }) },
  SpreadsheetApp: { openById: () => spreadsheet },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({
    get: key => cache.get(key), put: (key, value) => cache.set(key, value)
  }) },
  UrlFetchApp: { fetch: (url, options) => {
    if (url.endsWith('/sendMessage')) sent.push(JSON.parse(options.payload));
    return { getContentText: () => '{"ok":true}' };
  } },
  HtmlService: { createHtmlOutput: text => ({ html: text }) },
  ContentService: { createTextOutput: text => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
};
runInNewContext(source, context);

assert.equal(context.parsePrice('51,00'), 51);
assert.equal(context.parsePrice('1.234,56'), 1234.56);
assert.ok(Number.isNaN(context.parsePrice('51.00')));
assert.equal(context.isAffiliateUrl('https://meli.la/1bwg6dp'), true);
assert.equal(context.isAffiliateUrl('https://meli.la.evil.test/a'), false);

assert.match(context.handleCommand('/atualizar frigideira 52,00 https://meli.la.evil.test/a'), /^Erro:/);
assert.equal(product[3], 51);
assert.equal(history.length, 0);

assert.match(context.handleCommand('/link frigideira https://meli.la/AbC123'), /link atualizado/);
assert.equal(product[6], 'https://meli.la/AbC123');
assert.equal(product[12], '');

const event = { parameter: { key: 'secret' }, postData: { contents: JSON.stringify({
  update_id: 100, message: { text: '/preco frigideira 52,00', chat: { id: 123, type: 'private' } }
}) } };
assert.equal(context.doPost(event).html, 'OK');
assert.equal(context.doPost(event).html, 'OK');
assert.equal(product[3], 52);
assert.ok(product[12] instanceof Date);
assert.equal(sent.length, 1);
assert.equal(history.length, 3); // cabeçalho e dois comandos distintos

console.log('Testes do bot: preços, URL, atualização e entrega repetida aprovados.');
