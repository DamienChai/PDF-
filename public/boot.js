// Runs before first paint. Reads persisted settings and sets <html data-theme> / lang.
(function () {
  try {
    var raw = localStorage.getItem('pdfkey:settings');
    var s = raw ? JSON.parse(raw) : {};
    var theme = s.theme === 'light' || s.theme === 'dark' ? s.theme : null;
    if (!theme) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* storage unavailable: CSS falls back to prefers-color-scheme */
  }
})();
