import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './products.mjs';

test('a rota entrega o catálogo atualizado e não permite cache', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/[^?]+\/exec$/);
      assert.equal(options.redirect, 'follow');
      return Response.json([{ id: 'mini-soprador-130k', price: 'R$ 50,00', data_verificacao: '2026-10-22T17:59:00.000Z' }]);
    };
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), [{ id: 'mini-soprador-130k', price: 'R$ 50,00', data_verificacao: '2026-10-22T17:59:00.000Z' }]);
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
