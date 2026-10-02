import { readFile, writeFile } from 'node:fs/promises';

const productsPath = new URL('../products.json', import.meta.url);
const products = JSON.parse(await readFile(productsPath, 'utf8'));
let changed = false;
let checked = 0;
let unavailable = 0;

function formatBrl(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

for (const product of products) {
  if (!product?.active || !/^MLB\d+$/.test(product.marketplaceItemId || '')) continue;

  try {
    const response = await fetch(`https://api.mercadolibre.com/items/${product.marketplaceItemId}`, {
      headers: { 'User-Agent': 'BOOM-Promo-price-checker/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const item = await response.json();
    if (item.status !== 'active' || item.currency_id !== 'BRL' || !Number.isFinite(item.price)) {
      throw new Error('Anúncio indisponível ou sem preço em reais');
    }

    checked += 1;
    const price = formatBrl(item.price);
    const originalPrice = Number.isFinite(item.original_price) && item.original_price > item.price
      ? formatBrl(item.original_price)
      : null;

    if (product.price !== price) {
      product.price = price;
      changed = true;
    }
    if (product.originalPrice !== originalPrice) {
      if (originalPrice) product.originalPrice = originalPrice;
      else delete product.originalPrice;
      changed = true;
    }
  } catch (error) {
    unavailable += 1;
    console.warn(`Não foi possível consultar ${product.name}: ${error.message}`);
  }
}

if (checked === 0) {
  console.error('Nenhum preço foi confirmado; products.json não foi alterado.');
  process.exit(1);
}

if (changed) await writeFile(productsPath, `${JSON.stringify(products, null, 2)}\n`);
console.log(`Consultados: ${checked}. Indisponíveis: ${unavailable}. Alterações: ${changed ? 'sim' : 'não'}.`);
