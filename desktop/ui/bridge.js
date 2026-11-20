// 桥接层：把 Go 绑定包装成界面唯一认的 window.zviewerDesktop。
// 只在 WebView2（wails.localhost）里生效；浏览器预览（preview-server）不命中，
// 界面仍走演示态。若同名对象已存在则直接退出，避免重复注入。
(() => {
  'use strict';
  if (window.zviewerDesktop) return;
  const native = location.hostname === 'wails.localhost' || location.protocol === 'wails:';
  if (!native) return;

  // 让页面透出 Mica 材质：body 透明由 styles.css 的 html.mica 规则负责。
  document.documentElement.classList.add('mica');

  const app = () => window.go?.main?.App;
  const call = (method, ...args) => {
    const fn = app()?.[method];
    if (typeof fn !== 'function') return Promise.reject(new Error('桌面桥接尚未就绪：' + method));
    return Promise.resolve(fn(...args));
  };
  const on = (event, callback) => {
    const bind = () => window.runtime?.EventsOn?.(event, callback);
    if (window.runtime) bind();
    else window.addEventListener('DOMContentLoaded', bind, { once: true });
  };

  window.zviewerDesktop = {
    info: () => call('Info'),
    command: (action, payload) => call('Command', action, payload || {}),
    window: action => call('Window', action),
    openDocs: () => call('OpenDocs'),
    onNavigate: callback => on('navigate', callback),
    onUpdate: callback => on('desktop-update', callback),
    onCrawlerChallenge: callback => on('crawler-challenge', callback),
    demoState: () => Promise.resolve(),
    closeBehavior: () => {}
  };
})();
