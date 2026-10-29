import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const code = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/renderSocials\(\);\s*loadProducts\(\);\s*$/, '');
const context = { URL, window: { location: { origin: 'https://boompromo.vercel.app' } } };
runInNewContext(code, context);
test('textos e atributos dos cards escapam HTML; CTA mantém somente afiliado exato', () => {
  const attack = '<img src=x onerror="alert(1)">';
  assert.equal(context.escapeHtml(attack), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(context.safeAffiliateUrl('https://meli.la/AbC123'), 'https://meli.la/AbC123');
  for (const url of ['javascript:alert(1)', 'https://meli.la@evil.test/a', 'https://meli.la.evil.test/a']) assert.equal(context.safeAffiliateUrl(url), '');
  assert.equal(context.safeUrl('/assets/../secret', true), '');
});
test('política CSP não permite scripts inline/eval e analytics só inicia após consentimento', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  const csp = config.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.ok(csp.includes("frame-ancestors 'none'")); assert.ok(!csp.includes('unsafe-inline')); assert.ok(!csp.includes('unsafe-eval'));
  const analytics = readFileSync(new URL('../analytics.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('/_vercel/insights/script.js'));
  for (const choice of ['denied', 'granted']) {
    const scripts = [];
    runInNewContext(analytics, { window: {}, localStorage: { getItem: () => choice }, document: { createElement: () => ({}), head: { append: s => scripts.push(s.src) }, addEventListener() {} } });
    assert.equal(scripts.length, choice === 'granted' ? 2 : 0);
  }
});

test('card retira selo e preços ao vencer a verificação, mantendo o afiliado', async () => {
  const verifiedAt = Date.parse('2026-10-29T12:00:00Z');
  let current = verifiedAt + 48 * 3600 * 1000 - 1000;
  let expire;
  const container = { innerHTML: '', querySelectorAll: () => [], setAttribute() {} };
  const search = { value: '', addEventListener() {} };
  const counter = {};
  const document = {
    querySelector: selector => ({ '#products': container, '#product-search': search, '#product-count': counter })[selector],
    addEventListener() {}
  };
  const sandbox = {
    URL, Intl, document, console,
    Date: class extends Date { static now() { return current; } },
    window: { location: { origin: 'https://boompromo.com.br' } },
    setTimeout: callback => { expire = callback; return 1; }, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => [{
      id: 'produto', name: 'Produto', price: 'R$ 51,00', originalPrice: 'R$ 60,00',
      badge: 'Brinde conferido', url: 'https://meli.la/AbC123',
      data_verificacao: new Date(verifiedAt).toISOString()
    }] })
  };
  runInNewContext(code, sandbox);
  await sandbox.loadProducts();
  assert.match(container.innerHTML, /class="badge"/);
  assert.match(container.innerHTML, /R\$ 51,00/);
  current += 2000;
  expire();
  assert.doesNotMatch(container.innerHTML, /class="badge"|R\$ 51,00|R\$ 60,00/);
  assert.match(container.innerHTML, /O preço pode ter mudado/);
  assert.match(container.innerHTML, /href="https:\/\/meli.la\/AbC123"/);
});
