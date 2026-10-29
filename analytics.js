(() => {
  const measurementId = 'G-ZYE5X0D1D5';
  const consentKey = 'boom-analytics-consent';

  let consent;

  function startAnalytics() {
    if (window.__boomAnalyticsStarted) return;
    window.__boomAnalyticsStarted = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', measurementId, { anonymize_ip: true });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.append(script);
    const insights = document.createElement('script');
    insights.defer = true;
    insights.src = '/_vercel/insights/script.js';
    document.head.append(insights);
  }

  function trackAffiliateClick(link) {
    if (consent !== 'granted' || !window.gtag || !link) return;
    window.gtag('event', 'affiliate_click', {
      product_id: link.dataset.productId,
      product_name: link.dataset.productName,
      link_url: link.href,
      link_domain: 'mercadolivre.com.br'
    });
  }

  let activeBanner;
  let returnFocus;

  function showConsent() {
    if (activeBanner) { activeBanner.querySelector('button').focus(); return; }
    returnFocus = document.activeElement;
    const banner = document.createElement('section');
    activeBanner = banner;
    banner.className = 'analytics-consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Preferência de métricas');
    banner.innerHTML = '<p><strong>Uso de métricas</strong><br>Usamos métricas para entender visitas e cliques nos produtos. Você pode continuar sem autorizar.</p><div class="analytics-consent-actions"><button type="button" data-analytics-choice="denied">Continuar sem métricas</button><button class="analytics-accept" type="button" data-analytics-choice="granted">Aceitar métricas</button></div>';
    banner.addEventListener('click', event => {
      const choice = event.target.closest('[data-analytics-choice]')?.dataset.analyticsChoice;
      if (!choice) return;
      consent = choice;
      try { localStorage.setItem(consentKey, choice); } catch { /* vale para esta visita */ }
      try { sessionStorage.setItem(consentKey, choice); } catch { /* armazenamento pode estar indisponível */ }
      if (choice === 'denied' && window.__boomAnalyticsStarted) {
        // Recarregar encerra também os scripts de métricas já carregados.
        window[`ga-disable-${measurementId}`] = true;
        document.cookie.split(';').forEach(cookie => {
          const name = cookie.split('=')[0].trim();
          if (!/^_ga(?:_|$)/.test(name)) return;
          const domains = window.location.hostname.split('.');
          document.cookie = `${name}=; Max-Age=0; path=/`;
          while (domains.length > 1) {
            document.cookie = `${name}=; Max-Age=0; path=/; domain=${domains.join('.')}`;
            domains.shift();
          }
        });
        window.location.reload();
      }
      if (choice === 'granted') startAnalytics();
      banner.remove();
      activeBanner = null;
      returnFocus?.focus();
    });
    document.body.append(banner);
    banner.querySelector('button').focus();
  }

  document.querySelector('[data-privacy-preferences]')?.addEventListener('click', showConsent);
  try { consent = localStorage.getItem(consentKey); } catch { /* navegador pode bloquear armazenamento */ }
  try { consent = sessionStorage.getItem(consentKey) || consent; } catch { /* armazenamento pode estar indisponível */ }
  if (consent === 'granted') startAnalytics();
  else if (consent !== 'denied') showConsent();

  document.addEventListener('click', event => trackAffiliateClick(event.target.closest('.cta')));
})();
