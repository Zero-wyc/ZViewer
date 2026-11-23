// 桥接层：把 Go 绑定包装成界面唯一认的 window.zviewerDesktop。
// 桌面模式（Wails WebView2，wails.localhost / wails:）走 window.go 绑定；
// 网页模式（Go HTTP 服务在浏览器里打开同一套 UI）走同源 fetch + EventSource。
// 两种模式导出的对象语义一致，界面层（app.js / live.js）不需要分支。
// 若同名对象已存在则直接退出，避免重复注入。
(() => {
  'use strict';
  if (window.zviewerDesktop) return;
  const desktop = location.protocol === 'wails:' || location.hostname === 'wails.localhost';
  if (desktop) installDesktop();
  else installWeb();

  // ---------- 桌面模式：Wails 注入的 window.go.main.App ----------
  function installDesktop() {
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
  }

  // ---------- 网页模式：同源 HTTP API + SSE ----------
  function installWeb() {
    // 网页版没有 Wails 窗口栏：html 立刻加 class（脚本在 head 里同步执行，
    // 避免先闪一下窗口栏），body 解析出来后再补一次供 body.web 选择器使用。
    document.documentElement.classList.add('web');
    const markBody = () => document.body?.classList.add('web');
    if (document.body) markBody();
    else document.addEventListener('DOMContentLoaded', markBody, { once: true });

    const JSON_HEADERS = { 'Content-Type': 'application/json' };
    const listeners = { update: [], navigate: [], challenge: [] };
    const MAX_IMPORT_BYTES = 256 * 1024;
    let source = null;

    // 会话失效时整页跳登录页；返回一个永不 resolve 的 Promise，
    // 让调用方停在原地——页面都要跳走了，再抛错只会冒出无意义的提示。
    function redirectToLogin() {
      const next = location.pathname + location.hash;
      location.href = '/login?next=' + encodeURIComponent(next);
      return new Promise(() => {});
    }

    // 统一的同源请求：401 跳登录，非 2xx 解码服务端 error 文案，
    // 其余按 JSON 解析（服务端可能返回空 body，例如 logout）。
    async function api(path, options = {}) {
      const init = { credentials: 'same-origin', cache: 'no-store', ...options };
      if (init.json !== undefined) {
        init.method = init.method || 'POST';
        init.body = JSON.stringify(init.json);
        delete init.json;
        init.headers = { ...JSON_HEADERS, ...(init.headers || {}) };
      }
      let response;
      try {
        response = await fetch(path, init);
      } catch {
        throw new Error('无法连接服务端，请确认 ZViewer 网页端仍在运行');
      }
      if (response.status === 401) return redirectToLogin();
      // 兜底：静态路由在未登录时会 302 到登录页，fetch 跟随重定向后拿到的是 HTML；
      // 这种情况按未登录处理，而不是把 HTML 当 JSON 解析。
      if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
        return redirectToLogin();
      }
      const text = await response.text();
      if (!response.ok) {
        let message = '请求失败：HTTP ' + response.status;
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.error) message = parsed.error;
        } catch {
          if (text.trim()) message = text.trim().slice(0, 200);
        }
        throw new Error(message);
      }
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    }

    // 鉴权接口专用：登录失败返回 401 + {error}，不能走 api() 的「401 整页跳登录」；
    // 失败统一返回 {ok:false,error}，由调用方决定怎么提示。
    async function authRequest(path, body) {
      let response;
      try {
        response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: JSON_HEADERS,
          body: JSON.stringify(body || {})
        });
      } catch {
        throw new Error('无法连接服务端，请确认 ZViewer 网页端仍在运行');
      }
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (data && typeof data === 'object') return data;
      return { ok: false, error: '请求失败：HTTP ' + response.status };
    }

    // /api/command 应答：{ok:true, result[, downloads]}；业务失败可能是 400 + {ok:false,error}，
    // 也可能沿用 200 + ok:false（api() 已把非 2xx 转成 Error，这里再兜一次 ok 字段）。
    async function postCommand(action, payload) {
      const data = await api('/api/command', { json: { action, payload: payload || {} } });
      if (!data || data.ok !== true) throw new Error((data && data.error) || '命令执行失败');
      if (Array.isArray(data.downloads)) saveDownloads(data.downloads);
      return data.result;
    }

    // 下载 token 一次性且 5 分钟过期：拿到应答就立刻触发浏览器下载（不能等用户再点）。
    let downloadsSeen = 0;
    function triggerDownload(url, name) {
      const link = document.createElement('a');
      link.href = url;
      if (name) link.download = name;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    function saveDownloads(items) {
      for (const item of items) {
        if (!item || !item.token) continue;
        downloadsSeen += 1;
        triggerDownload('/api/download?token=' + encodeURIComponent(item.token), item.name || '');
      }
    }

    // 浏览器里没有原生文件对话框：动态 <input type=file> 是唯一可行方案。
    // change 只在选中文件时触发，取消用 cancel 事件兜底；老浏览器没有 cancel，
    // 就在窗口重新获得焦点后检查一次有没有选中文件。
    function pickFile(accept) {
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.position = 'fixed';
        input.style.left = '-10000px';
        input.setAttribute('aria-hidden', 'true');
        document.body.appendChild(input);
        let settled = false;
        const finish = file => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(file || null);
        };
        input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
        input.addEventListener('cancel', () => finish(null), { once: true });
        setTimeout(() => {
          window.addEventListener('focus', () => {
            setTimeout(() => { if (!settled) finish(input.files?.[0]); }, 300);
          }, { once: true });
        }, 400);
        input.click();
      });
    }

    function readTextFile(file) {
      if (file.size > MAX_IMPORT_BYTES) return Promise.reject(new Error('配置文件超过 256KB，请精简后再导入'));
      if (typeof file.text === 'function') return file.text();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsText(file);
      });
    }

    // 按扩展名映射后端认的 format：toml / yaml / json（yml 统一成 yaml）。
    function configFormat(name, fallback) {
      const ext = String(name || '').split('.').pop().toLowerCase();
      if (ext === 'toml' || ext === 'yaml' || ext === 'json') return ext;
      if (ext === 'yml') return 'yaml';
      return fallback;
    }

    // 桌面版这两个动作由 Go 端弹文件框；网页版必须自己读文件再复用保存动作。
    async function importConfigFile(action) {
      const mesh = action === 'mesh-config-import';
      const file = await pickFile(mesh ? '.toml' : '.toml,.yaml,.yml,.json');
      if (!file) return { canceled: true };
      const content = await readTextFile(file);
      const format = mesh ? 'toml' : configFormat(file.name, 'toml');
      const saved = await postCommand(mesh ? 'mesh-config-save' : 'frp-config-save', { content, format });
      const data = saved && typeof saved === 'object' ? saved : {};
      return {
        canceled: false,
        content: data.content ?? content,
        path: data.path || '',
        format: data.format || format,
        name: file.name
      };
    }

    // 爬虫规则导入在网页端走专用接口：浏览器选文件、读文本、服务端只负责解析入库。
    async function importCrawlerRules(payload = {}) {
      const file = await pickFile('.json,application/json');
      if (!file) return { canceled: true };
      const content = await readTextFile(file);
      // 服务端应答是 {ok:true,result:report}：把 report 外层剥掉，再补上文件名，
      // 让 crawler_ui.js 拿到和桌面版一致的字段（它直接读 report 的统计字段）。
      const data = await api('/api/crawler/import', {
        json: { content, name: file.name, mode: payload.mode || 'merge', dryRun: Boolean(payload.dryRun) }
      });
      if (!data || data.ok !== true) throw new Error((data && data.error) || '导入爬虫规则失败');
      const report = data.result && typeof data.result === 'object' ? data.result : {};
      return { canceled: false, name: file.name, ...report };
    }

    function dispatch(kind, data) {
      for (const callback of listeners[kind]) {
        try { callback(data); } catch (error) { console.error('网页端事件处理失败：', error); }
      }
    }

    // SSE 的 data 可能是 JSON 对象，也可能直接是字符串（navigate / open-url），两种都兼容。
    function parseData(raw) {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    }

    // 重新拉一次最新快照并按 desktop-update 派发：SSE 断线重连期间可能错过推送。
    async function refreshSnapshot() {
      if (!listeners.update.length) return;
      try {
        const data = await api('/api/info');
        if (data && typeof data === 'object') dispatch('update', data);
      } catch { /* 网络抖动交给 EventSource 自动重连，这里不打断界面 */ }
    }

    // 只建一条 EventSource；断线重连是 EventSource 自带行为，不需要自己写退避。
    // 唯一要自己处理的是「会话过期」：服务端对 /api/events 回 401 时 EventSource 只会
    // 无限重试，所以连续出错后查一次鉴权状态，确认掉登录就整页跳登录页。
    let sseErrors = 0;
    function ensureSource() {
      if (source) return;
      source = new EventSource('/api/events');
      source.addEventListener('open', () => { sseErrors = 0; });
      source.addEventListener('error', () => {
        sseErrors += 1;
        if (sseErrors !== 2) return;
        api('/api/auth/status').then(status => {
          if (status && status.passwordSet && status.authenticated === false) redirectToLogin();
        }).catch(() => { /* 服务端整体不可达：保留 EventSource 重连 */ });
      });
      source.addEventListener('desktop-update', event => dispatch('update', parseData(event.data)));
      source.addEventListener('navigate', event => dispatch('navigate', parseData(event.data)));
      source.addEventListener('crawler-challenge', event => dispatch('challenge', parseData(event.data)));
      // 密码变化：界面据此重拉 /api/info，避免网页端卡片继续显示旧密码。
      source.addEventListener('open-url', event => {
        // 兼容两种载荷：直接是 URL 字符串，或 {url:"..."}。
        const payload = parseData(event.data);
        const url = typeof payload === 'string' ? payload : payload && payload.url;
        if (typeof url === 'string' && url) window.open(url, '_blank', 'noopener');
      });
      // ready：服务端在事件流开头先推一份完整快照（含 web/native/webgui 字段），
      // 直接当 desktop-update 派发即可；只有载荷意外为空时才补拉 /api/info。
      source.addEventListener('ready', event => {
        const snapshot = parseData(event.data);
        if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length) {
          dispatch('update', snapshot);
        } else {
          refreshSnapshot();
        }
      });
      // download：服务端用事件下发文件（token 已包含在 url 里），直接触发浏览器下载。
      source.addEventListener('download', event => {
        const payload = parseData(event.data);
        if (typeof payload === 'string' && payload) triggerDownload(payload, '');
        else if (payload && typeof payload === 'object' && payload.url) triggerDownload(payload.url, payload.name || '');
      });
      // notice：服务端主动提示，转成界面 toast（网页端不用 alert）。
      source.addEventListener('notice', event => {
        const payload = parseData(event.data);
        const message = typeof payload === 'string' ? payload : (payload && payload.message) || '';
        if (message) window.ZViewerUI?.toast?.(message);
      });
      // initial-admin：首次运行生成的管理员凭据；网页端没有原生弹窗，写控制台并提示。
      source.addEventListener('initial-admin', event => {
        const payload = parseData(event.data) || {};
        console.info('[ZViewer] 已生成初始管理员账号：', payload);
        window.ZViewerUI?.toast?.('已生成初始管理员账号，凭据见服务端日志');
      });
    }

    // 移动端侧栏是抽屉：注入悬浮按钮 + 遮罩，点击只切 body 的 class，
    // 位置、动画、何时出现全部交给 webgui.css；桌面模式不会创建这些节点。
    function installMobileNav() {
      if (document.getElementById('web-nav-toggle')) return;
      const toggle = document.createElement('button');
      toggle.id = 'web-nav-toggle';
      toggle.type = 'button';
      toggle.textContent = '☰';
      toggle.setAttribute('aria-label', '打开导航菜单');
      toggle.setAttribute('aria-expanded', 'false');
      const scrim = document.createElement('div');
      scrim.id = 'web-nav-scrim';
      scrim.setAttribute('aria-hidden', 'true');
      document.body.append(toggle, scrim);
      const setOpen = open => {
        document.body.classList.toggle('web-nav-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        // 抽屉打开时按钮滑到抽屉右边，图标同步变成关闭。
        toggle.textContent = open ? '✕' : '☰';
        toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
      };
      toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('web-nav-open')));
      scrim.addEventListener('click', () => setOpen(false));
      // 点导航链接后自动收起，抽屉不会挡住目标页面。
      document.querySelector('.sidebar')?.addEventListener('click', event => {
        if (event.target.closest('a[data-page], .settings-link, nav a')) setOpen(false);
      });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false); });
      // 拉宽到桌面断点后抽屉状态没有意义，顺手复位。
      window.addEventListener('resize', () => {
        if (window.innerWidth > 720 && document.body.classList.contains('web-nav-open')) setOpen(false);
      });
    }

    window.zviewerDesktop = {
      // 桌面版 Info() 自带 live/native；网页端由服务端补 web:true，这里再兜一层，
      // 保证界面一定进实时分支（app.js 用 info.live 决定是否派发 zviewer-ready）。
      info: async () => {
        const data = await api('/api/info');
        if (!data || typeof data !== 'object') throw new Error('服务端返回的控制台快照无效');
        if (data.web === undefined) data.web = true;
        if (data.native === undefined) data.native = false;
        if (data.live === undefined) data.live = true;
        return data;
      },
      command: async (action, payload) => {
        if (action === 'frp-config-import' || action === 'mesh-config-import') return importConfigFile(action);
        if (action === 'crawler-import') return importCrawlerRules(payload || {});
        const body = payload || {};
        const before = downloadsSeen;
        const result = await postCommand(action, body);
        // 导出类动作：网页端服务端通过 SSE 的 download 事件下发一次性链接（走 Host.DeliverFile），
        // 所以不能在这里无条件回退，否则会重复下载两次。仅当 SSE 还没连上（事件必丢）才走
        // GET /api/export 直连兜底。
        const sseReady = source && source.readyState === EventSource.OPEN;
        if (action === 'export' && body.kind && downloadsSeen === before && !sseReady) {
          triggerDownload('/api/export?kind=' + encodeURIComponent(body.kind), '');
        }
        return result;
      },
      // 网页端没有原生窗口：仍转发 /api/window 保持接口一致，服务端直接返回 noop。
      window: action => api('/api/window', { json: { action } }).catch(() => null),
      openDocs: () => { window.open('https://docx.zviewer.zero251.xyz/', '_blank', 'noopener'); },
      onNavigate: callback => { if (typeof callback === 'function') { listeners.navigate.push(callback); ensureSource(); } },
      onUpdate: callback => { if (typeof callback === 'function') { listeners.update.push(callback); ensureSource(); } },
      onCrawlerChallenge: callback => { if (typeof callback === 'function') { listeners.challenge.push(callback); ensureSource(); } },
      demoState: () => Promise.resolve(),
      closeBehavior: () => {},
      // 供登录/设置页判断运行形态，并复用同一套鉴权调用（同源 fetch + 会话 cookie）。
      web: true,
      auth: {
        status: () => api('/api/auth/status'),
        login: password => authRequest('/api/auth/login', { password }),
        // 服务启动即生成随机密码，不再有「首次设置」；空 new 表示重置为随机密码。
        resetPassword: current => authRequest('/api/auth/password', { current, new: '' }),
        logout: () => authRequest('/api/auth/logout', {})
      }
    };

    // 事件回调可能晚于页面加载注册，连接到 DOM 就绪就建立，避免错过第一条推送。
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { markBody(); installMobileNav(); ensureSource(); }, { once: true });
    } else {
      markBody();
      installMobileNav();
      ensureSource();
    }
  }
})();
