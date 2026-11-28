// Runs before first paint, ahead of the application bundle: applies the saved theme and language
// so that the page never flashes the wrong colours. Mirrors src/state/settings.ts (theme, colours)
// and src/i18n/locale.ts (language); src/state/settings.test.ts checks that they agree.
// Plain ES5 on purpose: no build step, and it must not fail in any browser.
(function () {
  var LIGHT = '#F7F7FB';
  var DARK = '#111318';
  var root = document.documentElement;

  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('pdfkey:settings') || 'null');
  } catch (e) {
    // Storage unavailable or not JSON: defaults.
  }
  if (!saved || typeof saved !== 'object') saved = {};

  var fixed = saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : null;
  var theme = fixed;
  if (!theme) {
    try {
      theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      theme = 'light';
    }
  }
  root.setAttribute('data-theme', theme);
  if (fixed) {
    // A fixed theme overrides both per-scheme colours of the browser UI.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute('content', fixed === 'dark' ? DARK : LIGHT);
    }
  }

  var lang = saved.language === 'zh-CN' || saved.language === 'en' ? saved.language : null;
  if (!lang) {
    lang = 'en';
    var preferred = [];
    try {
      preferred = navigator.languages || [navigator.language];
    } catch (e) {
      // Keep the default.
    }
    for (var j = 0; j < preferred.length; j++) {
      var primary = String(preferred[j]).toLowerCase().split(/[-_]/)[0];
      if (primary === 'zh') lang = 'zh-CN';
      if (primary === 'zh' || primary === 'en') break;
    }
  }
  root.lang = lang;
})();
