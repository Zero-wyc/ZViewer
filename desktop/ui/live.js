(() => {
  'use strict';
  const ui = window.ZViewerUI;
  if (!ui || !window.zviewerDesktop) return;
  const { state, icon, esc, heading, button, notice, tutorial } = ui;
  const $ = selector => document.querySelector(selector);
  const labels = { stopped: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常', degraded: '待检查', connecting: '连接中', registered: '代理已注册' };
  // LiveKit 信令端口固定为主项目的 defaultHTTPPort（backend-go/internal/livekit/livekit.go），
  // 面板只读展示：它由 /rtc 反代使用，允许改动只会让面板与实际监听错位。
  const LIVEKIT_SIGNAL_PORT = 3336;
  let initialized = false, busy = false, serviceDraft = null, cliEmbedPending = false, ipv6Pending = false, ipv6Tried = false;
  function current() { return state.server.active || state.config; }
  function pill(status) { return `<span class="pill ${['running','registered'].includes(status) ? 'green' : ''}"><i></i>${labels[status] || status}</span>`; }
  function activity() {
    return state.events.slice(0, 3).map(e => `<div class="activity"><span class="activity-dot"></span><div><strong>${esc({ console: '控制台', backend: '主服务', voice: 'LiveKit 语音', cert: 'HTTPS 证书', frp: 'FRP 穿透', tunnel: 'Cloudflare 隧道', cli: '高画质代理', update: '软件更新' }[e.source] || e.source)}</strong><p>${esc(e.message)}</p></div><time>${esc(e.time)}</time></div>`).join('');
  }
  function overview() {
    const s = state.server, c = current();
    const card = (title, text, name, status, info, pid = s.pid) => `<article class="service-card"><div class="service-top"><span class="icon-box">${icon(name)}</span>${pill(status)}</div><div><h3>${title}</h3><p>${text}</p></div><div class="service-meta"><span>${info}</span><code>${status === 'running' && pid ? `PID ${pid}` : labels[status] || status}</code></div></article>`;
    // 第三张卡展示内置 CLI（高画质代理）：可用性取自运行包里是否带 ZViewerCLI，
    // 端口优先用实际监听端口，进程未起来时退回配置里的端口。
    const cli = s.cli || { state: 'stopped', available: false };
    const cliPort = cli.activePort || (c.cli && c.cli.port) || 9333;
    const cliInfo = cli.available === false ? '未检测到 CLI' : `127.0.0.1:${cliPort}`;
    return heading('服务总览', '本机服务的运行状态。') +
      `<section class="hero"><div class="hero-copy"><h2>${s.backend === 'running' ? '服务运行中' : s.backend === 'starting' ? '服务启动中' : '服务未启动'}</h2><p>${c.https ? 'https' : 'http'}://localhost:${esc(c.port)}<br>${c.bindHost === '127.0.0.1' ? '仅本机访问' : c.bindHost === '0.0.0.0' ? '局域网 IPv4' : '所有地址 · IPv4 + IPv6'} · ${s.backend === 'running' ? '健康检查通过' : '等待启动'}</p><div class="hero-actions">${button(s.pid ? '停止服务' : '启动服务', 'toggle-run', s.pid ? 'stop' : 'play', 'primary')}${button('打开网页端','open-web','globe','primary')}<button class="text-button" data-action="open-manager">打开管理页面 ${icon('external')}</button></div></div></section>` +
      `<div class="section-title"><h2>服务状态</h2><button class="text-button" data-nav="settings">监听端口 ${esc(c.port)} · 修改设置 ${icon('arrow')}</button></div><div class="service-grid">${card('ZViewer 主服务','网页与 API','server',s.backend,`${c.port} / TCP`)}${card('语音与推流','LiveKit 进程','mic',s.voice,`语音 UDP ${c.port} / RTMP ${c.rtmpPort}`,s.voicePid)}${card('高画质代理','ZViewerCLI 代理','terminal',cli.state,cliInfo,cli.pid)}</div>` +
      `<div class="bottom-grid"><section><div class="section-title"><h2>常用操作</h2><small>快捷入口</small></div><div class="setup-list"><button class="setup-row" data-nav="cert"><span class="step">${icon('lock')}</span><div><strong>签发本机 HTTPS 证书</strong><p>localhost</p></div>${icon('arrow')}</button><button class="setup-row" data-nav="connect"><span class="step">${icon('cloud')}</span><div><strong>新手推荐：Cloudflare Tunnel</strong><p>一键启动，无需额外配置</p></div>${icon('arrow')}</button><button class="setup-row" data-nav="settings"><span class="step">${icon('settings')}</span><div><strong>修改监听端口</strong><p>下次启动生效</p></div>${icon('arrow')}</button></div></section><section><div class="section-title"><h2>最近活动</h2><button class="text-button" data-nav="logs">全部日志 ${icon('arrow')}</button></div><div class="activity-list">${activity()}</div></section></div><div class="footnote">${icon('info')}显示本地进程状态。</div>`;
  }
  function frpCode() {
    const f = state.frp, c = state.config;
    const header = 'auth.method = "token"\nauth.token = "{{ .Envs.FRP_TOKEN }}"';
    const proxy = (name, type, local, remote) => `\n[[proxies]]\nname = "zviewer-${name}"\ntype = "${type}"\nlocalIP = "127.0.0.1"\nlocalPort = ${local}\nremotePort = ${Number(remote)}\n`;
    return `serverAddr = ${JSON.stringify(f.host || 'YOUR_VPS_IP')}\nserverPort = ${Number(f.port) || 7000}\n${header}\ntransport.tls.enable = true\n${proxy('backend','tcp',c.port,f.webPort)}${f.voice ? proxy('voice','udp',c.port,f.voicePort) : ''}${f.rtmp ? proxy('rtmp','tcp',c.rtmpPort,f.rtmpPort) : ''}${f.tcp ? proxy('voice-tcp','tcp',c.livekitTcpPort || 3337,f.tcpPort) : ''}`;
  }
  // FRP 有两种配置来源：表单生成配置，或直接粘贴、导入整份 frpc 配置文件。
  function frpMode() { return (state.config?.frp?.mode || state.frp.mode) === 'config' ? 'config' : 'form'; }
  let frpConfigPending = false;
  // 自定义配置在页面打开时读一次；读到后重绘，编辑框就不会闪成空白。
  function ensureFrpConfig() {
    if (state.frpConfig || frpConfigPending) return;
    frpConfigPending = true;
    window.zviewerDesktop.command('frp-config', {})
      .then(data => { state.frpConfig = data; if (state.page === 'frp') ui.render(); })
      .catch(error => ui.toast(String(error?.message || error).replace(/^.*Error: /, '')))
      .finally(() => { frpConfigPending = false; });
  }
  function editorContent() { return state.frpConfigDraft ?? state.frpConfig?.content ?? ''; }
  async function saveFrpConfig() {
    const content = editorContent();
    if (!content.trim()) { state.frpConfigError = '请先粘贴或导入 frpc 配置文件'; ui.render(); throw new Error('请先粘贴或导入 frpc 配置文件'); }
    const token = $('#frp-token')?.value || '';
    const result = await command('frp-config-save', { content, format: state.frpConfig?.format || 'toml', token: token || undefined });
    state.frpConfig = { content: result.content, path: result.path, format: result.format };
    state.frpConfigDraft = null; state.frpConfigError = '';
    return result;
  }
  async function setFrpMode(mode) {
    if (frpMode() === mode) return;
    if (mode === 'config') ensureFrpConfig();
    await command('save', { config: { frp: { mode } } });
    ui.render();
  }
  function frpFormPanel(connected) {
    const c = state.frp, cfg = state.config;
    function row(title, field, type, local, remote, checked, fixed = false) { return `<div class="mapping"><label><input class="checkbox" type="checkbox" data-frp-check="${field}" ${checked ? 'checked' : ''} ${fixed ? 'disabled' : ''}>${title}</label><span class="proto">${type}</span><code>${esc(local)}</code><span class="muted">→</span><input aria-label="${title}远端端口" type="number" min="1" max="65535" data-frp-field="${remote}" value="${esc(c[remote])}"></div>`; }
    return `<div class="form-layout"><section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('cloud')}</span><h2>FRP 服务器</h2></div><small>frps 节点</small></div>
      <div class="form-row"><label class="field"><span>服务器地址 <small>VPS 或服务商</small></span><input id="frp-host" data-frp-field="host" value="${esc(c.host)}" placeholder="例如 frp.example.com" autocomplete="off" maxlength="253"></label><label class="field"><span>控制端口</span><input data-frp-field="port" aria-label="FRP 控制端口" type="number" value="${esc(c.port)}" min="1" max="65535"></label></div>
      <label class="field"><span>认证密钥 <small>加密保存</small></span><input id="frp-token" type="password" placeholder="${state.server.tokenSaved ? '已保存，留空沿用' : '与 VPS 上的 frps 保持一致'}" autocomplete="off"></label>
      <span class="field-note">密钥经 Windows 加密保存，配置里用 {{ .Envs.FRP_TOKEN }} 读取。</span>
      <label class="field"><span>语音公布地址 <small>可留空</small></span><input data-frp-field="advertiseIp" value="${esc(c.advertiseIp || '')}" placeholder="VPS 公网 IPv4"></label>
      <div class="panel-line"></div>
      <div class="panel-heading no-margin"><h2>端口映射</h2><small>本地 → 公网 VPS</small></div>
      <div class="mapping mapping-head"><span>服务</span><span>协议</span><span>本地</span><span></span><span>远端</span></div>
      ${row('网页服务', 'web', 'TCP', cfg.port, 'webPort', true, true)}${row('UDP 语音', 'voice', 'UDP', cfg.port, 'voicePort', c.voice)}${row('RTMP 推流', 'rtmp', 'TCP', cfg.rtmpPort, 'rtmpPort', c.rtmp)}${row('TCP 语音', 'tcp', 'TCP', cfg.livekitTcpPort || 3337, 'tcpPort', c.tcp)}
      <div class="help-card"><strong>语音需单独放行</strong><p>UDP 语音跟随网页端口 ${esc(cfg.port)}，RTC TCP 使用 ${esc(cfg.livekitTcpPort || 3337)}，请在 VPS 放行对应端口。</p></div>
      <div class="validation" id="frp-error" role="alert"></div>
      <div class="form-actions">${button('保存配置', 'save-frp', 'check')}${button(connected ? '断开 FRP' : '连接 FRP', 'toggle-frp', 'network', 'primary')}</div></section>
      <section><div class="panel"><div class="panel-heading"><h2>配置预览</h2><span class="tag-caption">frpc.toml · 自动生成</span></div><pre class="codebox" id="frp-code">${esc(frpCode())}</pre><div class="code-footer"><span>凭据使用环境变量占位</span><span class="code-links"><button class="text-button" data-action="export-frp">${icon('download')}导出</button><button class="text-button" data-action="copy-frp">${icon('copy')}复制</button></span></div><div class="path-flow"><div class="flow-item">${icon('globe')}外网设备</div><span>→</span><div class="flow-item">${icon('cloud')}VPS / frps</div><span>→</span><div class="flow-item">${icon('monitor')}本机 / frpc</div></div></div></section></div>`;
  }
  function frpFilePanel(connected) {
    const conf = state.frpConfig, format = (conf?.format || 'toml').toUpperCase();
    const placeholder = ['serverAddr = &quot;frp.example.com&quot;', 'serverPort = 7000', 'auth.token = &quot;你的密钥&quot;', '', '[[proxies]]', 'name = &quot;zviewer-web&quot;', 'type = &quot;tcp&quot;', 'localIP = &quot;127.0.0.1&quot;', 'localPort = 3333', 'remotePort = 13333'].join('&#10;');
    return `<div class="form-layout"><section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('terminal')}</span><h2>frpc 配置文件</h2></div><small>${format} · 原样运行</small></div>
      <p class="wizard-copy">粘贴服务商或自建服务器给的完整配置，或从磁盘导入，保存后直接连接。</p>
      <label class="field"><span>认证密钥 <small>配置引用 FRP_TOKEN 时填写</small></span><input id="frp-token" type="password" placeholder="${state.server.tokenSaved ? '已保存，留空沿用' : '写入 FRP_TOKEN 环境变量'}" autocomplete="off"></label>
      <textarea class="codebox config-editor" id="frp-config-editor" spellcheck="false" autocomplete="off" aria-label="frpc 配置文件内容" placeholder="${placeholder}">${esc(editorContent())}</textarea>
      <div class="code-footer"><span>${conf?.path ? '保存位置 ' + esc(conf.path) : '尚未保存'}</span><span>${esc(format)}</span></div>
      <div class="validation" id="frp-error" role="alert">${esc(state.frpConfigError || '')}</div>
      <div class="form-actions">${button('导入文件', 'frp-import', 'folder')}${button('按图形配置填充', 'frp-generate', 'refresh')}${button('保存', 'frp-save', 'check')}${button(connected ? '断开 FRP' : '保存并连接', 'frp-connect', 'network', 'primary')}</div></section>
      <aside class="panel"><div class="panel-heading"><h2>使用说明</h2></div>
        <div class="check-item">${icon('terminal')}<div><strong>直接粘贴</strong><br>整份 frpc 配置照抄即可，密钥可以写在配置里。</div></div>
        <div class="check-item">${icon('folder')}<div><strong>导入文件</strong><br>支持 TOML、YAML、JSON，按扩展名识别格式。</div></div>
        <div class="check-item">${icon('shield')}<div><strong>密钥</strong><br>配置里写 {{ .Envs.FRP_TOKEN }} 时，用上方密钥注入环境变量。</div></div>
        <div class="panel-line"></div>
        <p class="field-note">连接前会用 frpc 校验配置，校验不通过时原因显示在编辑框下方；已连接时改完要断开再连才生效。</p>
      </aside></div>`;
  }
  function frp() {
    const mode = frpMode(), connected = ['connecting', 'registered'].includes(state.server.frp);
    if (mode === 'config') ensureFrpConfig();
    const tabs = `<div class="tabs frp-mode"><button data-frp-mode="form" class="${mode === 'form' ? 'active' : ''}">图形配置</button><button data-frp-mode="config" class="${mode === 'config' ? 'active' : ''}">配置文件</button></div>`;
    return heading('FRP 穿透', '把本机端口转发到公网服务器。', `${tutorial('frp')}${pill(state.server.frp)}`) + tabs + (mode === 'config' ? frpFilePanel(connected) : frpFormPanel(connected));
  }
  function cert() {
    const s = state.server.certificate, c = state.config;
    const v6 = state.ipv6;
    const v6Url = v6?.ok ? `https://[${v6.address}]:${esc(c.port)}/admin` : '';
    const v6State = v6 ? (v6.ok ? v6.address : v6.reason || '未探测到公网 IPv6') : '尚未探测';
    const v6Block = `<div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">${icon('globe')}</span><h2>本机 IPv6</h2></div><span class="pill ${v6?.ok ? 'green' : ''}"><i></i>${v6?.ok ? '已探测' : '未探测'}</span></div><p class="wizard-copy">按本机 IPv6 地址签发证书，供 IPv6 直连访问。</p><div class="dns-example">${v6Url || '尚未探测到 IPv6'}</div><div class="check-item">${icon('globe')}<div><strong>1. 探测本机 IPv6</strong><br>${esc(v6State)}</div></div><div class="check-item">${icon('lock')}<div><strong>2. 按该地址签发</strong><br>运行中的服务会重启。</div></div>${c.bindHost === '::' ? '' : notice('监听范围是「' + (c.bindHost === '0.0.0.0' ? '局域网 IPv4' : '仅本机') + '」，其他设备无法经 IPv6 访问；需在设置里改为「所有地址 · IPv4 + IPv6」。')}<div class="live-toolbar">${button(v6?.ok ? '重新探测 IPv6' : '探测本机 IPv6', 'probe-ipv6', 'globe')}${v6?.ok ? button('按 IPv6 签发并启用 HTTPS', 'ipv6-cert', 'lock', 'primary') : ''}</div>`;
    return heading('证书与域名', '签发 IPv6 或本机证书并启用 HTTPS。', tutorial('cert')) +
      `<div class="form-layout"><section class="panel">${v6Block}<div class="panel-line"></div><div class="panel-heading"><h2>本机 localhost</h2>${pill(s.valid ? 'running' : 'stopped')}</div><p class="wizard-copy">为 localhost 与局域网地址签发证书并启用 HTTPS。</p><div class="dns-example">https://localhost:${esc(c.port)}/admin</div>${notice('证书为自签证书，私钥保存在当前用户目录。')}<div class="check-item">${icon('check')}<div><strong>1. 签发证书并启用 HTTPS</strong><br>运行中的服务会重启。</div></div><div class="check-item">${icon('external')}<div><strong>2. 打开管理页面</strong></div></div><div class="live-toolbar">${button('签发并启用 HTTPS','local-cert','lock','primary')}${current().https ? button('以 HTTP 方式启动','start-http','globe') : ''}${s.exists || s.valid ? button('打开管理页面','open-manager','external') : ''}</div></section><aside class="panel"><div class="certificate">${icon('shield')}<div class="eyebrow">证书预览</div><h3>${esc(s.exists ? c.domain : 'localhost')}</h3><p>${s.valid ? `有效期至 ${esc(s.validTo)}` : '尚未签发证书'}<br>${s.exists ? '本机自签 · 浏览器首次访问需手动继续' : '尚未生成'}</p></div><div class="meta-list"><div class="meta-line"><span>监听端口</span><span>${esc(c.port)}</span></div><div class="meta-line"><span>HTTPS 配置</span><span>${c.https ? '已启用' : '未启用'}</span></div><div class="meta-line"><span>证书 SAN</span><span>${esc(s.san || 'localhost / 127.0.0.1 / ::1')}</span></div></div><div class="live-toolbar">${s.valid ? button('导出公开 CA','export-ca','download') : ''}</div></aside></div>`;
  }
  function serviceValues() {
    return {
      port: $('#service-port').value,
      rtmpPort: $('#rtmp-port').value,
      flvPort: $('#flv-port').value,
      bindHost: $('#bind-host').value,
      https: $('#service-https').getAttribute('aria-checked') === 'true',
      livekitPort: LIVEKIT_SIGNAL_PORT,
      livekitTcpPort: $('#livekit-tcp-port').value
    };
  }
  function settings() {
    const c = { ...state.config, ...serviceDraft };
    function field(id, label, value) { return `<label class="field"><span>${label}</span><input id="${id}" type="number" min="1" max="65535" value="${esc(value)}"></label>`; }
    function toggle(key, label, help) { return `<div class="switch-row"><div><strong>${label}</strong>${help ? `<p>${help}</p>` : ''}</div><button class="switch" role="switch" aria-label="${label}" aria-checked="${state.config[key]}" data-live-pref="${key}"></button></div>`; }
    return heading('应用设置','监听端口、托盘与启动行为。') +
      `<div class="settings-grid"><section><div class="panel network-settings"><div class="panel-heading"><h2>监听端口与网络</h2><span class="pill">保存后下次启动生效</span></div>
        <div class="settings-form">
          <div class="form-row triple">${field('service-port','网页 / 管理页面',c.port)}${field('rtmp-port','RTMP 推流',c.rtmpPort)}${field('flv-port','HTTP-FLV',c.flvPort)}</div>
          <label class="field"><span>网页与信令监听范围</span><select id="bind-host"><option value="127.0.0.1" ${c.bindHost === '127.0.0.1' ? 'selected' : ''}>仅本机 · 127.0.0.1</option><option value="0.0.0.0" ${c.bindHost === '0.0.0.0' ? 'selected' : ''}>局域网 IPv4 · 0.0.0.0</option><option value="::" ${c.bindHost === '::' ? 'selected' : ''}>所有地址 · IPv4 + IPv6</option></select></label>
          <div class="switch-row service-https-row"><div><strong id="service-https-title">使用 HTTPS</strong><p id="service-https-help">首次启用时自动签发本机证书。</p></div><button type="button" class="switch" id="service-https" role="switch" aria-labelledby="service-https-title" aria-describedby="service-https-help" aria-checked="${Boolean(c.https)}"></button></div>
          <div class="livekit-settings"><div class="settings-subheading"><h3>LiveKit 高级端口</h3></div>
            <div class="form-row triple"><div class="field udp-follow-field"><span>语音 UDP</span><output id="livekit-udp-port" for="service-port">${esc(c.port)}</output></div><div class="field udp-follow-field"><span>信令 / WebSocket</span><output id="livekit-signal-port">${LIVEKIT_SIGNAL_PORT}</output><small>固定端口，与主项目一致</small></div>${field('livekit-tcp-port','语音 RTC TCP',c.livekitTcpPort ?? 3337)}</div>
            <p class="field-note livekit-settings-note">UDP 跟随网页端口，信令固定 ${LIVEKIT_SIGNAL_PORT}；改完保存后重启生效。</p>
          </div>
          <div class="form-actions">${button('保存配置','save-service','check','primary')}${state.server.pid ? button('重启使配置生效','restart','refresh') : ''}</div>
        </div>
      </div><div class="panel section-title"><div><h2>窗口与系统托盘</h2>${toggle('closeToTray','关闭窗口时隐藏到托盘','')}${toggle('launchAtLogin','登录 Windows 后自动启动控制台','')}${toggle('autoStart','打开控制台时自动启动服务','')}</div></div></section>
      <aside class="panel"><div class="about-mark"><img src="app-icon.png" alt="ZViewer"><div><h2>ZViewer</h2><p>WINDOWS DESKTOP</p></div></div><div class="version">${esc(state.info.version)} <small>LOCAL BUILD</small></div><p class="settings-description">配置保存在当前用户目录，FRP 密钥加密保存。</p><div class="panel-line"></div><div class="subheading">当前运行包</div><p class="runtime-path">${esc(state.server.root)}</p><div class="file-check"><span>后端</span><span>${state.info.runtime.backend ? '已检测到' : '缺失'}</span></div><div class="file-check"><span>FRP 0.71.1</span><span>${state.server.frpcAvailable ? '已检测到' : '缺失'}</span></div><div class="file-check"><span>ZViewerCLI</span><span>${state.server.cli?.available ? '已检测到' : '缺失'}</span></div><div class="live-toolbar">${button('配置文件夹','open-data','folder')}${button('托盘菜单','tray-preview','tray')}</div></aside></div>`;
  }
  function logs() {
    return ui.preview.logs()
      .replace('演示数据','最多 500 条')
      .replace('>INFO</option>','>INFO</option><option value="ERROR">ERROR</option>');
  }
  function cliViewKey(snapshot) { const c = snapshot?.active || snapshot?.config; return JSON.stringify([snapshot?.cli, snapshot?.webUrl, c?.port, c?.https, snapshot?.config?.cli?.user]); }
  function validatedCliUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('无效的本机 CLI 设置地址');
    const url = new URL(value), port = Number(url.port || 80);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.hash || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLI 设置仅允许本机 HTTP 地址');
    url.searchParams.set('desktop', '1');
    return url.href;
  }
  function syncCliEmbed(snapshot) {
    if (!state.cliEmbedUrl) return false;
    const previous = state.cliEmbedUrl;
    if (!['starting', 'running'].includes(snapshot.cli?.state)) state.cliEmbedUrl = '';
    else {
      // The iframe origin comes from cli-open; these query values come only from native state.
      const url = new URL(previous), c = snapshot.active || snapshot.config;
      const backend = snapshot.webUrl || `${c.https ? 'https' : 'http'}://localhost:${c.port}/`;
      url.searchParams.set('server', backend);
      const user = snapshot.config?.cli?.user || '';
      if (user) url.searchParams.set('user', user); else url.searchParams.delete('user');
      state.cliEmbedUrl = validatedCliUrl(url.href);
    }
    return previous !== state.cliEmbedUrl;
  }
  function sync(snapshot, initial = false) {
    const cliBefore = cliViewKey(state.server), tunnelBefore = tunnelKey(state.server), entryBefore = entryKey(state.server);
    const embedChanged = syncCliEmbed(snapshot);
    state.server = snapshot; state.events = snapshot.events; state.info.runtime = snapshot.runtime;
    // 配置随快照更新，端口或 HTTPS 改变后连接方式页不会残留旧地址。
    state.config = structuredClone(snapshot.config);
    if (initial) state.frp = structuredClone(snapshot.config.frp);
    if (initial || state.page === 'overview' || state.page === 'cli' && (embedChanged || cliBefore !== cliViewKey(snapshot)) || state.page === 'connect' && (tunnelBefore !== tunnelKey(snapshot) || entryBefore !== entryKey(snapshot)) || state.page === 'mesh') ui.render();
    else if (state.page === 'logs' && !state.paused) ui.refreshLogs();
    else if (state.page === 'connect' || state.page === 'cert') ensureIPv6();
    ui.preview.syncUpdate(snapshot);
    ui.syncWorkspace?.();
    $('#footer-status').textContent = snapshot.backend === 'running' ? `本地服务运行中 · ${current().port}` : `本地服务 · ${labels[snapshot.backend]}`;
  }
  function tunnelKey(snapshot) { const t = snapshot?.tunnel; return t ? `${t.available}|${t.state}|${t.url}|${t.message}|${snapshot.config?.cloudflaredSource}` : ''; }
  // 外部访问地址由主服务端口与 HTTPS 决定，两者变化都要重绘入口卡片；
  // 组网卡片的地址还会随入网状态与虚拟 IP 变化。
  function entryKey(snapshot) { const c = snapshot?.active || snapshot?.config || {}; return `${c.port}|${c.https}|${snapshot?.mesh?.state}|${snapshot?.mesh?.virtualIp}`; }
  // 首次进入“连接方式”或“证书与域名”页时探测公网 IPv6；结果缓存在 state.ipv6，手动刷新时重新探测。
  function ensureIPv6() {
    if (state.ipv6 !== null || ipv6Pending || ipv6Tried) return;
    if (state.page !== 'connect' && state.page !== 'cert') return;
    ipv6Pending = true; ipv6Tried = true;
    window.zviewerDesktop.command('probe-ipv6', {})
      .then(report => { state.ipv6 = report; if (state.page === 'connect' || state.page === 'cert') ui.render(); })
      .catch(error => ui.toast(error.message.replace(/^.*Error: /, '')))
      .finally(() => { ipv6Pending = false; });
  }
  async function command(action, payload) {
    if (busy) { ui.toast('正在处理上一项操作，请稍后'); return; }
    busy = true; document.body.classList.add('live-busy');
    try {
      const result = await window.zviewerDesktop.command(action, payload);
      const snapshot = await window.zviewerDesktop.info(); sync(snapshot, true);
      return result;
    } finally { busy = false; document.body.classList.remove('live-busy'); if (action !== 'cli-open') setTimeout(ensureCliEmbed, 0); }
  }
  function ensureCliEmbed() {
    if (cliEmbedPending || busy || state.page !== 'cli' || state.server?.cli?.state !== 'running' || state.cliEmbedUrl) return;
    cliEmbedPending = true;
    act('cli-open').catch(error => ui.toast(error.message.replace(/^.*Error: /, ''))).finally(() => { cliEmbedPending = false; });
  }
  window.addEventListener('zviewer-cli-visible', () => setTimeout(ensureCliEmbed, 0));
  async function act(action) {
    if (action === 'toggle-run') { await command(state.server.pid ? 'stop' : 'start'); ui.toast(state.server.backend === 'running' ? '服务已启动' : '服务已停止'); }
    else if (action === 'restart') { await command('restart'); ui.toast('服务已使用保存的配置重启'); }
    else if (action === 'open-manager') await command('open-manager');
    else if (action === 'open-web') await command('open-web');
    else if (action === 'cli-start' || action === 'cli-open') {
      const result = await command('cli-open');
      if (result?.url) { state.cliEmbedUrl = validatedCliUrl(result.url); ui.render(); if (action === 'cli-start') ui.toast('高画质代理已启动，可在右侧完成配置'); }
    }
    else if (action === 'cli-stop') { await command('cli-stop'); ui.toast('高画质代理已停止'); }
    else if (action === 'cli-save') { await command('cli-save', cliValues()); state.cliDraft = null; ui.render(); ui.toast('代理配置已保存，内置设置会自动带入后端地址'); }
    else if (action === 'local-cert') {
      await command('https',{domain:'localhost',ip:''}); ui.render(); ui.toast('HTTPS 已就绪，打开管理页面时在证书提示中选择继续访问');
    } else if (action === 'start-http') {
      // 证书保留，只把服务协议切回 HTTP；随时可以再签发/启用 HTTPS。
      await command('start-http');
      ui.render();
      ui.toast('已改为 HTTP 启动，证书保留，可随时切回 HTTPS');
    } else if (action === 'ipv6-cert') {
      // 证书 SAN 里追加本机 IPv6，签发后可直接用 https://[IPv6]:端口 访问。
      let report = state.ipv6;
      if (!report?.ok) report = await window.zviewerDesktop.command('probe-ipv6', {});
      state.ipv6 = report;
      if (!report?.ok || !report.address) { ui.render(); ui.toast(report?.reason || '没有探测到公网 IPv6'); return; }
      await command('https',{domain:'localhost',ip:report.address});
      ui.render();
      ui.toast(`已按 IPv6 ${report.address} 签发证书` + (state.config.bindHost === '::' ? '' : '；监听范围改为「所有地址 · IPv4 + IPv6」后才能从其他设备访问'));
    } else if (action === 'save-service') {
      const config = serviceValues();
      await command('save',{config}); serviceDraft = null; ui.render(); ui.toast('配置已保存，下次启动服务自动使用；运行中可点击重启生效');
    } else if (action === 'save-frp') {
      const token = $('#frp-token').value;
      await command('save',{config:{frp:state.frp},token:token || undefined}); ui.render(); ui.toast('FRP 配置已保存，密钥已通过 Windows 加密保护');
    } else if (action === 'toggle-frp') { await command(['connecting','registered'].includes(state.server.frp) ? 'frp-stop' : 'frp-start'); ui.render(); }
    else if (action === 'frp-import') {
      const data = await command('frp-config-import');
      if (data?.canceled) return;
      state.frpConfig = { content: data.content, path: data.path, format: data.format };
      state.frpConfigDraft = null; state.frpConfigError = '';
      ui.render();
      ui.toast(`已导入 ${data.name || '配置文件'}，点「保存并连接」开始穿透`);
    } else if (action === 'frp-generate') {
      if (editorContent().trim()) { ui.toast('编辑框已有内容，清空后可以按图形配置重新生成'); return; }
      if ((state.frpConfig?.format || 'toml') !== 'toml') { ui.toast('当前是 YAML/JSON 配置，不能按图形配置填充'); return; }
      state.frpConfigDraft = frpCode(); ui.render();
      ui.toast('已按图形配置生成，请核对地址、端口与密钥');
    } else if (action === 'frp-save') {
      await saveFrpConfig(); ui.render();
      ui.toast(['connecting','registered'].includes(state.server.frp) ? '配置已保存，断开并重新连接后生效' : 'FRP 配置文件已保存');
    } else if (action === 'frp-connect') {
      await saveFrpConfig();
      await command('frp-start');
      ui.render();
      ui.toast('FRP 已启动，日志里可以看到每个代理的注册结果');
    }
    else if (action === 'mesh-save' || action === 'mesh-toggle') {
      await saveMesh();
      if (action === 'mesh-toggle') {
        const running = ['starting', 'running'].includes(state.server.mesh?.state);
        await command(running ? 'mesh-stop' : 'mesh-start');
        ui.render();
        ui.toast(running ? '已退出组网，虚拟 IP 失效' : state.server.mesh?.virtualIp ? `已入网：${state.server.mesh.virtualIp}` : '组网已启动');
      } else {
        ui.render();
        ui.toast('组网配置已保存');
      }
    } else if (action === 'mesh-generate') {
      const credentials = await command('mesh-generate');
      state.meshDraft = { ...meshValues(), networkName: credentials.networkName };
      state.meshSecretDraft = credentials.networkSecret;
      ui.render();
      ui.toast('已生成新的网络名称与密钥，保存并入网后才生效');
    } else if (action === 'mesh-probe' || action === 'mesh-fill') {
      await probePublicPeers(action === 'mesh-fill');
    } else if (action === 'mesh-config-save' || action === 'mesh-config-connect') {
      await saveMeshConfig(action === 'mesh-config-connect');
    } else if (action === 'mesh-config-import') {
      const data = await command('mesh-config-import');
      if (data?.canceled) return;
      state.meshConfig = { content: data.content, path: data.path, format: data.format };
      state.meshConfigDraft = null; state.meshConfigError = '';
      ui.render();
      ui.toast(`已导入 ${data.name || '配置文件'}，点「保存并入网」开始组网`);
    } else if (action === 'mesh-config-template') {
      if (meshConfigContent().trim()) { ui.toast('编辑框已有内容，清空后才能按图形配置生成'); return; }
      const data = await command('mesh-config-template');
      state.meshConfigDraft = data.content;
      ui.render();
      ui.toast('已按图形配置生成，请核对网络名称、密钥与对端地址');
    } else if (action === 'mesh-invite') {
      const data = await command('mesh-invite');
      await navigator.clipboard.writeText(data.text);
      ui.toast('入网说明已复制，发给朋友即可');
    } else if (action === 'export-frp') await command('export',{kind:'frpc'});    else if (action === 'probe-ipv6') {
      const report = await window.zviewerDesktop.command('probe-ipv6', {});
      state.ipv6 = report; ui.render();
      ui.toast(report.ok ? `公网 IPv6：${report.address}` : '没有探测到公网 IPv6');
    }
    else if (action === 'tunnel-start') { await command('tunnel-start'); ui.render(); ui.toast('正在检查本机服务和隧道健康度，通过后显示访问地址'); }
    else if (action === 'tunnel-stop') { await command('tunnel-stop'); ui.render(); ui.toast('已停止隧道和自动刷新'); }
    else if (action === 'tunnel-refresh') { await command('tunnel-refresh'); ui.render(); ui.toast('隧道已刷新，正在获取新地址'); }
    else if (action === 'export-logs') await command('export',{kind:'logs'});
    else if (action === 'export-ca') await command('export',{kind:'ca'});
    else if (action === 'open-data') await command('open-data');
  }
  const actions = new Set(['toggle-run','restart','open-manager','open-web','cli-start','cli-stop','cli-open','cli-save','local-cert','ipv6-cert','start-http','save-service','save-frp','toggle-frp','export-frp','frp-import','frp-save','frp-connect','frp-generate','mesh-save','mesh-toggle','mesh-generate','mesh-invite','mesh-probe','mesh-fill','mesh-config-save','mesh-config-connect','mesh-config-import','mesh-config-template','export-logs','export-ca','open-data','probe-ipv6','tunnel-start','tunnel-stop','tunnel-refresh']);
  function cliValues() { return { port: $('#cli-port').value, autoStart: $('#cli-auto-start').getAttribute('aria-checked') === 'true', user: $('#cli-user').value.trim() }; }
  function meshValues() {
    return {
      networkName: ($('#mesh-name')?.value || '').trim(),
      peers: ($('#mesh-peers')?.value || '').split('\n').map(line => line.trim()).filter(Boolean),
      listenPort: $('#mesh-port')?.value || ''
    };
  }
  // 组网密钥只在提交时读一次，草稿留在内存里，免得状态推送把刚输入的密钥冲掉。
  async function saveMesh() {
    const secret = $('#mesh-secret')?.value || '';
    await command('mesh-save', { config: meshValues(), networkSecret: secret || undefined });
    state.meshDraft = null; state.meshSecretDraft = '';
  }
  // 比较两个对端地址是否同一个：忽略协议前缀与大小写，端口照旧。
  function samePeer(a, b) {
    const norm = value => String(value || '').trim().toLowerCase().replace(/^(tcp|udp|ws|wss):\/\//, '');
    return norm(a) === norm(b);
  }
  // 公共对端服务器：先测一遍再谈填不填。fill=true 时只把延迟最低的那个写进对端地址
  // —— 对端地址只负责首次发现，连上一个节点后整个网络就都知道了，多填只是备份。
  async function probePublicPeers(fill) {
    const draft = meshValues();
    state.meshProbe = { running: true, at: state.meshProbe?.at || '', results: state.meshProbe?.results || {} };
    if (!fill) ui.render();
    try {
      const list = await command('mesh-probe');
      const results = {};
      for (const item of list || []) results[item.uri] = item;
      state.meshProbe = { running: false, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), results };
      const usable = Object.values(results).filter(item => item.state === 'ok');
      if (!fill) {
        ui.render();
        ui.toast(usable.length ? `测试完成：${usable.length}/${Object.keys(results).length} 个可连接` : '公共节点都连不上，建议填自建 VPS 地址');
        return;
      }
      if (!usable.length) { ui.render(); ui.toast('没有可连接的公共节点，请稍后重试或用自建 VPS'); return; }
      const fastest = usable.slice().sort((a, b) => a.latencyMs - b.latencyMs)[0];
      const current = draft.peers || [];
      if (current.some(peer => samePeer(peer, fastest.uri))) {
        ui.render();
        ui.toast(`最快节点已在列表里：${fastest.uri}（${fastest.latencyMs} ms）`);
        return;
      }
      if (current.length >= 4) { ui.render(); ui.toast('对端地址已满 4 个，先删掉一个再填'); return; }
      state.meshDraft = { ...draft, peers: [...current, fastest.uri] };
      ui.render();
      ui.toast(`已填入最快节点 ${fastest.uri}（${fastest.latencyMs} ms），保存并入网后生效`);
    } catch (error) {
      state.meshProbe = { ...state.meshProbe, running: false };
      ui.render();
      throw error;
    }
  }
  // 配置文件模式：编辑框内容优先用草稿，保存成功后清掉草稿。
  function meshConfigContent() { return state.meshConfigDraft ?? state.meshConfig?.content ?? ''; }
  async function saveMeshConfig(connect) {
    const content = meshConfigContent();
    if (!content.trim()) { state.meshConfigError = '请先粘贴或导入 EasyTier 配置文件'; ui.render(); throw new Error('请先粘贴或导入 EasyTier 配置文件'); }
    const saved = await command('mesh-config-save', { content, format: 'toml' });
    state.meshConfig = { content: saved.content, path: saved.path, format: saved.format };
    state.meshConfigDraft = null; state.meshConfigError = '';
    // 已在运行时后端会按新配置重新入网，没起来才需要显式启动。
    if (connect && !['starting', 'running'].includes(state.server.mesh?.state)) {
      await command('mesh-start');
      ui.render();
      ui.toast('已保存并入网');
      return;
    }
    ui.render();
    ui.toast(connect ? '已按新配置重新入网' : '配置文件已保存');
  }
  // 切换配置方式与 FRP 一致：只写 mode，表单内容与配置文件都留着。
  async function setMeshMode(mode) {
    const current = state.config?.mesh?.mode === 'config' ? 'config' : 'form';
    if (current === mode) return;
    await command('save', { config: { mesh: { mode } } });
    ui.render();
  }
  document.addEventListener('click',event => {
    if (!state.live) return;
    const cliSwitch = event.target.closest('#cli-auto-start');
    if (cliSwitch) {
      event.preventDefault(); event.stopImmediatePropagation();
      cliSwitch.setAttribute('aria-checked', String(cliSwitch.getAttribute('aria-checked') !== 'true'));
      state.cliDraft = cliValues(); return;
    }
    const httpsSwitch = event.target.closest('#service-https');
    if (httpsSwitch) {
      event.preventDefault(); event.stopImmediatePropagation();
      httpsSwitch.setAttribute('aria-checked', String(httpsSwitch.getAttribute('aria-checked') !== 'true'));
      serviceDraft = serviceValues(); return;
    }
    const pref = event.target.closest('[data-live-pref]');
    if (pref) {
      event.preventDefault(); event.stopImmediatePropagation();
      if ($('#service-port')) serviceDraft = serviceValues();
      command('save',{config:{[pref.dataset.livePref]:!state.config[pref.dataset.livePref]}}).then(()=>ui.render()).catch(error=>ui.toast(error.message.replace(/^.*Error: /,''))); return;
    }
    const meshModeBtn = event.target.closest('[data-mesh-mode]');
    if (meshModeBtn) {
      event.preventDefault(); event.stopImmediatePropagation();
      setMeshMode(meshModeBtn.dataset.meshMode).catch(error=>ui.toast(error.message.replace(/^.*Error: /,'')));
      return;
    }
    const frpModeBtn = event.target.closest('[data-frp-mode]');
    if (frpModeBtn) {
      event.preventDefault(); event.stopImmediatePropagation();
      setFrpMode(frpModeBtn.dataset.frpMode).catch(error=>ui.toast(error.message.replace(/^.*Error: /,'')));
      return;
    }
    const btn=event.target.closest('[data-action]');
    if (btn && actions.has(btn.dataset.action)) {
      event.preventDefault(); event.stopImmediatePropagation();
      act(btn.dataset.action).catch(error=>ui.toast(error.message.replace(/^.*Error: /,'')));
    }
  },true);
  document.addEventListener('change', event => {
    if (!state.live || event.target.id !== 'cloudflared-source') return;
    if (busy) { ui.render(); return; }
    const source = event.target.value;
    command('save', { config: { cloudflaredSource: source } })
      .then(() => ui.toast('组件获取源已保存，下载和更新检查均使用此源'))
      .catch(error => ui.toast(error.message.replace(/^.*Error: /, '')))
      .finally(() => ui.render());
  });
  document.addEventListener('input', event => {
    if (state.live && event.target.id === 'mesh-secret') { state.meshSecretDraft = event.target.value; return; }
    if (state.live && event.target.matches('#mesh-name,#mesh-peers,#mesh-port')) { state.meshDraft = meshValues(); return; }
    if (state.live && event.target.matches('#cli-port,#cli-user')) { state.cliDraft = cliValues(); return; }
    if (state.live && event.target.id === 'mesh-config-editor') {
      state.meshConfigDraft = event.target.value;
      state.meshConfigError = '';
      const error = $('#mesh-error'); if (error) error.textContent = '';
      return;
    }
    if (state.live && event.target.id === 'frp-config-editor') {
      // 草稿只留在内存里，切页或收到状态推送都不会丢掉未保存的修改。
      state.frpConfigDraft = event.target.value;
      state.frpConfigError = '';
      const error = $('#frp-error'); if (error) error.textContent = '';
      return;
    }
    if (!state.live || !event.target.matches('#service-port,#rtmp-port,#flv-port,#bind-host,#livekit-tcp-port')) return;
    serviceDraft = serviceValues();
    $('#livekit-udp-port').textContent = $('#service-port').value || '—';
  });
  function init(info) {
    if (initialized) return; initialized = true;
    state.live = true; state.info = info; state.native = true;
    state.views = { overview, connect: ui.preview.connect, frp, cert, cli: ui.preview.cli, mesh: ui.preview.mesh, logs, settings }; state.frpConfigOverride = frpCode;
    const buildLabel = $('.build-label');
    if (buildLabel) buildLabel.textContent = `WINDOWS DESKTOP · ${info.version}`;
    const status = $('.statusbar > span:last-child');
    if (status) status.innerHTML = `Windows 桌面控制台<span class="footer-separator">/</span>版本 ${esc(info.version)}`;
    sync(info,true);
    ensureFrpConfig();
    ensureIPv6();
    window.zviewerDesktop.onUpdate(snapshot => sync(snapshot));
  }
  window.addEventListener('hashchange', () => setTimeout(ensureIPv6, 0));
  window.addEventListener('zviewer-ready',event=>init(event.detail));
  if (state.info?.live) init(state.info);
})();
