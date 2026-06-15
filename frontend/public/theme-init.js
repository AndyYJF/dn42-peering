// apply saved theme before first paint to avoid a flash
try {
  var t = localStorage.getItem('pd-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch (e) {}
