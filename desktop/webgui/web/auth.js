/* 兼容占位：鉴权页脚本已统一到 /web/web.js。
 * 旧页面若仍引用 /web/auth.js，这里动态加载正式脚本，行为与直接引用一致。 */
(function () {
  'use strict';
  if (document.querySelector('script[data-auth-bundle]')) return;
  var script = document.createElement('script');
  script.src = '/web/web.js';
  script.defer = true;
  script.setAttribute('data-auth-bundle', '1');
  document.head.appendChild(script);
})();
