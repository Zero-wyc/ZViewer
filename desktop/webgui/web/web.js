/* 鉴权页脚本：登录 / 访问设置。
 * 由 Go 服务静态托管（/web/web.js），不依赖主界面运行时（bridge.js 不在这两个页面里）。
 * 所有请求都用同源 fetch + credentials:'same-origin'，会话由 cookie zviewer_web_session 维持。
 * 页面用 body[data-page] 声明身份：login | auth，本文件据此初始化对应逻辑。 */
(function () {
  'use strict';

  // 与 ui/theme.js 共用同一个键，登录后进入主界面主题不会突然跳变。
  var THEME_KEY = 'zviewer-theme-mode';
  var root = document.documentElement;

  function readThemeMode() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (error) { return 'system'; }
  }
  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function isDark() {
    var mode = readThemeMode();
    return mode === 'dark' || (mode !== 'light' && prefersDark());
  }
  // 只切 html.dark，颜色由 tokens.css 的变量负责；不写内联样式（CSP 禁止）。
  function applyTheme() {
    var dark = isDark();
    root.classList.toggle('dark', dark);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    var button = document.getElementById('theme-toggle');
    if (button) button.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  }
  function toggleTheme() {
    try { localStorage.setItem(THEME_KEY, isDark() ? 'light' : 'dark'); } catch (error) { /* 隐私模式忽略 */ }
    applyTheme();
  }
  applyTheme();
  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemThemeChange = function () { if (readThemeMode() === 'system') applyTheme(); };
    if (media.addEventListener) media.addEventListener('change', onSystemThemeChange);
    else if (media.addListener) media.addListener(onSystemThemeChange);
  }
  var themeButton = document.getElementById('theme-toggle');
  if (themeButton) themeButton.addEventListener('click', toggleTheme);

  function byId(id) { return document.getElementById(id); }

  // 同源 JSON 请求：永远 resolve 成 {ok, status, data}，网络错误也转成可读文案，
  // 这样每个调用点只关心成功/失败，不用到处 try/catch。
  function request(path, options) {
    var init = {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    };
    if (options) {
      if (options.method) init.method = options.method;
      if (options.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
    }
    return fetch(path, init).then(function (response) {
      var type = response.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) {
        // 会话失效时页面路由会 302 到登录页，fetch 跟随重定向后拿到 HTML：按未登录处理。
        return { ok: false, status: response.status, data: { ok: false, error: '登录状态已失效，请重新登录' } };
      }
      return response.json().then(function (data) {
        return { ok: response.ok && !(data && data.ok === false), status: response.status, data: data || {} };
      }, function () {
        return { ok: false, status: response.status, data: { ok: false, error: '服务端返回了无法解析的内容' } };
      });
    }, function () {
      return { ok: false, status: 0, data: { ok: false, error: '无法连接服务器，请确认 ZViewer 网页端仍在运行' } };
    });
  }

  // 错误与提示都落在页面内的提示区，不用 alert（无样式、移动端体验差）。
  function setNotice(kind, message) {
    var error = byId('auth-error');
    var note = byId('auth-note');
    if (error) {
      error.hidden = kind !== 'error';
      if (kind === 'error') error.textContent = message;
    }
    if (note) {
      note.hidden = kind !== 'note';
      if (kind === 'note') note.textContent = message;
    }
  }
  function clearNotice() { setNotice('none', ''); }

  function setBusy(form, busy, label) {
    if (!form) return;
    var button = form.querySelector('button[type="submit"]');
    if (!button) return;
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = !!busy;
    button.textContent = busy ? (label || '请稍候…') : button.dataset.idleLabel;
  }

  // 登录成功后回跳：只接受站内绝对路径，挡掉 //evil.com 这类开放重定向。
  function nextTarget() {
    var next = '';
    try { next = new URLSearchParams(location.search).get('next') || ''; } catch (error) { next = ''; }
    if (next.charAt(0) === '/' && next.charAt(1) !== '/' && next.indexOf('\\') === -1) return next;
    return '/';
  }

  function initLogin() {
    var form = byId('login-form');
    if (!form) return;
    request('/api/auth/status').then(function (result) {
      var status = result.data || {};
      if (status.authenticated) { location.replace(nextTarget()); return; }
      var account = byId('username');
      if (account) account.focus();
      if (status.databaseReady === false) {
        setNotice('note', '数据库尚未初始化：首次请用 root / root 登录，后端启动后改用真实管理员密码。');
      }
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearNotice();
      var account = (byId('username').value || '').trim();
      var password = byId('password').value;
      if (!account || !password) { setNotice('error', '请输入用户名和密码'); return; }
      setBusy(form, true, '登录中…');
      request('/api/auth/login', { method: 'POST', body: { username: account, password: password } }).then(function (result) {
        setBusy(form, false);
        if (result.ok && result.data && result.data.ok !== false) {
          // 与 ZViewer 后台一致：root 还在用初始口令时强提示一次，但不禁用登录。
          if (result.data.mustChangePassword) {
            setNotice('note', '当前仍是初始密码 root，请到 ZViewer 后台修改后再使用。');
            window.setTimeout(function () { location.replace(nextTarget()); }, 1500);
            return;
          }
          location.replace(nextTarget());
          return;
        }
        setNotice('error', (result.data && result.data.error) || '登录失败');
        var box = byId('password');
        if (box) { box.focus(); box.select(); }
      });
    });
  }

  function renderAccess(gui, status) {
    var urls = Array.isArray(gui.urls) ? gui.urls.filter(Boolean) : [];
    var list = byId('access-urls');
    if (list) {
      list.textContent = '';
      if (!urls.length) {
        var empty = document.createElement('li');
        empty.className = 'auth-note';
        empty.textContent = '暂无可访问地址';
        list.appendChild(empty);
      }
      urls.forEach(function (url) {
        var item = document.createElement('li');
        var link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = url;
        item.appendChild(link);
        if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) {
          var tag = document.createElement('span');
          tag.className = 'auth-tag';
          tag.textContent = '本机';
          item.appendChild(tag);
        }
        list.appendChild(item);
      });
    }
    var bind = byId('access-bind');
    if (bind) bind.textContent = gui.bind || '—';
    var port = byId('access-port');
    if (port) port.textContent = gui.port ? String(gui.port) : '—';
    var account = byId('access-account');
    if (account) account.textContent = gui.account || 'ZViewer 超级管理员';
    var database = byId('access-database');
    if (database) {
      database.textContent = status.databaseReady === false
        ? '未初始化（root / root 兜底）'
        : '已连接';
    }
  }

  function initAuth() {
    var logout = byId('logout');

    // 该页面是静态托管的（/web/auth.html），服务端不鉴权，所以进入时先确认会话。
    request('/api/auth/status').then(function (result) {
      var status = result.data || {};
      if (!status.authenticated) {
        location.replace('/login?next=' + encodeURIComponent('/web/auth.html'));
        return;
      }
      renderAccess(status.webgui || {}, status);
    });

    if (logout) {
      logout.addEventListener('click', function () {
        logout.disabled = true;
        request('/api/auth/logout', { method: 'POST' }).then(function () {
          location.replace('/login');
        });
      });
    }
  }

  var page = (document.body && document.body.dataset && document.body.dataset.page) || '';
  if (page === 'login') initLogin();
  else if (page === 'auth') initAuth();
})();
