// URL pública de leitura do catálogo. O segredo do webhook não é usado aqui.
const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbxglcQeBrgkXN8FEZXaKzUj1IJBGthS_Q67fJXTj6OHrafRuYbJDFQL0h5U_yWLQsI0/exec';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const upstream = await fetch(SOURCE_URL, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) throw new Error(`Resposta do catálogo: ${upstream.status}`);
    const products = await upstream.json();
    if (!Array.isArray(products)) throw new Error('Catálogo inválido');
    return Response.json(products, { headers: NO_STORE });
  } catch (error) {
    console.error('Não foi possível consultar o catálogo:', error);
    return Response.json({ error: 'Catálogo indisponível' }, { status: 503, headers: NO_STORE });
  }
}
