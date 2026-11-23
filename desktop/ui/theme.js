// 主题：跟随系统 / 浅色 / 深色 三态循环，选择写入 localStorage。
// tokens.css 的深色令牌挂在 html.dark 上，所以只需切 class。
(() => {
  'use strict';
  const KEY = 'zviewer-theme-mode';
  const ORDER = ['system', 'light', 'dark'];
  const LABEL = { system: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };
  // Fluent 图标是 PUA 码位，只有 Windows 自带 Segoe 图标字体时才有字形；
  // 手机/其它系统直接用 PUA 会渲染成空白方块，所以按平台退回 Unicode 文本符号。
  // 这里用平台判断而不是字体探测：document.fonts.check 在 Android Chrome 上对任何
  // 字体名都返回 true，canvas 对比结果又依赖字体加载时机，都会误判（实测过）。
  const IS_WINDOWS = (() => {
    const platformData = navigator.userAgentData && navigator.userAgentData.platform;
    if (platformData) return /^Windows$/i.test(platformData);
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    // platform 在 Windows 上是 "Win32"/"Win64"；用 ^Win 避免 macOS 的 "Darwin" 误判。
    return /Windows NT|Windows Phone|Win32|Win64/i.test(ua) || /^Win/i.test(platform);
  })();
  const ICON_FONT = IS_WINDOWS;
  const GLYPH = ICON_FONT
    ? { light: '\uE706', dark: '\uE708', system: '\uE7F4' }
    : { light: '\u2600', dark: '\u263e', system: '\u25d0' };
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const mode = () => (ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system');

  function apply() {
    const value = mode();
    const dark = value === 'dark' || (value === 'system' && media.matches);
    root.classList.toggle('dark', dark);
    root.dataset.theme = value;
    // 同步 DWM 材质深浅，避免页面转浅色而 Mica 仍是深色；浏览器预览没有 go，会被跳过。
    try { window.go?.main?.App?.SetTheme?.(dark); } catch { /* 忽略桥接未就绪 */ }
    const button = document.getElementById('theme-button');
    if (button) {
      button.title = LABEL[value];
      button.setAttribute('aria-label', LABEL[value]);
      const glyph = button.querySelector('.icon-glyph');
      if (glyph) glyph.textContent = GLYPH[value === 'system' ? (dark ? 'dark' : 'light') : value];
    }
  }

  apply();

  media.addEventListener('change', () => { if (mode() === 'system') apply(); });

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-button')?.addEventListener('click', () => {
      localStorage.setItem(KEY, ORDER[(ORDER.indexOf(mode()) + 1) % ORDER.length]);
      apply();
    });
  });
})();
