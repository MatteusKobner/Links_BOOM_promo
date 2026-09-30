// URLs oficiais da BOOM Promo. Vazio = botão indisponível.
const socialLinks = {
  youtube: 'https://www.youtube.com/@BOOMpromo01',
  instagram: 'https://www.instagram.com/boom_promo01/',
  tiktok: 'https://www.tiktok.com/@boom_promo_01'
};
const socialIcons = {
  youtube: '<path fill="currentColor" d="M21.6 7.2a3 3 0 0 0-2.1-2.1C17.7 4.6 12 4.6 12 4.6s-5.7 0-7.5.5a3 3 0 0 0-2.1 2.1C2 9 2 12 2 12s0 3 .4 4.8a3 3 0 0 0 2.1 2.1c1.8.5 7.5.5 7.5.5s5.7 0 7.5-.5a3 3 0 0 0 2.1-2.1C22 15 22 12 22 12s0-3-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"/>',
  instagram: '<g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/></g><circle fill="currentColor" cx="17.5" cy="6.5" r="1"/>',
  tiktok: '<path fill="currentColor" d="M15.5 2h-4v13a3 3 0 1 1-3-3c.4 0 .8.1 1.1.2V8.1A7 7 0 1 0 15.5 15V8.5c1.8 1.2 3.6 1.6 5.5 1.6v-4c-3.2 0-5.5-1.6-5.5-4.1Z"/>'
};

function renderSocials() {
  const labels = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
  document.querySelector('#socials').innerHTML = Object.entries(labels).map(([key, label]) => {
    const content = `<svg viewBox="0 0 24 24" aria-hidden="true">${socialIcons[key]}</svg>${label}`;
    const url = safeUrl(socialLinks[key]);
    return url
      ? `<a class="social-button" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer" aria-label="BOOM! PROMO no ${label} (abre em nova aba)">${content}</a>`
      : `<button class="social-button" type="button" disabled aria-label="${label}: perfil ainda não disponível" title="Perfil ainda não disponível">${content}</button>`;
  }).join('');
}

function imagePlaceholder() {
  return `<div class="media-placeholder"><svg viewBox="0 0 48 48" fill="none" stroke-width="1.5" aria-hidden="true"><rect x="8" y="8" width="32" height="32" rx="7"/><circle cx="18" cy="18" r="3"/><path d="m8 33 11-10 8 7 6-6 7 9"/></svg><span>Foto em breve</span><small>Confira o produto na loja parceira</small></div>`;
}

async function loadProducts() {
  const container = document.querySelector('#products');
  const counter = document.querySelector('#product-count');
  try {
    const response = await fetch('/products.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Falha ao carregar produtos: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Formato inválido de produtos');
    const products = data.filter(product => product && product.active !== false);
    counter.textContent = `${products.length} ${products.length === 1 ? 'produto' : 'produtos'}`;
    if (!products.length) {
      container.innerHTML = '<div class="empty">Nenhum produto disponível no momento.</div>';
      return;
    }
    container.innerHTML = products.map(product => {
      const image = safeUrl(product.image, true);
      const url = safeUrl(product.url);
      return `
      <article class="card">
        <div class="product-media">
          ${image ? `<img class="product-image" src="${escapeAttribute(image)}" alt="${escapeAttribute(product.alt || product.name)}" loading="lazy" decoding="async" width="800" height="1400">` : imagePlaceholder()}
        </div>
        <div class="card-content">
          ${product.badge ? `<span class="badge">${escapeHtml(product.badge)}</span>` : ''}
          <h3 class="product-name">${escapeHtml(product.name)}</h3>
          <p class="desc">${escapeHtml(product.description || '')}</p>
          ${Array.isArray(product.features) && product.features.length ? `<ul class="features">${product.features.slice(0, 4).map(feature => `<li class="feature">${escapeHtml(feature)}</li>`).join('')}</ul>` : ''}
          <div class="purchase">
            <div class="price-row">
              <div class="store">${escapeHtml(product.store || 'Loja parceira')}</div>
              <div class="price">${escapeHtml(product.price || 'Ver oferta')}</div>
            </div>
            ${url ? `<a class="cta" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer sponsored" aria-label="${escapeAttribute(`Compre ${product.name} diretamente pelo ${product.store || 'site da loja'} (abre em nova aba)`)}">Compre diretamente pelo ${escapeHtml(product.store || 'site da loja')} <span aria-hidden="true">→</span></a>` : '<span class="cta-unavailable">Oferta indisponível no momento</span>'}
          </div>
        </div>
      </article>`;
    }).join('');
    if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const card = entry.target;
          card.classList.add('card-entering');
          card.addEventListener('animationend', () => card.classList.remove('card-entering'), { once: true });
          observer.unobserve(card);
        });
      }, { threshold: 0.12 });
      container.querySelectorAll('.card').forEach(card => observer.observe(card));
    }
    container.querySelectorAll('.product-image').forEach(img => {
      img.addEventListener('error', () => { img.parentElement.innerHTML = imagePlaceholder(); }, { once: true });
    });
  } catch (error) {
    console.error(error);
    counter.textContent = '';
    container.innerHTML = '<div class="empty">Não foi possível carregar os produtos agora. Tente novamente em instantes.</div>';
  } finally {
    container.setAttribute('aria-busy', 'false');
  }
}

// Preserve a sanitização mesmo quando os valores vierem do JSON.
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  })[char]);
}
function escapeAttribute(value = '') { return escapeHtml(value); }
function safeUrl(value, allowLocal = false) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, window.location.origin);
    if (allowLocal && url.origin === window.location.origin && /^\/(?!\/)/.test(value)) return url.pathname;
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
renderSocials();
loadProducts();
