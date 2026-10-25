(() => {
  'use strict';
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    network: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v6M5 17v-4h14v4"/>',
    mesh: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m6.5 6.5 3.3 3.3m4.4 0 3.3-3.3m-11 11 3.3-3.3m4.4 0 3.3 3.3"/>',
    shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    settings: '<path d="m9 3-1 3-3 1-2 4 2 3v4l4 2 3-1 3 1 4-2v-4l2-3-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    book: '<path d="M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-7-2-10 1v15"/>',
    tray: '<path d="M4 15h4l2 3h4l2-3h4l-2-9H6Z"/><path d="M4 15v6h16v-6M12 2v9m-3-3 3 3 3-3"/>',
    play: '<path d="m8 4 12 8-12 8Z"/>',
    watch: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
    screenShare: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m0-7V7m-3 3 3-3 3 3"/>',
    music: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
    danmaku: '<rect x="3" y="4" width="18" height="15" rx="3"/><path d="M7 8h5m3 0h2M7 12h2m3 0h5M7 16h7"/>',
    chat: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z"/><path d="M8 11h.01m4 0h.01m4 0h.01"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    external: '<path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 4.3l-1.3 1.3"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.7l1.3-1.3"/>',
    cloud: '<path d="M6 19a5 5 0 1 1 0-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12Z"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m5-11h5m-5 11h5"/>',
    mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    refresh: '<path fill="currentColor" stroke="none" d="M3.1 10.75A9 9 0 0 1 18.9 6.2l1.9-1.9v6.45h-6.45l2.7-2.7A6.5 6.5 0 0 0 5.62 10.75Z"/><path fill="currentColor" stroke="none" transform="rotate(180 12 12)" d="M3.1 10.75A9 9 0 0 1 18.9 6.2l1.9-1.9v6.45h-6.45l2.7-2.7A6.5 6.5 0 0 0 5.62 10.75Z"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    folder: '<path d="M3 6h7l2 3h9v12H3Zm0 0V3h7l2 3h9v3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = selector => document.querySelector(selector);
  const titles = { overview: '服务总览', connect: '连接方式', frp: 'FRP 穿透', cert: '证书与域名', cli: '高画质代理', mesh: 'EasyTier 虚拟组网', logs: '运行日志', settings: '应用设置' };
  let prefs = { closeToTray: true, remember: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('zviewer-ui-prefs') || '{}') }; } catch { /* Use safe defaults if storage is unavailable. */ }
  const state = {
    page: 'overview', running: false, certReady: false, native: false, info: null,
    ipv6: null,
    frp: { host: '', port: 7000, voice: true, rtmp: true, tcp: false, webPort: 3333, voicePort: 3333, rtmpPort: 3334, tcpPort: 3337 },
    logLevel: 'all', logSource: 'all', logSearch: '', paused: false, cliDraft: null, cliEmbedUrl: '',
    meshDraft: null, meshSecretDraft: '', meshProbe: null,
    meshConfig: null, meshConfigDraft: null, meshConfigError: '', meshPreviewMode: 'form',
    events: [], prefs, updateOpen: false, updateKey: ''
  };
  function clock() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
  function addEvent(message, source = 'console', level = 'INFO') { state.events.unshift({ time: clock(), source, level, message }); state.events.length = Math.min(state.events.length, 100); }
  addEvent('控制台已就绪。');
  addEvent('HTTPS 使用 localhost。', 'cert');
  addEvent('FRP 模板已生成。', 'frp');
  function icons() { document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 4000); }
  function heading(title, subtitle, right = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${right ? `<div class="heading-actions">${right}</div>` : ''}</div>`; }

  // 页面内教程：按钮固定在标题右侧，展开后是按主题折叠的说明文档。
  const tutorials = {
    frp: {
      title: 'FRP 使用教程',
      caption: 'frps + frpc',
      sections: [
        {
          title: 'frp 是什么',
          body: '<p>frp 是反向代理工具，用于把没有公网 IP 的本机服务，经一台公网 VPS 转发到互联网。</p><p>VPS 上运行服务端 <code>frps</code>，本机运行客户端 <code>frpc</code>。</p>'
        },
        {
          title: '使用前需要什么',
          body: '<ul><li>一台有公网 IPv4 的 VPS，Linux 或 Windows 均可。</li><li>在 VPS 安全组与系统防火墙放行控制端口和各映射端口。</li><li>一串自行生成的随机密钥，两端保持一致，只放环境变量，不写进配置文件。</li><li>本机 ZViewer 服务已启动，默认监听 3333。</li></ul>'
        },
        {
          title: '怎么配置',
          body: '<ol><li>在 VPS 写 <code>frps.toml</code>：<code>bindPort</code> 填控制端口，<code>auth.token</code> 从环境变量读取，<code>transport.tls.force = true</code>。</li><li>放行端口：控制端口 TCP、网页 TCP、UDP 语音对应 UDP、RTMP TCP；改用 TCP 语音时再放行对应 TCP 端口。</li><li>在本页填写 VPS 地址与控制端口，勾选需要的映射，核对本地端口。</li><li>导出 <code>frpc.toml</code> 放到本机，设置环境变量 <code>FRP_TOKEN</code> 后启动 frpc。</li><li>状态变为“代理已注册”后，外网用 <code>VPS_IP:远端端口</code> 访问。</li></ol>'
        },
        {
          title: '官方资料',
          body: '<p>GitHub 仓库：<a href="https://github.com/fatedier/frp" data-external="https://github.com/fatedier/frp">github.com/fatedier/frp</a></p><p>官方文档：<a href="https://gofrp.org/zh-cn/docs/" data-external="https://gofrp.org/zh-cn/docs/">gofrp.org/zh-cn/docs</a></p>'
        }
      ]
    },
    mesh: {
      title: 'EasyTier 虚拟组网教程',
      caption: '虚拟 IP 直连',
      sections: [
        {
          title: '组网做什么',
          body: '<p>把本机接入一个虚拟局域网，网络内的设备可以直接用虚拟 IP 访问本机端口。</p><p>本机只提供访问，不会主动访问其他节点；朋友的设备装 EasyTier 客户端后加入同一网络即可。</p>'
        },
        {
          title: '开始前需要什么',
          body: '<ul><li>一组网络名称与网络密钥，与本网络内其他设备保持一致；点“生成新的网络名与密钥”会自动填好并保存。</li><li>一个对端地址，用来让双方互相发现。同一局域网里填对方的本机地址；双方都在 NAT 后面时需要一台双方都能连到的中转节点，用自己的 VPS 搭一台最稳。</li><li>不想自己搭中转时，用本页“公共对端服务器”卡片：先测可用性，再一键填入最快的一个社区节点。这些节点由社区维护，随时可能失效，也不保证速度。</li><li>组网监听端口默认 11010，与本机服务端口不冲突。</li></ul>'
        },
        {
          title: '怎么用',
          body: '<ol><li>点“生成新的网络名与密钥”，需要中转时填对端地址或点“填入最快节点”，保存并入网。</li><li>已有现成的 EasyTier 配置时，切到“配置文件”，粘贴或导入整份 TOML，再点“保存并入网”。</li><li>入网成功后本页显示虚拟 IP 与观看地址。</li><li>点“复制入网说明”，把网络名称与密钥发给朋友。</li><li>朋友在自己的设备上安装 EasyTier 客户端，用同样的网络名称与密钥加入，然后用虚拟 IP 打开本机网页。</li></ol>'
        },
        {
          title: '常见情况',
          body: '<ul><li>一直是“入网中”或“异常”：先确认组网端口没被占用，再确认对端地址能从本机连上。</li><li>朋友看不到本机：核对名称与密钥是否完全一致，以及对端地址是否双方都可达。</li><li>换一组网络名与密钥就等于换一个新网络，原来加入的设备需要重新加入。</li><li>配置文件里没有 <code>[[peer]]</code> 段时，节点只在本机监听，其他设备发现不了。</li><li>配置文件模式只接受 TOML；启动时写入 no_tun = true 与 bind_device = false，缺少 [flags] 段时自动追加。</li></ul>'
        }
      ],
      foot: '只有开着组网时其他设备才能按虚拟 IP 访问；停止组网后地址立即失效。'
    },
    cert: {
      title: '证书配置教程',
      caption: '本机自签 · 浏览器首次访问需手动继续',
      sections: [
        {
          title: '为什么要配置证书',
          body: '<p>浏览器会把 http 页面标记为不安全，麦克风、剪贴板、Service Worker 等能力只在安全上下文（https 或 localhost）下可用。</p><p>本控制台只为当前电脑签发 localhost 证书；局域网或公网设备访问需要另外准备证书与域名解析。</p>'
        },
        {
          title: '证书覆盖哪些地址',
          body: '<ul><li>只对 <code>localhost</code>、<code>127.0.0.1</code>、<code>::1</code> 生效，不包含内网 IP 与自定义域名。</li><li>不需要配置 DNS、hosts 或路由器。</li><li>私钥只留在当前用户配置目录。</li></ul>'
        },
        {
          title: '配置方法',
          body: '<ol><li>点击签发按钮生成 localhost 证书；已有有效证书时直接复用。</li><li>在应用设置里确认“使用 HTTPS”已开启，保存并重启服务。</li><li>打开管理页面，地址为 <code>https://localhost:3333</code>；浏览器首次会提示证书不受信任，选择“继续访问”即可。</li><li>需要 IPv6 直连时，在同一页探测本机 IPv6 后按该地址签发，再用 <code>https://[IPv6]:端口</code> 访问；监听范围需为所有地址。</li><li>其他设备访问时同样会提示，选择继续即可；需要消除提示只能在各自的设备上手动信任这份证书。</li></ol>'
        }
      ],
      foot: '证书只对本机回环地址有效；其他设备访问时需在该设备上手动信任这份证书。'
    },
    cli: {
      title: '高画质代理教程',
      caption: 'ZViewerCLI · 本机 127.0.0.1',
      sections: [
        {
          title: 'ZViewerCLI 是什么',
          body: '<p><code>ZViewerCLI</code> 是随桌面端附带的命令行代理程序，在本机监听一个 HTTP 端口，默认 <code>9333</code>。</p><p>网页端播放器通过它取到哔哩哔哩的高画质播放地址，再由本机转发给浏览器。</p>'
        },
        {
          title: '有什么作用',
          body: '<ul><li>让网页播放器使用更高清晰度，避开浏览器端的解析限制。</li><li>只监听 <code>127.0.0.1</code>，请求不经过第三方服务器。</li><li>登录态由 CLI 自己的设置页处理，桌面控制台不读取 Cookie。</li></ul>'
        },
        {
          title: '如何使用',
          body: '<ol><li>在本页点击“启动代理”，端口默认 9333，需与其他 TCP 服务错开。</li><li>在右侧内置设置中扫码登录哔哩哔哩账号。</li><li>确认后端地址（默认跟随本地服务），点击“连接服务器”。</li><li>回到网页端打开视频，在清晰度菜单中选择高画质。</li><li>需要随服务一起启动时，打开“随 ZViewer 服务启动”后保存。</li></ol>'
        }
      ],
      foot: '代理未启动时网页端仍可正常播放，只是清晰度受浏览器端限制。'
    },
    connect: {
      title: '连接方式教程',
      caption: '新手推荐 Cloudflare Tunnel',
      sections: [
        {
          title: '新手推荐：Cloudflare Tunnel',
          body: '<p>没有 VPS、也不想配置 FRP 的新手可以先用这项。点击“一键启动隧道”，桌面端会自动获取 cloudflared 并启动，不需要注册隧道账号或填写服务器地址、端口和密钥。</p><p>程序会把当前本机网页服务映射到 Cloudflare 提供的临时 <code>trycloudflare.com</code> 地址。停止或刷新隧道后旧地址失效；固定域名需要自己准备域名并配置 Cloudflare。</p>'
        },
        {
          title: 'IPv6 直连',
          body: '<p>运营商已下发公网 IPv6 时，外网设备直接用本机地址访问，不经过第三方中转。</p><p>页面给出带端口的完整地址，复制到浏览器即可打开。需在路由器与 Windows 防火墙放行该端口；运营商前缀变化后地址随之变化。</p>'
        },
        {
          title: '服务商 FRP',
          body: '<p>在樱花内网穿透、OpenFrp、cpolar、ngrok 这类服务商注册，拿到它分配的服务器地址、端口与密钥，填进本机 FRP 即可。客户端仍是标准 frpc，不用自己维护服务器。</p><p>访问域名、远端端口与带宽由服务商决定；免费节点的域名随机、速度受限，部分服务商需实名或付费才能用自定义域名。</p>'
        },
        {
          title: '自建 FRP',
          body: '<p>租一台有公网 IP 的 VPS，在上面运行服务端 frps，本机运行 frpc，两端用同一密钥认证。控制台可生成并导出本机的 frpc.toml。</p><p>端口、域名与带宽完全由自己安排，速度和稳定性取决于 VPS 线路；需要自行在安全组与系统防火墙放行映射端口，并自行运维服务器。</p>'
        },
        {
          title: '虚拟局域网',
          body: '<p>相关设备安装同一款虚拟局域网软件（ZeroTier、Tailscale、EasyTier 等），加入同一虚拟网络，再用分配的虚拟 IP 访问本机。</p><p>不向公网开放端口，网络外的设备无法访问；需要每个人都安装虚拟局域网软件。</p>'
        },
        {
          title: '怎么选',
          body: '<ul><li><strong>新手、没有 VPS</strong>：先试 Cloudflare Tunnel，一键启动临时地址，不用自己配服务器。</li><li><strong>已经有服务商账号</strong>：可以用服务商 FRP，按其说明填写地址、端口与密钥。</li><li><strong>有 VPS 且需要自主管理</strong>：用自建 FRP，自己维护服务端并放行端口。</li><li><strong>有公网 IPv6</strong>：可选 IPv6 直连，少一层中转，但要配置路由器与防火墙。</li><li><strong>访问者固定且不想开放公网</strong>：选择虚拟局域网，所有设备都要安装并加入同一网络。</li></ul>'
        }
      ],
      foot: '五种方式都要求本机 ZViewer 服务已启动；IPv6 与自建 FRP 还需在路由器、防火墙或安全组放行对应端口。'
    }
  };

  function tutorial(key) {
    const data = tutorials[key];
    if (!data) return '';
    const chevron = '<svg class="tutorial-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    const sections = data.sections.map((section, index) => {
      const open = index === 0;
      return `<section class="tutorial-section" data-open="${open}"><button type="button" class="tutorial-section-head" data-tutorial-section aria-expanded="${open}"><span class="tutorial-index">${index + 1}</span><span>${section.title}</span>${chevron}</button><div class="tutorial-section-body">${section.body}</div></section>`;
    }).join('');
    return `<div class="tutorial"><button type="button" class="tutorial-toggle" data-tutorial-toggle aria-expanded="false" aria-haspopup="true" aria-controls="tutorial-${key}">${icon('book')}教程<svg class="tutorial-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="tutorial-menu" id="tutorial-${key}" role="dialog" aria-label="${data.title}" hidden><div class="tutorial-head"><div><strong>${data.title}</strong><small>${data.caption}</small></div><button type="button" class="tutorial-close" data-tutorial-close aria-label="关闭教程"><span class="icon-glyph">&#xE8BB;</span></button></div><div class="tutorial-sections">${sections}</div>${data.foot ? `<p class="tutorial-foot">${data.foot}</p>` : ''}</div></div>`;
  }

  function closeTutorials() {
    document.querySelectorAll('.tutorial-toggle[aria-expanded="true"]').forEach(toggle => {
      toggle.setAttribute('aria-expanded', 'false');
      const menu = toggle.parentElement.querySelector('.tutorial-menu');
      if (menu) menu.hidden = true;
    });
  }

  function button(label, action, name, cls = '') { return `<button class="btn ${cls}" data-action="${action}">${name ? icon(name) : ''}${label}</button>`; }
  function notice(text, warm = false) { return `<div class="notice ${warm ? 'warm' : ''}">${icon('info')}<div>${text}</div></div>`; }
  function download(name, text, mime = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function modal(content) { $('#modal-content').innerHTML = content; $('#modal').showModal(); }
  // ---------- 软件更新 ----------
  // 检查与下载都在主进程完成；界面只读快照里的 update 状态，下载期间不退出程序。
  const updateLabels = { idle: '未检查', checking: '检查中', latest: '已是最新', available: '有新版', downloading: '下载中', ready: '待安装', error: '失败' };
  function updateReport() { return state.live ? state.server?.update || null : null; }
  function sizeText(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  }
  function updateBody(report) {
    const name = report?.state || 'idle';
    if (!state.live) return '仅桌面版可用。';
    if (name === 'checking') return '正在检查…';
    if (name === 'latest') return '已是最新版本。';
    if (name === 'available') return `发现新版本 v${esc(report.latest)}（${sizeText(report.size)}）。`;
    if (name === 'downloading') return `正在下载 v${esc(report.latest)} · ${report.progress}%`;
    if (name === 'ready') return `v${esc(report.latest)} 已下载完成，重启后安装。`;
    if (name === 'error') return esc(report?.error || '检查失败。');
    return '尚未检查。';
  }
  function updateActions(report) {
    const name = state.live ? report?.state || 'idle' : 'preview';
    if (name === 'downloading') return `<button class="btn" disabled>${icon('download')}下载中 ${report.progress}%</button>`;
    if (name === 'ready') return `${button('重启并安装', 'update-apply', 'refresh', 'primary')}${button('打开发布页', 'update-page', 'link')}`;
    if (name === 'available') return `${button('下载更新', 'update-download', 'download', 'primary')}${button('打开发布页', 'update-page', 'link')}`;
    return button(name === 'checking' ? '正在检查…' : '检查更新', 'update-check', 'refresh', 'primary');
  }
  function updateModal() {
    const report = updateReport();
    const name = state.live ? report?.state || 'idle' : 'preview';
    const tone = name === 'available' || name === 'ready' ? 'green' : name === 'error' ? 'red' : '';
    const current = state.info?.version || '0.1.0';
    const latest = report?.latest ? `v${report.latest}` : '—';
    const progress = name === 'downloading' ? `<div class="update-progress"><i style="width:${Math.min(100, Math.max(0, report.progress))}%"></i></div>` : '';
    const meta = report?.checkedAt ? `上次检查 ${esc(report.checkedAt)}` : '尚未检查';
    const auto = state.live ? Boolean(state.config?.autoCheckUpdate ?? report?.autoCheck) : true;
    const gitcode = state.live ? Boolean(state.config?.updateGitCode ?? true) : true;
    const source = report?.source || (gitcode ? 'gitcode' : 'github');
    const sourceText = source === 'gitcode' ? 'gitcode.com/Zero-wyc/ZViewer（大陆镜像）' : 'github.com/Zero-wyc/ZViewer';
    const proxy = state.live ? Boolean(state.config?.updateProxy ?? report?.proxy) : true;
    const proxyURL = state.config?.updateProxyUrl || report?.proxyUrl || 'https://gh-proxy.com';
    return `<div class="update-head"><div><h2>软件更新</h2><p>${sourceText}${report?.notes ? ` · ${esc(report.notes)}` : ''}</p></div><span class="pill ${tone}"><i></i>${updateLabels[name] || '未检查'}</span></div>
      <div class="update-grid"><div><span>当前版本</span><strong>v${esc(current)}</strong></div><div><span>最新版本</span><strong>${latest}</strong></div></div>
      <p class="update-state">${updateBody(report)}</p>${progress}
      <div class="modal-actions">${updateActions(report)}</div>
      <div class="switch-row update-auto"><div><strong>自动检查更新</strong><p>启动后检查一次，此后每 6 小时一次。</p></div><button class="switch" role="switch" aria-label="自动检查更新" aria-checked="${auto}" data-action="update-auto" ${state.live ? '' : 'disabled'}></button></div>
      <div class="switch-row update-source"><div><strong>使用 GitCode 更新源</strong><p>从大陆镜像下载，国内网络无需代理；不可用时直接报错，不自动换源。</p></div><button class="switch" role="switch" aria-label="使用 GitCode 更新源" aria-checked="${gitcode}" data-action="update-source" ${state.live ? '' : 'disabled'}></button></div>
      <div class="switch-row update-proxy"><div><strong>使用前置反代</strong><p>仅 GitHub 源生效；GitCode 源直连对象存储，不需要代理。</p></div><button class="switch" role="switch" aria-label="使用前置反代" aria-checked="${proxy}" data-action="update-proxy" ${state.live && source === 'github' ? '' : 'disabled'}></button></div>
      <div class="update-proxy-field"><input class="search-input" id="update-proxy-url" aria-label="反代前缀地址" value="${esc(proxyURL)}" placeholder="https://gh-proxy.com" spellcheck="false" ${state.live && source === 'github' && proxy ? '' : 'disabled'}></div>
      <p class="update-note">${icon('info')}<span>${meta}</span></p>`;
  }
  function openUpdate() {
    state.updateOpen = true; state.updateKey = '';
    modal(updateModal());
    const report = updateReport();
    if (state.live && (!report || report.state === 'idle')) updateCommand('update-check');
  }
  function syncUpdate(snapshot) {
    const report = snapshot?.update || null;
    const dot = $('#update-dot');
    if (dot) dot.hidden = !(report && report.available && report.state !== 'downloading');
    const key = report ? `${report.state}|${report.progress}|${report.latest}|${report.error}|${report.source}|${snapshot?.config?.autoCheckUpdate}|${snapshot?.config?.updateGitCode}|${snapshot?.config?.updateProxy}|${snapshot?.config?.updateProxyUrl}|${report.checkedAt}` : '';
    if (state.updateOpen && $('#modal')?.open && key !== state.updateKey) {
      state.updateKey = key;
      $('#modal-content').innerHTML = updateModal();
    }
  }
  async function updateCommand(name, payload) {
    if (!window.zviewerDesktop?.command) { toast('仅桌面版可用'); return null; }
    try { return await window.zviewerDesktop.command(name, payload || {}); }
    catch (error) { toast(String(error?.message || error).replace(/^.*Error: /, '')); return null; }
  }
  // 反代状态先本地对齐，避免等快照回来前说明文字仍显示旧地址。
  function patchUpdateProxy(enabled, url) {
    if (!state.server?.update) return;
    state.server.update.proxy = enabled;
    state.server.update.proxyUrl = enabled ? url : '';
  }
  // 反代地址变化后立即保存并重查一次，界面随后显示新链路是否可用。
  async function applyProxyURL(input) {
    if (!state.live) return;
    const fallback = state.config?.updateProxyUrl || 'https://gh-proxy.com';
    const url = input.value.trim();
    if (!url) { toast('反代地址不能为空'); input.value = fallback; return; }
    if (url === state.config?.updateProxyUrl) return;
    toast('正在重新检查…');
    const next = await updateCommand('update-proxy', { enabled: true, url });
    if (!next) { input.value = fallback; return; }
    state.config = { ...state.config, updateProxy: true, updateProxyUrl: url };
    patchUpdateProxy(true, url);
    state.updateKey = '';
    $('#modal-content').innerHTML = updateModal();
  }
  function setRunning(running, notify = true) {
    state.running = !!running;
    if (notify) window.zviewerDesktop?.demoState(state.running).catch(() => toast('托盘状态同步失败，请重新打开窗口。'));
    addEvent(state.running ? '演示状态已开启，未运行实际后端。' : '演示状态已停止。', 'backend');
    render();
    toast(state.running ? '已开启演示' : '演示已停止');
  }
  function activity() { return state.events.slice(0, 3).map(e => `<div class="activity"><span class="activity-dot"></span><div><strong>${esc(e.source === 'frp' ? '穿透配置' : e.source === 'cert' ? '本机 HTTPS' : e.source === 'backend' ? '演示状态' : e.source === 'tunnel' ? 'Cloudflare 隧道' : e.source === 'update' ? '软件更新' : '控制台')}</strong><p>${esc(e.message)}</p></div><time>${esc(e.time)}</time></div>`).join(''); }
  function overview() {
    const service = (name, subtitle, ico, color, status, left, right) => `<article class="service-card"><div class="service-top"><span class="icon-box ${color}">${icon(ico)}</span><span class="pill ${status.includes('演示') ? 'green' : ''}"><i></i>${status}</span></div><div><h3>${name}</h3><p>${subtitle}</p></div><div class="service-meta"><span>${left}</span><code>${right}</code></div></article>`;
    return heading('服务总览', '本机服务的运行状态。') +
      `<section class="hero"><div class="hero-copy"><h2>${state.running ? '演示运行中' : '服务未启动'}</h2><p>${state.running ? '界面演示，未连接真实后端。' : '启动后可访问网页端与管理页面。'}</p><div class="hero-actions">${button(state.running ? '停止演示' : '启动演示', 'toggle-run', state.running ? 'stop' : 'play', 'primary')}<button class="text-button" data-action="open-manager">打开管理页面 ${icon('external')}</button></div></div></section>` +
      `<div class="section-title"><h2>服务状态</h2><small>演示数据</small></div><div class="service-grid">${service('ZViewer 主服务', '网页与 API', 'server', 'orange', state.running ? '演示运行' : '未启动', '默认监听端口', ':3333 / TCP')}${service('语音与推流', '语音与 RTMP 推流', 'mic', 'green', state.running ? '演示待就绪' : '未启动', '默认语音 / 推流', ':3333 / :3334')}${service('高画质代理', 'ZViewerCLI 代理', 'terminal', '', '未启动', '本机代理端口', '127.0.0.1:9333')}</div>` +
      `<div class="bottom-grid"><section><div class="section-title"><h2>常用操作</h2><small>快捷入口</small></div><div class="setup-list"><button class="setup-row" data-nav="cert"><span class="step">${icon('lock')}</span><div><strong>签发本机 HTTPS 证书</strong><p>localhost</p></div>${icon('arrow')}</button><button class="setup-row" data-nav="connect"><span class="step">${icon('cloud')}</span><div><strong>新手推荐：Cloudflare Tunnel</strong><p>一键启动，无需额外配置</p></div>${icon('arrow')}</button><button class="setup-row" data-nav="settings"><span class="step">${icon('tray')}</span><div><strong>关闭到托盘</strong><p>在通知区域保留图标</p></div>${icon('arrow')}</button></div></section><section><div class="section-title"><h2>最近活动</h2><button class="text-button" data-nav="logs">全部日志 ${icon('arrow')}</button></div><div class="activity-list">${activity()}</div></section></div><div class="footnote">${icon('info')}服务、连接与证书操作均为演示。</div>`;
  }
  function validPort(value) { return /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535; }
  function validHost(value) {
    if (/^[\d.]+$/.test(value)) return value.split('.').length === 4 && value.split('.').every(v => /^\d{1,3}$/.test(v) && Number(v) <= 255);
    if (value.includes(':')) { try { return new URL(`http://[${value}]`).hostname.includes(':'); } catch { return false; } }
    return value.length <= 253 && value.split('.').every(v => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(v));
  }
  function frpError() {
    const c = state.frp;
    if (!c.host || !validHost(c.host)) return '请填写合法 VPS IP 或域名，不包含协议、路径与端口。';
    if (!validPort(c.port)) return '控制端口应为 1–65535 的整数。';
    const items = [['webPort', 'tcp'], ...(c.voice ? [['voicePort', 'udp']] : []), ...(c.rtmp ? [['rtmpPort', 'tcp']] : []), ...(c.tcp ? [['tcpPort', 'tcp']] : [])];
    if (items.some(([k]) => !validPort(c[k]))) return '远端端口应为 1–65535 的整数。';
    const ids = items.map(([k, proto]) => `${proto}:${Number(c[k])}`);
    if (new Set(ids).size !== ids.length) return '同一协议的远端端口存在冲突，请使用不同端口。';
    return '';
  }
  function frpConfig() {
    if (state.live && state.frpConfigOverride) return state.frpConfigOverride();
    const c = state.frp, token = 'auth.method = "token"\nauth.token = "{{ .Envs.FRP_TOKEN }}"';
    const proxy = (name, type, localPort, remotePort) => `\n[[proxies]]\nname = "zviewer-${name}"\ntype = "${type}"\nlocalIP = "127.0.0.1"\nlocalPort = ${localPort}\nremotePort = ${validPort(remotePort) ? Number(remotePort) : localPort}\n`;
    return `# 本机 frpc.toml · 部署前设置 FRP_TOKEN\n# 传输 TLS ≠ 浏览器 HTTPS\nserverAddr = ${JSON.stringify(c.host || 'YOUR_VPS_IP')}\nserverPort = ${validPort(c.port) ? Number(c.port) : 7000}\n${token}\ntransport.tls.enable = true\n${proxy('backend', 'tcp', 3333, c.webPort)}${c.voice ? proxy('voice', 'udp', 3333, c.voicePort) : ''}${c.rtmp ? proxy('rtmp', 'tcp', 3334, c.rtmpPort) : ''}${c.tcp ? proxy('voice-tcp', 'tcp', 3337, c.tcpPort) : ''}`;
  }
  function frp() {
    const c = state.frp;
    function row(title, field, type, local, remote, checked, fixed = false) { return `<div class="mapping"><label><input class="checkbox" type="checkbox" data-frp-check="${field}" ${checked ? 'checked' : ''} ${fixed ? 'disabled' : ''}>${title}</label><span class="proto">${type}</span><code>${local}</code><span class="muted">→</span><input aria-label="${title}远端端口" type="number" min="1" max="65535" data-frp-field="${remote}" value="${esc(c[remote])}"></div>`; }
    return heading('FRP 穿透', '把本机端口转发到公网服务器。', `${tutorial('frp')}<span class="pill orange"><i></i>未连接</span>`) +
      `<div class="form-layout"><section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('cloud')}</span><h2>FRP 服务器</h2></div><small>frps 节点</small></div><div class="form-row"><label class="field"><span>服务器地址 <small>VPS 或服务商</small></span><input id="frp-host" data-frp-field="host" value="${esc(c.host)}" placeholder="例如 frp.example.com" autocomplete="off" maxlength="253"></label><label class="field"><span>控制端口</span><input data-frp-field="port" aria-label="FRP 控制端口" type="number" value="${esc(c.port)}" min="1" max="65535"></label></div><label class="field"><span>认证密钥 <small>不保存明文</small></span><input id="frp-token" type="password" placeholder="与 VPS 上的 frps 保持一致" autocomplete="off"></label><span class="field-note">模板从环境变量 FRP_TOKEN 读取，页面不保存输入。</span><div class="panel-line"></div><div class="panel-heading no-margin"><h2>端口映射</h2><small>本地 → 公网 VPS</small></div><div class="mapping mapping-head"><span>服务</span><span>协议</span><span>本地</span><span></span><span>远端</span></div>${row('网页服务', 'web', 'TCP', 3333, 'webPort', true, true)}${row('UDP 语音', 'voice', 'UDP', 3333, 'voicePort', c.voice)}${row('RTMP 推流', 'rtmp', 'TCP', 3334, 'rtmpPort', c.rtmp)}${row('TCP 语音', 'tcp', 'TCP', 3337, 'tcpPort', c.tcp)}<div class="help-card"><strong>语音需单独放行</strong><p>UDP 语音要单独放行；改用 TCP 语音时管理端也要切换。</p></div><div class="validation" id="frp-error" role="alert"></div><div class="form-actions">${button('导出配置模板', 'export-frp', 'download', 'primary')}</div></section><section><div class="panel"><div class="panel-heading"><h2>配置预览</h2><span class="tag-caption">frpc.toml · 自动生成</span></div><pre class="codebox" id="frp-code">${esc(frpConfig())}</pre><div class="code-footer"><span>凭据使用环境变量占位</span><button class="text-button" data-action="copy-frp">${icon('copy')}复制</button></div><div class="path-flow"><div class="flow-item">${icon('globe')}外网设备</div><span>→</span><div class="flow-item">${icon('cloud')}VPS / frps</div><span>→</span><div class="flow-item">${icon('monitor')}本机 / frpc</div></div></div></section></div>`;
  }
  function certPreview() {
    return `<div class="certificate">${icon('shield')}<div class="eyebrow">证书预览</div><h3 id="cert-preview-domain">localhost</h3><p>本机访问<br>尚未签发</p></div><div class="meta-list"><div class="meta-line"><span>管理页面地址</span><span id="cert-preview-url">https://localhost:3333</span></div><div class="meta-line"><span>签发方式</span><span>本机自签</span></div><div class="meta-line"><span>证书 SAN</span><span>localhost / 127.0.0.1 / ::1 / 局域网 IP</span></div><div class="meta-line"><span>证书状态</span><span>${state.certReady ? '已演示' : '未签发'}</span></div></div><div class="check-item">${icon('check')}<div><strong>本机与局域网可用</strong></div></div><div class="check-item">${icon('lock')}<div><strong>私钥只保存在本机</strong><br>只导出公开证书。</div></div>`;
  }
  function cert() {
    // 演示地址：与真实探测结果同样呈现，便于验收 IPv6 区块的排版。
    const demoV6 = '2408:8207:2f1a:7c60::8a2e';
    const v6Block = `<div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('globe')}</span><h2>本机 IPv6</h2></div><span class="pill">演示地址</span></div><p class="wizard-copy">按本机 IPv6 地址签发证书，供 IPv6 直连访问。</p><div class="dns-example">https://[${demoV6}]:3333/admin</div><div class="check-item">${icon('globe')}<div><strong>1. 探测本机 IPv6</strong><br>${demoV6} · 演示地址</div></div><div class="check-item">${icon('lock')}<div><strong>2. 按该地址签发</strong><br>运行中的服务会重启。</div></div>${notice('监听范围需设为「所有地址 · IPv4 + IPv6」，其他设备才能经 IPv6 访问。')}<div class="live-toolbar">${button('探测本机 IPv6', 'probe-ipv6', 'globe')}${button('按 IPv6 签发并启用 HTTPS', 'ipv6-cert', 'lock', 'primary')}</div>`;
    const content = `${v6Block}<div class="panel-line"></div><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box orange">${icon('monitor')}</span><h2>本机 localhost</h2></div><span class="pill green">含局域网</span></div><p class="wizard-copy">为 localhost 与局域网地址签发证书并启用 HTTPS。</p><div class="dns-example">https://localhost:3333</div><div class="panel-line"></div><div class="check-item">${icon('check')}<div><strong>1. 检查并签发证书</strong></div></div><div class="check-item">${icon('external')}<div><strong>2. 打开管理页面</strong></div></div><div class="panel-line"></div>${notice('演示流程：不签发证书，浏览器会提示证书不受信任。')}<div class="form-actions">${state.certReady ? button('演示打开管理页面', 'open-manager', 'external') : ''}${button(state.certReady ? '重新演示' : '演示签发本机证书', 'local-cert', 'lock', 'primary')}</div>`;
    return heading('证书与域名', '签发 IPv6 或本机证书并启用 HTTPS。', tutorial('cert')) + `<div class="form-layout"><section class="panel">${content}</section><aside class="panel" id="cert-preview">${certPreview()}</aside></div>`;
  }
  function cli() {
    const live = Boolean(state.live), saved = state.config?.cli || { port: 9333, autoStart: false, user: '' };
    const c = { ...saved, ...state.cliDraft }, s = state.server?.cli || { state: 'stopped', available: false };
    const labels = { stopped: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' };
    const activePort = s.activePort || saved.port, running = ['starting', 'running', 'stopping'].includes(s.state);
    const backend = state.server?.active || state.config || { https: false, port: 3333 };
    const backendUrl = state.server?.webUrl || `${backend.https ? 'https' : 'http'}://localhost:${backend.port || 3333}/`;
    const status = live ? labels[s.state] || '未启动' : '界面预览';
    return heading('高画质代理', '内置 ZViewerCLI，为哔哩哔哩高画质播放提供代理。', tutorial('cli')) +
      `<div class="cli-layout"><section class="panel cli-settings"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('watch')}</span><div><h2>ZViewerCLI</h2><p class="cli-caption">哔哩哔哩高画质代理</p></div></div><span class="pill ${s.state === 'running' && live ? 'green' : ''}"><i></i>${esc(status)}</span></div>
        <p class="cli-copy">右侧扫码登录并连接服务器。</p>
        <div class="cli-address"><span>${icon('monitor')}仅本机访问</span><code>http://127.0.0.1:${esc(activePort)}</code></div>
        ${live ? `<p class="cli-binding-status">${icon(s.connected ? 'check' : 'info')}${s.connected ? '已关联服务器' : s.state === 'running' ? '未关联服务器' : '启动后关联服务器'}</p>` : ''}
        <div class="cli-actions">${button(running ? '停止代理' : '启动代理', running ? 'cli-stop' : 'cli-start', running ? 'stop' : 'play', 'primary')}</div>
        <div class="panel-line"></div><div class="settings-subheading"><h3>代理配置</h3><span>下次启动生效</span></div>
        <label class="field"><span>后端地址 · 自动跟随本地服务</span><input id="cli-backend-url" type="text" value="${esc(backendUrl)}" readonly autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>ZViewer 网页账号（可选）</span><input id="cli-user" type="text" maxlength="120" value="${esc(c.user || '')}" placeholder="可选，与网页端登录账号一致" autocomplete="off"></label>
        <label class="field cli-port-field"><span>代理监听端口</span><input id="cli-port" type="number" min="1" max="65535" value="${esc(c.port)}"></label>
        <div class="switch-row cli-auto-row"><div><strong id="cli-auto-title">随 ZViewer 服务启动</strong></div><button type="button" id="cli-auto-start" class="switch" role="switch" aria-labelledby="cli-auto-title" aria-checked="${Boolean(c.autoStart)}"></button></div>
        <div class="form-actions">${button('保存代理配置', 'cli-save', 'check', 'primary')}</div>
        <p class="cli-config-note">Cookie 由内置 ZViewerCLI 管理。</p>
      </section><section class="panel cli-embed-panel"><div class="cli-embed-heading"><div><h2>内置代理设置</h2></div><span class="pill">${icon('lock')}本机</span></div>
        ${live && state.cliEmbedUrl ? `<iframe id="cli-settings-frame" src="${esc(state.cliEmbedUrl)}" title="ZViewerCLI 设置" sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer"></iframe>` : `<div class="cli-embed-placeholder"><span class="cli-placeholder-icon">${icon('settings')}</span><h3>${live ? '在控制台内完成配置' : '内置设置预览'}</h3><p>${!live ? '仅桌面版可用。' : !s.available ? '未检测到内置 CLI，请使用包含 ZViewerCLI 的完整运行包。' : s.state === 'running' ? '正在载入设置…' : '启动代理后在此处配置。'}</p></div>`}
        <div class="cli-embed-hint">启动代理 → 扫码登录 → 连接服务器</div>
      </section></div>`;
  }
  // EasyTier 虚拟组网：本机按 EasyTier 协议入网，外部设备用虚拟 IP 访问本机端口。
  // 免账号、免管理员（no_tun），所以面板只暴露网络名称、密钥、对端地址与监听端口。
  // 不内置任何公共节点：EasyTier 官方公共节点已停服，域名解析不到，
  // 中转地址一律由用户填自己的 VPS；同一局域网内直接填对方的本机地址即可。
  // 公共中继候选（预览版副本，真实列表来自 controller/mesh_public.go 的快照下发）。
  const MESH_PUBLIC_PEERS = ['tcp://ros.scpsl.com.cn:11010', 'tcp://et.basd1.de:11010', 'tcp://183.230.36.171:11010', 'tcp://225284.xyz:11010', 'tcp://us01.225284.xyz:11010', 'tcp://easytier.weiai.org.cn:11010'];
  // 组网与 FRP 一样有两种配置来源：图形配置生成 TOML，或直接运行整份 EasyTier 配置。
  const MESH_CONFIG_PLACEHOLDER = [
    'instance_id = &quot;留空会自动生成&quot;',
    'hostname = &quot;my-pc&quot;',
    'dhcp = true',
    'listeners = [',
    '    &quot;tcp://0.0.0.0:11010&quot;,',
    '    &quot;udp://0.0.0.0:11010&quot;',
    ']',
    '',
    '[network_identity]',
    'network_name = &quot;zviewer-home&quot;',
    'network_secret = &quot;你的网络密钥&quot;',
    '',
    '[[peer]]',
    'uri = &quot;tcp://1.2.3.4:11010&quot;',
    '',
    '[flags]',
    'no_tun = true',
    'bind_device = false'
  ].join('&#10;');
  function meshMode() {
    const value = state.live ? state.config?.mesh?.mode : state.meshPreviewMode;
    return value === 'config' ? 'config' : 'form';
  }
  function meshFileContent() { return state.meshConfigDraft ?? state.meshConfig?.content ?? ''; }
  let meshConfigPending = false;
  // 自定义配置在页面打开时读一次；读到后重绘，编辑框就不会闪成空白。
  function ensureMeshConfig() {
    if (!state.live || state.meshConfig || meshConfigPending) return;
    if (!window.zviewerDesktop?.command) return;
    meshConfigPending = true;
    window.zviewerDesktop.command('mesh-config', {})
      .then(data => { state.meshConfig = data; if (state.page === 'mesh') render(); })
      .catch(error => toast(String(error?.message || error).replace(/^.*Error: /, '')))
      .finally(() => { meshConfigPending = false; });
  }
  function mesh() {
    const live = Boolean(state.live), meshLabels = { stopped: '未入网', starting: '入网中', running: '已入网', stopping: '正在退出', error: '异常' };
    const saved = state.config?.mesh || { enabled: false, networkName: '', peers: [], listenPort: 11010 };
    const m = state.server?.mesh || { state: 'stopped', available: true, peers: [], virtualIp: '', message: '' };
    const draft = state.meshDraft || {};
    const c = { ...saved, ...draft };
    const running = ['starting', 'running'].includes(m.state);
    const online = m.state === 'running' && Boolean(m.virtualIp);
    // DHCP 要等有对端接入才分配地址，所以「运行中但没有虚拟 IP」是正常中间状态。
    const waiting = m.state === 'running' && !online;
    const lanPeers = Array.isArray(m.lanPeers) ? m.lanPeers : [];
    const server = state.server?.active || state.config || { https: false, port: 3333 };
    const access = online ? `${server.https ? 'https' : 'http'}://${m.virtualIp}:${server.port}/` : '';
    const peers = m.peers || [];
    // 「在线设备」只数其他设备：本机也会出现在对端列表里，算进去会永远多一台。
    const remotePeers = peers.filter(peer => !peer.self);
    const status = live ? meshLabels[m.state] || '未入网' : '界面预览';
    const secretValue = state.meshSecretDraft || '';
    const peerCard = peer => {
      const meta = [peer.ipv4, peer.latency && peer.latency !== '-' ? `${peer.latency} ms` : ''].filter(Boolean).join(' · ');
      const route = peer.self ? '' : peer.direct ? '直连' : '中继';
      return `<article class="mesh-device${peer.self ? ' is-self' : ''}"><span class="mesh-device-icon">${icon(peer.self ? 'monitor' : 'server')}</span><div class="mesh-device-body"><strong>${esc(peer.hostname || peer.ipv4)}${peer.self ? '<span class="mesh-device-tag">本机</span>' : ''}</strong><span class="mesh-device-meta">${esc(meta)}</span></div>${route ? `<span class="pill ${peer.direct ? 'green' : ''}"><i></i>${route}</span>` : ''}</article>`;
    };
    const emptyPeers = `<div class="empty">还没有其他设备加入。把网络名称与密钥发给朋友，他们装 EasyTier 客户端加入后就会出现在这里。</div>`;
    // 公共中继候选：真实列表由 Go 快照下发（controller/mesh_public.go）；预览版用同一份副本，
    // 保证两套界面一致。这里只做展示，「填入」要等用户点击后才会写进对端地址。
    const publicPeers = live ? (Array.isArray(m.publicPeers) ? m.publicPeers : []) : MESH_PUBLIC_PEERS;
    const probe = state.meshProbe || { running: false, at: '', results: {} };
    const probeResults = probe.results || {};
    const reachable = publicPeers.filter(uri => probeResults[uri]?.state === 'ok').length;
    const probeSummary = probe.running ? '测试中' : !probe.at ? `${publicPeers.length} 个候选` : `${reachable}/${publicPeers.length} 可连接`;
    const probeTone = probe.running || !probe.at ? '' : reachable ? 'green' : 'orange';
    const publicRow = uri => {
      const item = probeResults[uri];
      const label = probe.running ? '测试中…'
        : !item ? '未测试'
          : item.state === 'ok' ? `${item.latencyMs} ms`
            : item.state === 'unknown' ? '未测试' : `连不上 · ${item.reason || '无法连接'}`;
      const tone = probe.running || !item ? '' : item.state === 'ok' ? 'green' : item.state === 'unknown' ? '' : 'orange';
      return `<div class="mesh-public-row"><code>${esc(uri)}</code><span class="pill ${tone}"><i></i>${esc(label)}</span></div>`;
    };
    const mode = meshMode();
    if (mode === 'config') ensureMeshConfig();
    const conf = state.meshConfig || null;
    const tabs = `<div class="tabs mesh-mode"><button data-mesh-mode="form" class="${mode === 'form' ? 'active' : ''}">图形配置</button><button data-mesh-mode="config" class="${mode === 'config' ? 'active' : ''}">配置文件</button></div>`;
    const formBody = `<div class="form-layout"><section class="panel">
        <div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('mesh')}</span><div><h2>入网参数</h2><p class="cli-caption">免账号 · 免管理员权限</p></div></div><span class="pill ${online && live ? 'green' : ''}"><i></i>${esc(status)}</span></div>
        <div class="form-row"><label class="field"><span>网络名称</span><input id="mesh-name" value="${esc(c.networkName || '')}" placeholder="zviewer-home" autocomplete="off" spellcheck="false" maxlength="32"></label><label class="field"><span>组网监听端口 <small>EasyTier 节点间通信</small></span><input id="mesh-port" type="number" min="1" max="65535" value="${esc(c.listenPort || 11010)}"></label></div>
        <label class="field"><span>网络密钥 <small>加密保存</small></span><input id="mesh-secret" type="password" value="${esc(secretValue)}" placeholder="${state.server?.meshSecretSaved ? '已保存，留空沿用' : '与本网络其他设备一致'}" autocomplete="off"></label>
        <label class="field"><span>对端地址 <small>填一个即可，可留空</small></span><textarea id="mesh-peers" class="codebox config-editor mesh-peers-editor" spellcheck="false" autocomplete="off" placeholder="tcp://1.2.3.4:11010">${esc((c.peers || []).join('\n'))}</textarea></label>
        <span class="field-note">同一局域网里填对方的本机地址即可；双方都在 NAT 后面时，需要一台双方都能连到的中转节点，填自己的 VPS 地址。对端地址只负责首次发现，填一个能连上的就够。</span>
        <div class="validation" id="mesh-error" role="alert">${esc(m.message || '')}</div>
        <div class="form-actions">${button('保存','mesh-save','check')}${button('生成新的网络名与密钥','mesh-generate','refresh')}${button(running ? '停止组网' : '保存并入网','mesh-toggle','mesh','primary')}</div>
      </section>
      <aside class="panel"><div class="panel-heading"><h2>本机地址</h2></div>
        <p class="connect-value ${access ? '' : 'is-empty'}">${access ? `<code>${esc(access)}</code>` : waiting ? '等待设备接入' : '尚未入网'}</p>
        <div class="meta-list"><div class="meta-line"><span>虚拟 IP</span><span>${esc(m.virtualIp || '—')}</span></div><div class="meta-line"><span>组网端口</span><span>${esc(saved.listenPort || 11010)}</span></div><div class="meta-line"><span>网页端口</span><span>${esc(server.port || 3333)}</span></div><div class="meta-line"><span>在线设备</span><span>${remotePeers.length ? `${remotePeers.length} 台` : '—'}</span></div><div class="meta-line"><span>自动入网</span><span>${saved.enabled ? '已开启' : '已关闭'}</span></div>${m.version ? `<div class="meta-line"><span>组网版本</span><span>${esc(m.version)}</span></div>` : ''}</div>
        ${waiting && lanPeers.length ? `<div class="check-item">${icon('link')}<div><strong>让对方先连本机</strong><br>把 <code>${esc(lanPeers[0])}</code> 填进对方客户端的「对端地址」。</div></div>` : ''}
        <div class="live-toolbar">${access ? `<button class="btn" data-copy="${esc(access)}">${icon('copy')}复制观看地址</button>` : ''}${m.state === 'running' ? button('复制入网说明','mesh-invite','copy') : ''}</div>
        ${m.available === false ? notice('当前运行包不含组网组件，请使用完整安装包。') : notice('本机不需要管理员权限；朋友的设备装 EasyTier 客户端后按同样的网络名称与密钥加入。')}
      </aside></div>
      <section class="panel mesh-public-panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('globe')}</span><div><h2>公共对端服务器</h2><p class="cli-caption">社区维护 · 随时可能失效</p></div></div><span class="pill ${probeTone}"><i></i>${esc(probeSummary)}</span></div>
        <div class="mesh-public-list">${publicPeers.map(publicRow).join('') || '<div class="empty">没有可用的候选节点。</div>'}</div>
        <div class="form-actions">${button(probe.at ? '重新测试' : '测试可用性', 'mesh-probe', 'refresh')}${button('填入最快节点', 'mesh-fill', 'check', 'primary')}</div>
        <p class="field-note">${probe.at ? `上次测试 ${esc(probe.at)} · ` : ''}「填入最快节点」会先重测一遍，只把延迟最低的那个写进对端地址；连上一个节点就能发现整个网络，需要冗余再手动加一行。</p>
      </section>`;
    const fileBody = `<div class="form-layout"><section class="panel">
        <div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('terminal')}</span><div><h2>EasyTier 配置文件</h2><p class="cli-caption">TOML · 原样运行</p></div></div><span class="pill ${online && live ? 'green' : ''}"><i></i>${esc(status)}</span></div>
        <p class="wizard-copy">粘贴或导入完整的 EasyTier 配置，保存后按它入网。</p>
        <textarea class="codebox config-editor mesh-config-editor" id="mesh-config-editor" spellcheck="false" autocomplete="off" aria-label="EasyTier 配置文件内容" placeholder="${MESH_CONFIG_PLACEHOLDER}">${esc(meshFileContent())}</textarea>
        <div class="code-footer"><span>${conf?.path ? '保存位置 ' + esc(conf.path) : '尚未保存'}</span><span>TOML</span></div>
        <div class="validation" id="mesh-error" role="alert">${esc(state.meshConfigError || m.message || '')}</div>
        <div class="form-actions">${button('导入文件','mesh-config-import','folder')}${button('按图形配置填充','mesh-config-template','refresh')}${button('保存','mesh-config-save','check')}${button(running ? '停止组网' : '保存并入网','mesh-config-connect','mesh','primary')}</div>
      </section>
      <aside class="panel"><div class="panel-heading"><h2>使用说明</h2></div>
        <div class="check-item">${icon('terminal')}<div><strong>直接粘贴</strong><br>整份 TOML 粘进编辑框，保存后按文件里的网络名称、密钥与对端地址加入。</div></div>
        <div class="check-item">${icon('folder')}<div><strong>导入文件</strong><br>从磁盘选一份 .toml，内容读入编辑框，可以再改。</div></div>
        <div class="check-item">${icon('shield')}<div><strong>自动补 flags</strong><br>启动时写入 no_tun = true 与 bind_device = false；没有 [flags] 段时会补上。</div></div>
        <div class="check-item">${icon('info')}<div><strong>只接受 TOML</strong><br>其他格式无法保存。</div></div>
        <div class="panel-line"></div>
        <div class="meta-list"><div class="meta-line"><span>虚拟 IP</span><span>${esc(m.virtualIp || '—')}</span></div><div class="meta-line"><span>在线设备</span><span>${remotePeers.length ? `${remotePeers.length} 台` : '—'}</span></div><div class="meta-line"><span>自动入网</span><span>${saved.enabled ? '已开启' : '已关闭'}</span></div></div>
        <div class="live-toolbar">${access ? `<button class="btn" data-copy="${esc(access)}">${icon('copy')}复制观看地址</button>` : ''}${m.state === 'running' ? button('复制入网说明','mesh-invite','copy') : ''}</div>
        <p class="field-note">对端地址写在 <code>[[peer]]</code> 段的 <code>uri</code> 里，一行一个，可写多条；想用公共对端卡片测速填入，切到“图形配置”页。</p>
      </aside></div>`;
    return heading('EasyTier 虚拟组网', '把本机加入虚拟局域网，外部设备按虚拟 IP 访问。', tutorial('mesh')) + tabs + (mode === 'config' ? fileBody : formBody) +
      `<section class="panel mesh-devices-panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('mesh')}</span><div><h2>在线设备</h2><p class="cli-caption">同一网络内的 EasyTier 节点</p></div></div><span class="pill ${remotePeers.length ? 'green' : ''}"><i></i>${remotePeers.length ? `${remotePeers.length} 台` : '等待加入'}</span></div>${peers.length ? `<div class="mesh-device-grid">${peers.map(peerCard).join('')}</div>` : emptyPeers}</section>`;
  }
  const connectLinks = {
    frpProvider: [      ['樱花内网穿透', 'natfrp.com', 'https://www.natfrp.com/'],
      ['OpenFrp', 'openfrp.net', 'https://www.openfrp.net/'],
      ['cpolar', 'cpolar.com', 'https://www.cpolar.com/'],
      ['ngrok', 'ngrok.com', 'https://ngrok.com/']
    ],
    frpSelf: [
      ['frp 下载', 'github.com/fatedier/frp', 'https://github.com/fatedier/frp/releases'],
      ['frp 官方文档', 'gofrp.org', 'https://gofrp.org/zh-cn/docs/']
    ],
    tunnel: [
      ['Cloudflare 文档', 'developers.cloudflare.com', 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/']
    ]
  };
  function linkList(items) {
    return `<div class="link-list">${items.map(([name, host, url]) => `<a href="${esc(url)}" data-external="${esc(url)}" rel="noreferrer"><span>${esc(name)}</span><small>${esc(host)}</small><span class="link-arrow">↗</span></a>`).join('')}</div>`;
  }
  function connectCard(options) {
    const { name, color = '', title, copy, status, tone = '', body, actions = '' } = options;
    return `<article class="connect-card"><div class="connect-head"><span class="icon-box ${color}">${icon(name)}</span><div class="connect-title"><h2>${title}</h2><p>${copy}</p></div><span class="pill ${tone}"><i></i>${status}</span></div><div class="connect-body">${body}</div>${actions ? `<div class="connect-actions">${actions}</div>` : ''}</article>`;
  }
  function connect() {
    const live = Boolean(state.live), v6 = state.ipv6;
    const config = live ? state.server?.active || state.config || {} : {};
    const port = config.port || 3333;
    // 外部接口只证明 IPv6 出口，不能证明本机端口可从公网访问。
    const v6Url = v6?.ok ? `${config.https ? 'https' : 'http'}://[${v6.address}]:${port}/` : '';
    const v6Listening = config.bindHost === '::';
    const v6ServiceRunning = live && state.server?.backend === 'running';
    const v6CopyReady = Boolean(v6?.ok && v6Listening && v6ServiceRunning);
    const v6Note = !v6Listening ? '当前服务未监听 IPv6，外部设备无法访问。请在应用设置把监听范围改为「所有地址 · IPv4 + IPv6」，保存后重启服务。' : !v6ServiceRunning ? '主服务尚未运行，请先启动服务。' : `已检测到 IPv6 出口；此地址仍需从外网验证。路由器与 Windows 防火墙需允许入站 ${port} 端口，HTTPS 还需在证书页按 IPv6 地址签发证书。`;
    const v6Body = (!v6
      ? `<p class="connect-value is-empty">未检测</p><p class="connect-note">正在通过外部接口检测。</p>`
      : v6.ok
        ? `<p class="connect-value"><code>${esc(v6Url)}</code></p><p class="connect-note">${esc(v6Note)}</p>`
        : `<p class="connect-value is-empty">没有</p><p class="connect-note">${esc(v6.reason || '没有探测到公网 IPv6。')}</p>`) +
      `<p class="connect-hint">如果你有 IPv4 公网地址，那么应该不需要我教你其他的了。</p>`;
    const v6Actions = `${button(v6 ? '重新检测' : '检测 IPv6', 'probe-ipv6', 'refresh')}${v6CopyReady ? `<button class="btn" data-copy="${esc(v6Url)}">${icon('copy')}复制候选地址</button>` : v6?.ok ? `<button class="btn primary" data-nav="settings">${icon('settings')}配置监听范围</button>` : ''}`;

    // EasyTier 虚拟组网卡片：入网后直接给出虚拟 IP 的访问地址，未入网时说清下一步动作。
    const meshReport = live ? state.server?.mesh : null;
    const meshOnline = meshReport?.state === 'running' && Boolean(meshReport?.virtualIp);
    const meshWaiting = meshReport?.state === 'running' && !meshOnline;
    const meshUrl = meshOnline ? `${config.https ? 'https' : 'http'}://${meshReport.virtualIp}:${port}/` : '';
    const meshStatus = !live ? '免账号' : meshOnline ? '已入网' : meshWaiting ? '等待接入' : meshReport?.state === 'starting' ? '入网中' : meshReport?.available === false ? '缺少组件' : '未入网';
    const meshLan = Array.isArray(meshReport?.lanPeers) ? meshReport.lanPeers[0] : '';
    const meshBody = meshUrl
      ? `<p class="connect-value"><code>${esc(meshUrl)}</code></p><p class="connect-note">其他设备加入同一网络后，用这个地址访问本机。</p>`
      : meshWaiting
        ? `<p class="connect-value is-empty">等待设备接入</p><p class="connect-note">${meshLan ? `把 <code>${esc(meshLan)}</code> 填进对方客户端的「对端地址」即可。` : '有其他设备接入后自动分配虚拟 IP。'}</p>`
        : `<p class="connect-value is-empty">${esc(meshReport?.message || (live ? '未入网' : '免账号、免管理员'))}</p><p class="connect-note">本机的服务不需要公网 IP，其他设备加入同一虚拟网络后按虚拟 IP 访问。</p>`;

    const frpState = live ? state.server.frp : '';
    const frpLabels = { registered: '已连通', connecting: '连接中', error: '异常' };
    // 服务商节点与自建服务器共用同一个本机 frpc，状态标签前加 frpc 前缀，避免两张卡片看起来各连一条。
    const frpStatus = live ? `frpc ${frpLabels[frpState] || '未连接'}` : '';

    const tunnel = live ? state.server.tunnel : null;
    const tunnelLabels = { stopped: '未运行', checking: '检查更新', downloading: '下载中', connecting: '连接中', refreshing: '自动刷新', reconnecting: '原地址重连中', 'health-checking': '健康检测', stopping: '停止中', error: '异常' };
    const tunnelStarting = ['checking', 'downloading', 'connecting', 'refreshing', 'health-checking'].includes(tunnel?.state);
    const tunnelStatus = tunnelStarting ? tunnelLabels[tunnel.state] : !tunnel || !tunnel.available ? tunnel?.state === 'error' ? '启动失败' : '一键启动' : tunnel.state === 'running' && tunnel.health !== 'degraded' ? '已连通' : tunnelLabels[tunnel.state] || '未运行';
    const tunnelStopping = tunnel?.state === 'stopping';
    const tunnelCanStop = Boolean(tunnel) && ['running', 'reconnecting'].includes(tunnel.state);
    let tunnelBody;
    if (!tunnel) {
      tunnelBody = `<p class="connect-value is-empty">桌面版中可用</p><p class="connect-note">不需要公网 IP；地址随隧道关闭失效。固定域名需外国银行卡。</p>`;
    } else if (!tunnel.available) {
      tunnelBody = `<p class="connect-value is-empty">${tunnel.state === 'health-checking' ? '正在检查本机服务' : tunnel.state === 'downloading' ? '正在获取 cloudflared' : tunnel.state === 'error' ? '启动条件未通过' : '首次使用时自动下载'}</p><p class="connect-note">${esc(tunnel.message || '点击一键启动，程序会从 Cloudflare 官方 GitHub 获取组件并启动临时隧道。')}</p>`;
    } else if (tunnel.url) {
      tunnelBody = `<p class="connect-value"><code>${esc(tunnel.url)}</code></p><p class="connect-note">${tunnel.health === 'degraded' ? esc(tunnel.message) : `启动检查通过 · ${Number(tunnel.latencyMs || 0)} ms · HTTP/2。运行中保持当前地址。`}</p>`;
    } else {
      tunnelBody = `<p class="connect-value is-empty">${tunnelLabels[tunnel.state] || '未运行'}</p><p class="connect-note">${esc(tunnel.message || (tunnel.state === 'error' ? '隧道已退出。' : '启动后检查本机源站与公网访问，检查通过才显示地址。'))}</p>`;
    }
    const tunnelActions = tunnelStarting
      ? `<button class="btn primary tunnel-primary" type="button" disabled>${icon('refresh')}${esc(tunnelLabels[tunnel.state])}…${Number(tunnel.refreshCount || 0) ? `（刷新 ${Number(tunnel.refreshCount)}/5）` : ''}</button>${button(Number(tunnel.refreshCount || 0) ? '中断自动刷新' : '中断启动', 'tunnel-stop', 'stop', 'danger')}`
      : tunnelStopping
        ? `<button class="btn danger" type="button" disabled>${icon('stop')}正在停止隧道…</button>`
        : `${button(tunnelCanStop ? '停止隧道' : !tunnel?.available ? '一键启动隧道' : '启动隧道', tunnelCanStop ? 'tunnel-stop' : 'tunnel-start', tunnelCanStop ? 'stop' : 'cloud', tunnelCanStop ? 'danger' : 'primary tunnel-primary')}${tunnel.url ? `<button class="btn" data-copy="${esc(tunnel.url)}">${icon('copy')}复制地址</button>${button('刷新隧道', 'tunnel-refresh', 'refresh')}` : ''}`;

    return heading('连接方式', '新手推荐 Cloudflare Tunnel：无需 VPS，一键下载并启动；其他方式可按需选择。', tutorial('connect')) +
      `<div class="connect-grid">${
        connectCard({
          name: 'cloud', title: 'Cloudflare Tunnel · 新手推荐', copy: '一键启动，无需额外配置。',
          status: tunnelStatus, tone: tunnel?.state === 'running' ? 'green' : '',
          body: tunnelBody + linkList(connectLinks.tunnel), actions: tunnelActions
        })
      }${
        connectCard({
          name: 'globe', color: 'orange', title: 'IPv6 直连', copy: '运营商下发公网 IPv6 时，外网设备直接访问该地址。',
          status: !v6 ? '未检测' : !v6.ok ? '没有' : !v6Listening ? '未监听 IPv6' : !v6ServiceRunning ? '服务未运行' : '待外网验证', tone: '',
          body: v6Body, actions: v6Actions
        })
      }${
        connectCard({
          name: 'network', title: '服务商 FRP', copy: '用服务商提供的公网节点做内网穿透，注册即用。',
          status: live ? frpStatus : '需注册', tone: frpState === 'registered' ? 'green' : '',
          body: `<p class="connect-note">注册后把服务商给的地址、端口与密钥填进本机 FRP。带宽与域名由服务商决定，免费节点通常限速。</p>${linkList(connectLinks.frpProvider)}`
        })
      }${
        connectCard({
          name: 'server', title: '自建 FRP', copy: '在自己的 VPS 上运行 frps，端口与带宽完全自管。',
          status: live ? frpStatus : '需 VPS', tone: frpState === 'registered' ? 'green' : '',
          body: `<p class="connect-note">自己的 VPS 运行 frps，端口与带宽自管，需自行放行映射端口。</p>${linkList(connectLinks.frpSelf)}`,
          actions: `<button class="btn primary" data-nav="frp">${icon('arrow')}配置本机 FRP</button>`
        })
      }${
        connectCard({
          name: 'mesh', title: 'EasyTier 虚拟组网', copy: '本机直接加入虚拟局域网，外部设备按虚拟 IP 访问。',
          status: meshStatus, tone: meshOnline ? 'green' : '',
          body: meshBody,
          actions: `<button class="btn primary" data-nav="mesh">${icon('arrow')}配置 EasyTier</button>`
        })
      }</div>` +
      `<div class="footnote">${icon('info')}没有公网 IPv4 时，后四种方式都能中转；同时只用一条入口。</div>`;
  }
  function filteredEvents() { return state.events.filter(e => (state.logLevel === 'all' || e.level === state.logLevel) && (state.logSource === 'all' || e.source === state.logSource) && `${e.message} ${e.source}`.toLowerCase().includes(state.logSearch.toLowerCase())); }
  function logLines() { return filteredEvents().map(e => `<div class="log-line"><span class="log-time">${esc(e.time)}</span><span class="log-level ${e.level}">${esc(e.level)}</span><span class="log-source">${esc(e.source)}</span><span class="log-message">${esc(e.message)}</span></div>`).join('') || '<div class="empty">没有匹配的日志</div>'; }
  function logs() {
    return heading('运行日志', '控制台与各服务的运行记录。', button('导出日志', 'export-logs', 'download')) + `<section class="panel"><div class="log-toolbar"><input class="search-input" id="log-search" aria-label="搜索日志" placeholder="搜索日志内容…" value="${esc(state.logSearch)}"><select id="log-source" aria-label="服务筛选"><option value="all">全部服务</option>${['console', 'backend', 'voice', 'cert', 'frp', 'tunnel', 'cli', 'update'].map(s => `<option ${s === state.logSource ? 'selected' : ''}>${s}</option>`).join('')}</select><select id="log-level" aria-label="日志级别"><option value="all">全部级别</option><option ${state.logLevel === 'INFO' ? 'selected' : ''}>INFO</option><option ${state.logLevel === 'WARN' ? 'selected' : ''}>WARN</option></select>${button(state.paused ? '继续显示' : '暂停显示', 'pause-logs', state.paused ? 'play' : 'pause')}</div><div class="log-view" id="log-lines">${logLines()}</div><div class="code-footer"><span id="log-count">${filteredEvents().length} 条${state.paused ? ' · 已暂停' : ''}</span><span class="log-caption">${icon('info')}演示数据</span></div></section>`;
  }
  function settings() {
    const info = state.info?.runtime;
    function toggle(key, title, text) { return `<div class="switch-row"><div><strong>${title}</strong>${text ? `<p>${text}</p>` : ''}</div><button class="switch" role="switch" aria-label="${title}" aria-checked="${state.prefs[key]}" data-pref="${key}"></button></div>`; }
    return heading('应用设置', '窗口、托盘与启动行为。') + `<div class="settings-grid"><section><div class="panel"><div class="panel-heading"><h2>窗口与系统托盘</h2><span class="pill ${state.native ? 'green' : ''}">${state.native ? '原生托盘已启用' : '浏览器预览'}</span></div>${toggle('closeToTray', '关闭窗口时隐藏到托盘', '')}${toggle('remember', '持久化保存设置', '')}<div class="switch-row"><div><strong>登录 Windows 后自动启动控制台</strong></div><span class="pill">后续接入</span></div><div class="switch-row"><div><strong>打开控制台时自动启动服务</strong></div><span class="pill">后续接入</span></div></div><div class="panel section-title"><div><h2>托盘交互</h2></div>${button('预览菜单', 'tray-preview', 'tray')}</div></section><aside class="panel"><div class="about-mark"><img src="app-icon.png" alt="ZViewer 标志"><div><h2>ZViewer</h2><p>WINDOWS DESKTOP</p></div></div><div class="version">0.1.0 <small>LOCAL BUILD</small></div><p class="settings-description">Windows 桌面控制台</p><div class="panel-line"></div><div class="subheading">本地运行包</div>${[['backend', 'zviewer-backend.exe'], ['cert', 'zviewer-cert.exe'], ['livekit', 'livekit-server.exe'], ['web', 'frontend/dist']].map(([key, label]) => `<div class="file-check"><code>${label}</code><span>${info ? (info[key] ? '已检测到' : '未找到') : '桌面版中检测'}</span></div>`).join('')}</aside></div>`;
  }
  function navigate(page) { if (!titles[page]) page = 'overview'; state.page = page; if (location.hash !== `#${page}`) location.hash = page; else render(); }
  // 左上角状态卡：绿点=主服务运行中，红点=未启动；按钮与服务总览共用 toggle-run。
  function syncWorkspace() {
    const dot = $('#workspace-dot'), label = $('#workspace-state'), button = $('#workspace-action');
    if (!label || !button) return;
    const backend = state.live ? state.server?.backend || 'stopped' : state.running ? 'running' : 'stopped';
    const running = backend === 'running';
    const busy = backend === 'starting' || backend === 'stopping';
    const port = state.live ? state.server?.active?.port || state.config?.port : '';
    const text = running ? `运行中${port ? ` · ${port}` : ''}` : ({ starting: '启动中', stopping: '停止中', error: '运行异常' })[backend] || '未启动';
    label.textContent = text;
    if (dot) {
      dot.dataset.state = running ? 'running' : 'stopped';
      dot.setAttribute('aria-label', running ? 'ZViewer 运行中' : 'ZViewer 未启动');
    }
    button.textContent = running ? '停止' : '启动';
    button.disabled = busy;
    button.setAttribute('aria-label', running ? '停止 ZViewer 服务' : '启动 ZViewer 服务');
  }
  function render() {
    const main = $('#main'), pageView = $('#page-view'), cliView = $('#cli-view');
    const frame = cliView.querySelector('#cli-settings-frame');
    main.dataset.view = state.page;
    pageView.hidden = state.page === 'cli'; cliView.hidden = state.page !== 'cli';
    $('#crumb').textContent = titles[state.page];
    document.querySelectorAll('[data-page]').forEach(a => { const active = a.dataset.page === state.page; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const markup = (state.live && state.views ? state.views : { overview, connect, frp, cert, cli, mesh, logs, settings })[state.page]();
    // Both containers stay attached. Hiding the CLI view preserves its browsing context across navigation.
    if (frame && !state.cliEmbedUrl) frame.remove();
    else if (frame && frame.getAttribute('src') !== state.cliEmbedUrl) frame.setAttribute('src', state.cliEmbedUrl);
    if (state.live && state.page === 'cli' && frame && state.cliEmbedUrl) {
      // Keep the browsing context alive: replacing or reattaching an iframe resets QR/login input.
      const template = document.createElement('template'); template.innerHTML = markup;
      const focused = document.activeElement;
      const focusId = focused?.closest('.cli-settings') ? focused.id : '';
      const selection = focusId && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
      cliView.querySelector('.cli-settings').replaceWith(template.content.querySelector('.cli-settings'));
      if (focusId) { const replacement = document.getElementById(focusId); replacement?.focus({ preventScroll: true }); if (replacement && selection) replacement.setSelectionRange(...selection); }
    } else (state.page === 'cli' ? cliView : pageView).innerHTML = markup;
    $('#tray-label').textContent = state.native ? '收起到托盘' : '托盘预览';
    $('#footer-status').textContent = state.live ? (state.server?.backend === 'running' ? '本地服务运行中' : '原生托盘已启用') : state.native ? '原生托盘已启用' : '本地界面预览';
    icons();
    // 下拉列表改由页面渲染：原生 select 的弹出层不跟随暗色主题。
    window.ZViewerSelect?.enhance(document);
    syncWorkspace();
    if (state.live && state.page === 'cli') window.dispatchEvent(new Event('zviewer-cli-visible'));
  }
  function localCertDemo() {
    state.certReady = true;
    addEvent('已演示本机证书流程，未实际执行。', 'cert');
    render();
    modal(`<div class="big-check">${icon('check')}</div><h2>本机 HTTPS 流程已演示</h2><p>正式版本会在此复用或签发 localhost 证书，再启用 HTTPS 并打开管理页面。</p><div class="dns-example">https://localhost:3333</div><p>本次未签发证书、未修改系统证书存储，也未启动后端。</p><div class="modal-actions">${button('知道了', 'close-modal', 'check', 'primary')}</div>`);
  }
  async function action(name) {
    if (name === 'toggle-run') setRunning(!state.running);
    else if (name.startsWith('cli-')) toast('仅桌面版可用');
    else if (name === 'open-manager') modal(`<h2>打开本机管理页面</h2><div class="dns-example">https://localhost:3333</div><p>服务尚未接入。正式版本会先确认服务与证书就绪，再打开默认浏览器。</p><div class="modal-actions">${button('查看本机 HTTPS', 'go-cert', 'shield')}${button('知道了', 'close-modal', '', 'primary')}</div>`);
    else if (name === 'go-cert') { $('#modal').close(); navigate('cert'); }
    else if (name === 'local-cert') localCertDemo();
    else if (name === 'probe-ipv6' || name === 'ipv6-cert') toast('仅桌面版可用');
    else if (name === 'mesh-probe' || name === 'mesh-fill') toast('仅桌面版可用');
    else if (name === 'mesh-config-save' || name === 'mesh-config-connect' || name === 'mesh-config-import' || name === 'mesh-config-template') toast('仅桌面版可用');
    else if (name === 'tunnel-start' || name === 'tunnel-stop' || name === 'tunnel-refresh') toast('仅桌面版可用');
    else if (name === 'close-modal') $('#modal').close();
    else if (name === 'open-update') openUpdate();
    else if (name === 'update-check') await updateCommand('update-check');
    else if (name === 'update-download') await updateCommand('update-download');
    else if (name === 'update-apply') { const ok = await updateCommand('update-apply'); if (ok) toast('正在退出并安装更新'); }
    else if (name === 'update-page') await updateCommand('update-page');
    else if (name === 'update-auto') {
      if (!state.live) { toast('仅桌面版可用'); return; }
      await updateCommand('save', { config: { autoCheckUpdate: !updateReport()?.autoCheck } });
      state.updateKey = '';
      $('#modal-content').innerHTML = updateModal();
    }
    else if (name === 'update-source') {
      if (!state.live) { toast('仅桌面版可用'); return; }
      const report = updateReport();
      const enabled = !Boolean(state.config?.updateGitCode ?? report?.source === 'gitcode');
      toast('正在重新检查…');
      const next = await updateCommand('update-source', { enabled });
      if (!next) return;
      state.config = { ...state.config, updateGitCode: enabled };
      state.updateKey = '';
      $('#modal-content').innerHTML = updateModal();
    }
    else if (name === 'update-proxy') {
      if (!state.live) { toast('仅桌面版可用'); return; }
      const report = updateReport();
      const enabled = !Boolean(state.config?.updateProxy ?? report?.proxy);
      const url = $('#update-proxy-url')?.value.trim() || state.config?.updateProxyUrl || 'https://gh-proxy.com';
      toast('正在重新检查…');
      const next = await updateCommand('update-proxy', { enabled, url });
      if (!next) return;
      state.config = { ...state.config, updateProxy: enabled, updateProxyUrl: url };
      patchUpdateProxy(enabled, url);
      state.updateKey = '';
      $('#modal-content').innerHTML = updateModal();
    }
    else if (name === 'docs') { if (window.zviewerDesktop) await window.zviewerDesktop.openDocs(); else window.open('https://docx.zviewer.zero251.xyz/', '_blank', 'noopener,noreferrer'); }
    else if (name === 'export-frp') {
      const error = frpError();
      $('#frp-error').textContent = error;
      if (error) { toast(error); return; }
      download('frpc.toml', frpConfig());
      addEvent('已导出 frpc.toml 模板，未包含输入密钥。', 'frp');
      toast('已导出，请配置 FRP_TOKEN');
    } else if (name === 'copy-frp') {
      try { await navigator.clipboard.writeText(frpConfig()); toast('已复制'); }
      catch { toast('剪贴板不可用，可使用“导出配置模板”'); }
    } else if (name === 'export-logs') {
      download('zviewer-preview-events.log', '# ZViewer GUI prototype events only\n' + filteredEvents().map(e => `${e.time} ${e.level} [${e.source}] ${e.message}`).join('\n'));
      toast('已导出日志');
    } else if (name === 'pause-logs') { state.paused = !state.paused; render(); }
    else if (name === 'tray-preview') {
      if (window.zviewerDesktop) { await window.zviewerDesktop.window('tray-menu'); return; }
      modal(`<h2>系统托盘菜单</h2><p>桌面版在通知区域显示 ZViewer 图标，以下为菜单预览。</p><div class="tray-preview"><button data-action="tray-home">${icon('grid')}显示控制台</button><button data-action="tray-toggle">${icon(state.running ? 'stop' : 'play')}${state.running ? '停止演示' : '启动演示'}</button><button data-action="tray-logs">${icon('terminal')}查看日志</button><div class="separator"></div><button data-action="close-modal">关闭菜单预览</button></div>`);
    }
    else if (name === 'tray-home') { $('#modal').close(); navigate('overview'); }
    else if (name === 'tray-toggle') { $('#modal').close(); setRunning(!state.running); }
    else if (name === 'tray-logs') { $('#modal').close(); navigate('logs'); }
  }
  $('#modal').addEventListener('close', () => { state.updateOpen = false; });
  document.addEventListener('click', event => {
    if (!event.target.closest('.tutorial')) closeTutorials();
    const tutorialToggle = event.target.closest('[data-tutorial-toggle]');
    if (tutorialToggle) {
      const menu = tutorialToggle.parentElement.querySelector('.tutorial-menu');
      const willOpen = menu.hidden;
      closeTutorials();
      if (willOpen) { menu.hidden = false; tutorialToggle.setAttribute('aria-expanded', 'true'); }
      return;
    }
    if (event.target.closest('[data-tutorial-close]')) { closeTutorials(); return; }
    // 预览版自己切换组网配置方式；桌面端由 live.js 拦截后写进配置。
    const meshTab = event.target.closest('[data-mesh-mode]');
    if (meshTab && !state.live) {
      event.preventDefault();
      state.meshPreviewMode = meshTab.dataset.meshMode === 'config' ? 'config' : 'form';
      render();
      return;
    }
    const external = event.target.closest('[data-external]');
    if (external) {
      event.preventDefault();
      const url = external.dataset.external;
      // 桌面端走 Wails 运行时用系统浏览器打开；浏览器预览退化为新标签页。
      if (window.runtime?.BrowserOpenURL) window.runtime.BrowserOpenURL(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const copyTarget = event.target.closest('[data-copy]');
    if (copyTarget) {
      navigator.clipboard.writeText(copyTarget.dataset.copy)
        .then(() => toast('已复制地址'))
        .catch(() => toast('剪贴板不可用，可手动选择地址复制'));
      return;
    }
    const tutorialSection = event.target.closest('[data-tutorial-section]');
    if (tutorialSection) {
      const open = tutorialSection.closest('.tutorial-section').dataset.open === 'true';
      tutorialSection.closest('.tutorial-section').dataset.open = String(!open);
      tutorialSection.setAttribute('aria-expanded', String(!open));
      return;
    }
    const windowButton = event.target.closest('[data-window]');
    if (windowButton) { if (window.zviewerDesktop) window.zviewerDesktop.window(windowButton.dataset.window); else toast('仅桌面版可用'); return; }
    const nav = event.target.closest('[data-nav]'); if (nav) { navigate(nav.dataset.nav); return; }
    const btn = event.target.closest('[data-action]'); if (btn) { action(btn.dataset.action).catch(error => toast(`操作未完成：${error.message}`)); return; }
    const pref = event.target.closest('[data-pref]');
    if (pref) {
      state.prefs[pref.dataset.pref] = !state.prefs[pref.dataset.pref];
      try { if (state.prefs.remember) localStorage.setItem('zviewer-ui-prefs', JSON.stringify(state.prefs)); else localStorage.removeItem('zviewer-ui-prefs'); }
      catch { toast('本地存储不可用，设置不会保存'); }
      window.zviewerDesktop?.closeBehavior(state.prefs.closeToTray);
      render();
    }
  });
  document.addEventListener('input', event => {
    const target = event.target;
    if (target.matches('[data-frp-field]')) { state.frp[target.dataset.frpField] = target.value; const code = $('#frp-code'); if (code) code.textContent = frpConfig(); const error = $('#frp-error'); if (error) error.textContent = ''; }
    if (target.id === 'log-search') { state.logSearch = target.value; if (!state.paused) refreshLogs(); }
  });
  document.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-frp-check]')) { state.frp[target.dataset.frpCheck] = target.checked; const code = $('#frp-code'); if (code) code.textContent = frpConfig(); }
    if (target.id === 'log-source') { state.logSource = target.value; if (!state.paused) refreshLogs(); }
    if (target.id === 'log-level') { state.logLevel = target.value; if (!state.paused) refreshLogs(); }
    if (target.id === 'update-proxy-url') applyProxyURL(target);
  });
  function refreshLogs() { $('#log-lines').innerHTML = logLines(); $('#log-count').textContent = `${filteredEvents().length} 条 · ${state.live ? '运行日志' : '操作记录'}`; }
  $('#tray-button').addEventListener('click', () => { if (window.zviewerDesktop) window.zviewerDesktop.window('tray'); else action('tray-preview'); });
  $('#docs-link').addEventListener('click', () => action('docs'));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey && event.key.toLowerCase() === 'r') || event.key === 'F5') { event.preventDefault(); location.reload(); }
    if (event.key === 'Escape') closeTutorials();
  });
  window.addEventListener('hashchange', () => { state.page = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'overview'; render(); });
  $('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#modal').close(); } });
  state.page = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  const navToggle = $('#nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('nav-collapsed');
      navToggle.setAttribute('aria-expanded', String(!collapsed));
      navToggle.setAttribute('title', collapsed ? '展开导航' : '折叠导航');
    });
  }
  window.ZViewerUI = { state, icon, esc, heading, button, notice, tutorial, render, navigate, toast, modal, preview: { overview, connect, frp, cert, cli, mesh, logs, settings, updateModal, syncUpdate }, refreshLogs, syncWorkspace };
  render();
  if (window.zviewerDesktop) {
    window.zviewerDesktop.info().then(info => {
      state.info = info; state.native = true;
      if (info.live) { window.dispatchEvent(new CustomEvent('zviewer-ready', { detail: info })); return; }
      render();
    }).catch(() => toast('桌面桥接未就绪，请重新打开控制台。'));
    window.zviewerDesktop.onNavigate(navigate);
    window.zviewerDesktop.onUpdate?.(snapshot => {
      // Clear a stopped proxy even while its view is hidden; ordinary updates leave the iframe alone.
      if (snapshot.cli && !['starting', 'running'].includes(snapshot.cli.state)) {
        state.cliEmbedUrl = '';
        $('#cli-settings-frame')?.remove();
      }
    });
  }
})();
