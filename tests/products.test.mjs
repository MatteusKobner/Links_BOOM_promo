import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogHandler } from '../lib/catalog.mjs';
const KEY = 'private-test-key-'.repeat(3);
const time = Date.parse('2026-10-22T18:00:00Z');
const product = { id: 'frigideira', name: 'Frigideira', active: true, badge: 'Brinde conferido', price: 'R$ 56,90', originalPrice: 'R$ 78,90', url: 'https://meli.la/1bwg6dp', image: '/assets/frigideira.webp', data_verificacao: new Date(time).toISOString() };
const request = path => new Request('https://boompromo.vercel.app' + path);
function handler(products = [product], extra = {}) { return createCatalogHandler({ fetcher: async () => Response.json(products), now: () => time, readKey: () => KEY, ...extra }); }

test('catálogo validado preserva link exato e nunca expõe campos privados', async () => {
  const get = handler([{ ...product, internal_secret: 'secret', extra: { password: 'never' } }]);
  const response = await get(); const data = await response.json();
  assert.equal(data[0].price, 'R$ 56,90'); assert.equal(data[0].url, product.url);
  assert.equal(data[0].badge, product.badge);
  assert.equal(data[0].internal_secret, undefined); assert.equal(data[0].extra, undefined);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'public, s-maxage=15, must-revalidate');
});

test('chave só vai à fonte fixa; usuário não escolhe URL nem força variantes de consulta', async () => {
  let calls = 0;
  const get = handler(undefined, { fetcher: async (url, options) => {
    calls++; const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://script.google.com'); assert.equal(parsed.searchParams.get('catalog_key'), KEY);
    assert.equal(options.redirect, 'follow'); assert.equal(options.cache, 'no-store'); return Response.json([product]);
  } });
  assert.equal((await get(request('/api/products?source=https://evil.test'))).status, 400);
  assert.equal((await get(new Request('https://boompromo.vercel.app/api/products', { method: 'POST' }))).status, 405);
  assert.equal(calls, 0); await get(request('/api/products')); assert.equal(calls, 1);
});

test('consultas simultâneas/seguidas usam uma consulta upstream e renovam depois de 15s', async () => {
  let calls = 0, current = time;
  const get = handler(undefined, { now: () => current, fetcher: async () => { calls++; return Response.json([product]); } });
  await Promise.all(Array.from({ length: 20 }, () => get())); assert.equal(calls, 1);
  await get(); assert.equal(calls, 1); current += 16000; await get(); assert.equal(calls, 2);
});

test('TTL no limite restringe CDN e reavalia preço mesmo no cache em memória', async () => {
  let current = time;
  const get = handler([{ ...product, data_verificacao: new Date(time - 48 * 3600 * 1000 + 2000).toISOString() }], { now: () => current });
  const fresh = await get(); assert.equal(fresh.headers.get('Vercel-CDN-Cache-Control'), 'public, s-maxage=2, must-revalidate');
  assert.equal((await fresh.json())[0].price, product.price);
  current += 3000; const data = await (await get()).json(); assert.equal(data[0].price, ''); assert.equal(data[0].originalPrice, '');
  assert.equal(data[0].badge, '');
});

test('preço inválido, vencido, sem data e futuro são ocultados; produtos desativados não vazam', async () => {
  const get = handler([
    { ...product, data_verificacao: new Date(time - 49 * 3600 * 1000).toISOString() },
    { ...product, data_verificacao: '' }, { ...product, price: 'R$ ...' },
    { ...product, data_verificacao: new Date(time + 60000).toISOString() },
    { ...product, active: false }, { ...product, active: 'false' }, null
  ]);
  const data = await (await get()).json(); assert.equal(data.length, 4);
  for (const p of data) { assert.equal(p.price, ''); assert.equal(p.originalPrice, ''); assert.equal(p.badge, ''); }
});

test('links maliciosos e imagens com credenciais/caminhos indevidos são bloqueados', async () => {
  for (const url of ['javascript:alert(1)', 'https://meli.la.evil.test/ABC', 'https://meli.la@evil.test/ABC', 'https://meli.la/ABC" onclick="x']) {
    const data = await (await handler([{ ...product, url, image: 'https://user:password@evil.test/x' }])()).json();
    assert.equal(data[0].url, ''); assert.equal(data[0].image, '');
  }
  const data = await (await handler([{ ...product, image: '/assets/../Code.gs' }])()).json(); assert.equal(data[0].image, '');
});

test('falha upstream não reutiliza cache vencido; cooldown reduz novas tentativas', async () => {
  let current = time, calls = 0;
  const get = handler(undefined, { now: () => current, fetcher: async () => { calls++; if (calls > 1) throw Error('https://secret/' + KEY); return Response.json([product]); } });
  assert.equal((await get()).status, 200); current += 16000;
  const failed = await get(); assert.equal(failed.status, 503); assert.equal(failed.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.deepEqual(await failed.json(), { error: 'Catálogo indisponível' });
  await get(); assert.equal(calls, 2); current += 11000; await get(); assert.equal(calls, 3);
});

test('sem chave, corpo gigante, HTML ou JSON inválido falham sem divulgar detalhes', async () => {
  let calls = 0;
  const noKey = handler(undefined, { readKey: () => '', fetcher: async () => { calls++; } });
  assert.equal((await noKey()).status, 503); assert.equal(calls, 0);
  const badResponses = [() => new Response('HTML'), () => Response.json({ error: 'Unauthorized' }), () => Response.json(Array(1001).fill(product)), () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })];
  for (const fetcher of badResponses) assert.equal((await handler(undefined, { fetcher })()).status, 503);
});

test('valores em textos não burlam TTL, preservando medidas, características e afiliado', async () => {
  for (const amount of ['R$ 51,00', 'R$\u00a051', '51 reais', '1 real', '51,90 reais', 'BRL 51', '51 BRL', '51 R$', 'Ｒ＄ ５１,００', 'R\u200b$ 51,00']) {
    for (const age of [0, 49 * 3600000]) {
      const [p] = await (await handler([{ ...product, name: 'Produto por ' + amount,
        description: 'Oferta por ' + amount, alt: 'Custa ' + amount, store: 'Loja ' + amount,
        badge: 'Economize ' + amount, features: [amount, '130.000 RPM', '24 cm', 'Wi-Fi 6'],
        data_verificacao: new Date(time - age).toISOString() }])()).json();
      assert.equal(p.name, 'Produto'); assert.equal(p.description, ''); assert.equal(p.alt, '');
      assert.equal(p.store, ''); assert.equal(p.badge, '');
      assert.deepEqual(p.features, ['130.000 RPM', '24 cm', 'Wi-Fi 6']);
      assert.equal(p.price, age ? '' : product.price); assert.equal(p.url, product.url);
    }
  }
});
