/* Theme toggle. Load early (in <head>, before first paint) to avoid a flash. */
(function () {
  var KEY = 'acc-studio-theme';
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}
  }
  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  apply(saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  window.toggleTheme = function (btn) {
    var next = current() === 'light' ? 'dark' : 'light';
    apply(next);
    if (btn) {
      btn.textContent = next === 'light' ? '☾' : '☀';
      btn.title = next === 'light' ? 'Switch to dark' : 'Switch to light';
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.textContent = current() === 'light' ? '☾' : '☀';
      b.addEventListener('click', function () { window.toggleTheme(b); });
    });
  });
})();
