(() => {
  const measurementId = 'G-ZYE5X0D1D5';
  const consentKey = 'boom-analytics-consent';

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
  }

  function trackAffiliateClick(link) {
    if (!window.gtag || !link) return;
    window.gtag('event', 'affiliate_click', {
      product_id: link.dataset.productId,
      product_name: link.dataset.productName,
      link_url: link.href,
      link_domain: 'mercadolivre.com.br'
    });
  }

  function showConsent() {
    const banner = document.createElement('section');
    banner.className = 'analytics-consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Preferência de métricas');
    banner.innerHTML = '<p><strong>Uso de métricas</strong><br>Usamos métricas para entender visitas e cliques nos produtos. Você pode continuar sem autorizar.</p><div class="analytics-consent-actions"><button type="button" data-analytics-choice="denied">Continuar sem métricas</button><button class="analytics-accept" type="button" data-analytics-choice="granted">Aceitar métricas</button></div>';
    banner.addEventListener('click', event => {
      const choice = event.target.closest('[data-analytics-choice]')?.dataset.analyticsChoice;
      if (!choice) return;
      localStorage.setItem(consentKey, choice);
      if (choice === 'granted') startAnalytics();
      banner.remove();
    });
    document.body.append(banner);
  }

  const consent = localStorage.getItem(consentKey);
  if (consent === 'granted') startAnalytics();
  else if (consent !== 'denied') showConsent();

  document.addEventListener('click', event => trackAffiliateClick(event.target.closest('.cta')));
})();
