
async function loadProducts() {
  const container = document.querySelector('#products');
  const counter = document.querySelector('#product-count');

  try {
    const response = await fetch('/products.json', { cache: 'no-store' });
    const products = (await response.json()).filter(product => product.active !== false);

    counter.textContent = `${products.length} ${products.length === 1 ? 'produto' : 'produtos'}`;

    if (!products.length) {
      container.innerHTML = '<div class="empty">Nenhum produto disponível no momento.</div>';
      return;
    }

    container.innerHTML = products.map(product => `
      <article class="card">
        ${product.badge ? `<span class="badge">${escapeHtml(product.badge)}</span>` : ''}
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <p class="desc">${escapeHtml(product.description || '')}</p>

        ${Array.isArray(product.features) && product.features.length ? `
          <div class="features">
            ${product.features.map(feature => `<span class="feature">${escapeHtml(feature)}</span>`).join('')}
          </div>
        ` : ''}

        <div class="price-row">
          <div>
            <div class="store">${escapeHtml(product.store || 'Loja parceira')}</div>
            <div class="price">${escapeHtml(product.price || 'Ver oferta')}</div>
          </div>
        </div>

        <a class="cta"
           href="${escapeAttribute(product.url)}"
           target="_blank"
           rel="noopener noreferrer sponsored">
          Ver produto →
        </a>
      </article>
    `).join('');
  } catch (error) {
    console.error(error);
    container.innerHTML = '<div class="empty">Não foi possível carregar os produtos agora.</div>';
  }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  })[char]);
}

function escapeAttribute(value = '') {
  return escapeHtml(value);
}

loadProducts();
