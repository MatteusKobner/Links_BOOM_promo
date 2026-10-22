import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './products.mjs';

test('a rota entrega o catálogo atualizado e não permite cache', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/[^?]+\/exec$/);
      assert.equal(options.redirect, 'follow');
      return Response.json([{ id: 'mini-soprador-130k', price: 'R$ 50,00', data_verificacao: new Date().toISOString() }]);
    };
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json())[0].price, 'R$ 50,00');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rota oculta preços vencidos, sem data ou inválidos', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([
      { id: 'vencido', price: 'R$ 99,00', originalPrice: 'R$ 120,00', data_verificacao: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() },
      { id: 'sem-data', price: 'R$ 88,00', originalPrice: 'R$ 100,00', data_verificacao: '' },
      { id: 'invalido', price: '', originalPrice: 'R$ 96,00', data_verificacao: new Date().toISOString() }
    ]);
    const response = await GET();
    const products = await response.json();
    assert.deepEqual(products.map(({ price, originalPrice }) => [price, originalPrice]), [['', ''], ['', ''], ['', '']]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rota falha sem publicar dados antigos se a fonte estiver indisponível', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  try {
    globalThis.fetch = async () => new Response('Falha', { status: 503 });
    console.error = () => {};
    const response = await GET();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Catálogo indisponível' });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
