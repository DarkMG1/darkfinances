const DEMO_KEY = 'df_demo';

export const demoOnlyPage = location.pathname === '/demo';

let demoMode = demoOnlyPage || localStorage.getItem(DEMO_KEY) === '1';

export function installDemoFetch() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (demoMode && typeof url === 'string' && url.startsWith('/api/')) {
      const next = url + (url.includes('?') ? '&' : '?') + 'demo=1';
      return nativeFetch(next, opts);
    }
    return nativeFetch(url, opts);
  };
}

export function toggleDemo() {
  if (demoOnlyPage) return;
  demoMode = !demoMode;
  localStorage.setItem(DEMO_KEY, demoMode ? '1' : '0');
  location.reload();
}

export function applyDemoIndicator() {
  document.body.classList.toggle('demo-on', demoMode);
  const button = document.getElementById('demoToggle');
  if (button) {
    button.classList.toggle('demo-active', demoMode);
    button.textContent = demoMode ? 'Demo \u2713' : 'Demo';
    if (demoOnlyPage) {
      button.disabled = true;
      button.title = 'This page always uses synthetic data';
    }
  }
}

export function demoCsvUrl(url) {
  if (!demoMode) return url;
  return url + (url.includes('?') ? '&' : '?') + 'demo=1';
}
