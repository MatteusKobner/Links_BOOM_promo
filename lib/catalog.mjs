const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbxglcQeBrgkXN8FEZXaKzUj1IJBGthS_Q67fJXTj6OHrafRuYbJDFQL0h5U_yWLQsI0/exec';
const PRICE_TTL_MS = 48 * 60 * 60 * 1000;
const CACHE_MS = 15000;
const MAX_BYTES = 1024 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' };
const currency = value => typeof value === 'string' && /^R\$ (?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/.test(value) && Number(value.slice(3).replaceAll('.', '').replace(',', '.')) > 0;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
// Não publicar preços embutidos em textos: eles não acompanham o TTL do preço.
function publicText(value, max) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  return /(?:R\s*\$|\bBRL\b)\s*\d|\d\s*(?:rea(?:l|is)\b|BRL\b|R\s*\$)/i.test(normalized) ? '' : text(value, max);
}

export function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  if (/^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    return value.startsWith('https://') && url.protocol === 'https:' && !url.username && !url.password &&
      !/[\s\\]/.test(value) ? value : '';
  } catch { return ''; }
}

function sanitizeProduct(product, now) {
  if (!product || typeof product !== 'object' || Array.isArray(product) ||
      typeof product.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product.id) || product.id.length > 100 ||
      typeof product.name !== 'string' || !product.name.trim() || product.active !== true) return null;
  const verifiedAt = Date.parse(product.data_verificacao);
  const fresh = Number.isFinite(verifiedAt) && now >= verifiedAt && now - verifiedAt <= PRICE_TTL_MS && currency(product.price);
  // Lista explícita: campos privados/acidentais da fonte nunca chegam ao navegador.
  return {
    id: product.id, name: publicText(product.name, 160) || 'Produto', description: publicText(product.description, 1200),
    price: fresh ? product.price : '', originalPrice: fresh && currency(product.originalPrice) ? product.originalPrice : '',
    store: publicText(product.store, 100), url: /^https:\/\/meli\.la\/[A-Za-z0-9]+$/.test(product.url || '') ? product.url : '',
    // Selos também podem prometer benefícios que deixam de valer com a oferta.
    badge: fresh ? publicText(product.badge, 80) : '', features: Array.isArray(product.features) ? product.features.slice(0, 4).map(v => publicText(v, 100)).filter(Boolean) : [],
    active: true, image: imageUrl(product.image), alt: publicText(product.alt, 240),
    data_verificacao: Number.isFinite(verifiedAt) ? new Date(verifiedAt).toISOString() : '',
    logoEmbedded: product.logoEmbedded === true
  };
}

async function readBoundedJson(response) {
  if (!response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Invalid response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const decoder = new TextDecoder();
  let size = 0;
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Oversized response'); }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content);
  } finally { reader.releaseLock(); }
}

export function createCatalogHandler({ fetcher = (...args) => fetch(...args), now = Date.now, readKey = () => process.env.CATALOG_READ_KEY } = {}) {
  let cached;
  let expiresAt = 0;
  let pending;
  let retryAfter = 0;
  return async function GET(request) {
    if (request && request.method !== 'GET') return Response.json({ error: 'Método não permitido' }, { status: 405, headers: { ...NO_STORE, Allow: 'GET' } });
    if (request && new URL(request.url).search) return Response.json({ error: 'Parâmetros não permitidos' }, { status: 400, headers: NO_STORE });
    try {
      if (!cached || now() >= expiresAt) {
        if (now() < retryAfter) throw new Error('Cooldown');
        if (!pending) {
          pending = (async () => {
            const key = readKey();
            if (typeof key !== 'string' || key.length < 32) throw new Error('Missing configuration');
            const source = new URL(SOURCE_URL);
            source.searchParams.set('catalog_key', key);
            const upstream = await fetcher(source.href, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(10000) });
            if (!upstream.ok) throw new Error('Upstream failure');
            const products = await readBoundedJson(upstream);
            if (!Array.isArray(products) || products.length > 1000) throw new Error('Invalid catalog');
            cached = products.map(product => sanitizeProduct(product, now())).filter(Boolean);
            expiresAt = now() + CACHE_MS;
          })();
        }
        try { await pending; }
        catch { cached = undefined; retryAfter = now() + 10000; throw new Error('Unavailable'); }
        finally { pending = undefined; }
      }
      const currentTime = now();
      const products = cached.map(product => sanitizeProduct(product, currentTime));
      // O cache nunca prolonga o TTL nem usa stale-while-revalidate/stale-if-error.
      const priceExpiries = products.filter(p => p.price).map(p => Date.parse(p.data_verificacao) + PRICE_TTL_MS);
      const cacheSeconds = Math.max(0, Math.floor((Math.min(expiresAt, ...priceExpiries) - currentTime) / 1000));
      return Response.json(products, { headers: {
        'Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': cacheSeconds ? `public, s-maxage=${cacheSeconds}, must-revalidate` : 'no-store'
      } });
    } catch {
      // Nunca registrar a URL upstream: ela contém a chave de leitura.
      return Response.json({ error: 'Catálogo indisponível' }, { status: 503, headers: NO_STORE });
    }
  };
}
