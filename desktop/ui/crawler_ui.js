(function () {
  'use strict';
  const ui = window.ZViewerUI;
  if (!ui || !window.zviewerDesktop) return;
  const { state, icon, esc, heading, button, notice } = ui;
  const $ = selector => document.querySelector(selector);
  let loading = false;

  function crawlerDefaults() {
    return { info: null, loading: false, starting: false, error: '', tab: 'agent', rules: [], ruleSource: '', selectedRules: {}, sessions: [], sessionId: '', sessionEffort: '', sessionModel: '', messages: [], submissions: [], challenges: [], libraries: [], librariesLoading: false, autoGenerate: false, repairEnabled: true, browser: null, loginBusy: false, chatBusy: false, autoTried: false, models: [], modelsLoading: false, modelError: '', settingsEffort: '', submissionEffort: '', chatDraft: '', chatImages: [], chatRuleRefs: [], mentionOpen: false, mentionQuery: '', mentionIndex: 0, mentionStart: 0, mentionEnd: 0, chatSending: false, queue: [], queueSeq: 0, runBusy: false, runId: '', runCursor: 0, runStatus: 'idle', runSteps: 0, generatingSession: '', loginUrl: '', loginSite: '', loginName: '', workOpen: {}, stepOpen: {} };
  }
  function cs() {
    // app.js 里的初始状态可能落后于本文件新增的字段，这里原地补齐，不能替换对象：
    // 异步回调持有同一个引用，换成新对象会丢状态并造成反复重载。
    if (!state.crawler) state.crawler = crawlerDefaults();
    const c = state.crawler;
    const defaults = crawlerDefaults();
    Object.keys(defaults).forEach(function (key) {
      if (typeof c[key] === 'undefined') c[key] = defaults[key];
    });
    return c;
  }
  function message(error) { return String(error && error.message ? error.message : error).replace(/^.*Error: /, ''); }
  function cmd(action, payload) { return window.zviewerDesktop.command(action, payload || {}); }
  async function api(method, path, body) {
    const result = await cmd('crawler-api', { method: method, path: path, body: body });
    const status = result && result.status || 0;
    const data = result && result.body || {};
    if (status >= 400) {
      const error = new Error(data.error || ('引擎返回状态 ' + status));
      error.status = status;
      error.data = data;
      throw error;
    }
    return data;
  }
  function renderIf() { if (state.page === 'crawler') ui.render(); }

  function ensure(force) {
    if (loading) return;
    const c = cs();
    if (!force && c.info) return;
    loading = true;
    c.loading = true;
    c.error = '';
    renderIf();
    cmd('crawler-info').then(function (info) {
      c.info = info;
      if (info && info.available && !info.running && !c.autoTried) {
        c.autoTried = true;
        c.starting = true;
        renderIf();
        return cmd('crawler-start').then(function (started) { c.info = started; }).catch(function (error) { c.error = message(error); });
      }
    }).then(function () {
      return loadData();
    }).catch(function (error) {
      c.error = message(error);
    }).then(function () {
      loading = false;
      c.loading = false;
      c.starting = false;
      renderIf();
    });
  }

  async function loadData() {
    const c = cs();
    try {
      const result = await cmd('crawler-rules');
      if (result && Array.isArray(result.rules)) {
      c.rules = result.rules;
      // 规则被删/改名后旧 id 会残留，导出选中前先就地清掉
      const alive = {};
      const previous = c.selectedRules || {};
      c.rules.forEach(function (item) { if (previous[item.id]) alive[item.id] = true; });
      c.selectedRules = alive;
    }
      c.ruleSource = result && result.source || 'engine';
    } catch (error) {
      c.error = message(error);
    }
    if (c.info && c.info.running) {
      try {
        const sessions = await api('GET', '/api/crawler/agent/sessions');
        c.sessions = sessions.sessions || [];
      } catch (error) { c.sessions = []; }
      try {
        const submissions = await api('GET', '/api/crawler/submissions');
        c.submissions = submissions.submissions || [];
      } catch (error) { c.submissions = []; }
      try {
        const challenges = await api('GET', '/api/crawler/challenges');
        c.challenges = challenges.challenges || [];
      } catch (error) { c.challenges = []; }
      try {
        const status = await api('GET', '/api/crawler/status');
        c.autoGenerate = Boolean(status.autoGenerate);
        c.repairEnabled = status.repairEnabled !== false;
        c.browser = status.browser || null;
        if (typeof status.reasoningEffort === 'string') c.settingsEffort = status.reasoningEffort;
        if (typeof status.submissionReasoningEffort === 'string') c.submissionEffort = status.submissionReasoningEffort;
        if (status.llmConfigured && !c.models.length && !c.modelsLoading) loadModels();
      } catch (error) { /* 状态读取失败不影响页面 */ }
      if (!c.sessionId && c.sessions.length) await loadSession(c.sessions[0].id);
    } else if (c.info && c.info.config) {
      c.autoGenerate = Boolean(c.info.config.autoGenerate);
      if (typeof c.info.config.reasoningEffort === 'string') c.settingsEffort = c.info.config.reasoningEffort;
      if (typeof c.info.config.submissionReasoningEffort === 'string') c.submissionEffort = c.info.config.submissionReasoningEffort;
    }
  }

  async function loadRules() {
    const result = await cmd('crawler-rules');
    const c = cs();
    if (result && Array.isArray(result.rules)) c.rules = result.rules;
    c.ruleSource = result && result.source || 'engine';
    renderIf();
  }

  async function loadSession(id) {
    stopSessionWatch();
    const c = cs();
    c.generatingSession = '';
    c.sessionId = id || '';
    c.messages = [];
    c.workOpen = {};
    c.stepOpen = {};
    c.chatDraft = '';
    c.chatImages = [];
    c.chatRuleRefs = [];
    closeMentions();
    c.queue = [];
    if (!id) { renderIf(); return; }
    try {
      const data = await api('GET', '/api/crawler/agent/sessions/' + encodeURIComponent(id));
      c.messages = (data.session && data.session.messages) || [];
      c.sessionEffort = (data.session && data.session.reasoningEffort) || '';
      c.sessionModel = (data.session && data.session.model) || '';
    } catch (error) {
      ui.toast(message(error));
    }
    renderIf();
  }

  function enginePill(c) {
    if (c.starting) return '<span class="pill"><i></i>启动中</span>';
    if (c.info && c.info.running) return '<span class="pill green"><i></i>运行中</span>';
    return '<span class="pill"><i></i>未启动</span>';
  }
  function fact(label, value) {
    return '<div class="crawler-fact"><span>' + label + '</span><code>' + esc(value == null || value === '' ? '—' : value) + '</code></div>';
  }
  function tag(text, tone) {
    return '<span class="pill ' + (tone || '') + '"><i></i>' + esc(text) + '</span>';
  }
  function statusCard(c) {
    const info = c.info || {};
    const config = info.config || {};
    const running = Boolean(info.running);
    const facts = [
      fact('引擎状态', running ? '正常' : '未运行'),
      fact('站点规则', String((info.ruleCount == null ? c.rules.length : info.ruleCount)) + ' 条'),
      fact('运行环境', '内置引擎（Go）'),
      fact('工作目录', info.root || ''),
      fact('API Key', config.apiKeyConfigured ? ('已配置 ' + (config.apiKeyMasked || '')) : '未配置'),
      fact('最后错误', info.lastError || c.error || '')
    ].join('');
    const controls = running
      ? button('停止引擎', 'crawler-stop', 'stop') + button('刷新', 'crawler-refresh', 'refresh')
      : button('启动引擎', 'crawler-start', 'play', 'primary') + button('刷新', 'crawler-refresh', 'refresh');
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('globe') + '</span><h2>引擎状态</h2></div>' + enginePill(c) + '</div><div class="crawler-facts">' + facts + '</div><div class="live-toolbar">' + controls + '</div><p class="field-note">引擎随后端运行。日志见左侧「运行日志」。</p></section>';
  }
  function tabs(c) {
    const pendingChallenges = (c.challenges || []).filter(function (item) { return !item.completed; }).length;
    // 顺序即使用频率：先对话（建规则的主路径），再规则/信息，最后才是验证与设置。
    const items = [['agent', 'Agent 对话'], ['rules', '站点规则'], ['about', '引擎信息'], ['challenges', '登录验证' + (pendingChallenges ? ' (' + pendingChallenges + ')' : '')], ['settings', '设置']];
    return '<div class="tabs crawler-tabs">' + items.map(function (item) {
      return '<button data-crawler-tab="' + item[0] + '" class="' + (c.tab === item[0] ? 'active' : '') + '">' + item[1] + '</button>';
    }).join('') + '</div>';
  }
  function visibilityLabel(rule) {
    if (rule.visibility === 'root') return '仅 root';
    const rooms = rule.allowedRooms || rule.allowed_rooms || [];
    return rooms.length ? ('指定 ' + rooms.length + ' 个房间') : '所有房间';
  }
  // 选中集合只存 id → true，导出时直接当 ids 用
  function selectedCount(c) { return Object.keys((c && c.selectedRules) || {}).length; }
  function ruleRow(rule) {
    const id = rule.id || '';
    const search = rule.search || {};
    const parse = rule.parse || {};
    const updated = rule.updated_at || rule.updatedAt || '';
    const disabled = rule.enabled === false;
    const selected = !!(cs().selectedRules || {})[id];
    return '<div class="crawler-rule' + (disabled ? ' disabled' : '') + (selected ? ' selected' : '') + '"><div class="crawler-rule-main"><div class="crawler-rule-title"><strong>' + esc(rule.name || id) + '</strong>' + (disabled ? tag('已停用') : '') + '</div><div class="crawler-rule-meta"><span>' + esc(rule.site || '') + '</span><span>' + esc(search.mode || 'http') + ' · ' + esc(parse.type || 'html') + '</span><span>' + esc(visibilityLabel(rule)) + '</span><span>' + esc(updated.slice(0, 19)) + '</span></div>' + (rule.description ? '<p class="field-note">' + esc(rule.description) + '</p>' : '') + '</div><div class="crawler-rule-actions"><button class="text-button" data-crawler-rule="' + esc(id) + '" data-crawler-do="select">' + (selected ? '取消选中' : '选中') + '</button><button class="text-button" data-crawler-rule="' + esc(id) + '" data-crawler-do="login">登录站点</button><button class="text-button" data-crawler-rule="' + esc(id) + '" data-crawler-do="toggle">' + (disabled ? '启用' : '停用') + '</button><button class="text-button" data-crawler-rule="' + esc(id) + '" data-crawler-do="edit">编辑</button><button class="text-button danger" data-crawler-rule="' + esc(id) + '" data-crawler-do="delete">删除</button></div></div>';
  }
  function challengeRow(item) {
    const id = item.id || '';
    const expires = Number(item.expiresAt || 0) * 1000;
    const left = expires ? Math.max(0, Math.round((expires - Date.now()) / 60000)) : 0;
    return '<div class="crawler-rule"><div class="crawler-rule-main"><div class="crawler-rule-title"><strong>' + esc(item.name || item.site || id) + '</strong>' + tag('待人工验证') + (item.cookies ? tag('已收 Cookie ' + item.cookies) : '') + '</div><div class="crawler-rule-meta"><span>' + esc(item.site || '') + '</span><span>搜索词 ' + esc(item.keyword || '') + '</span><span>HTTP ' + esc(String(item.status || '')) + '</span><span>' + esc(item.roomId ? ('房间 ' + item.roomId) : '控制台验证') + '</span><span>' + (left ? ('约 ' + left + ' 分钟后过期') : '已过期') + '</span></div><p class="field-note">' + esc(item.note || item.reason || '网站要求完成人机验证') + '</p><p class="field-note">验证页：' + esc(item.pageUrl || '') + '</p></div><div class="crawler-rule-actions"><button class="text-button" data-crawler-challenge="' + esc(id) + '" data-crawler-do="open">打开验证页</button><button class="text-button" data-crawler-challenge="' + esc(id) + '" data-crawler-do="verify">我已完成</button><button class="text-button danger" data-crawler-challenge="' + esc(id) + '" data-crawler-do="delete">删除</button></div></div>';
  }
  function challengesPanel(c) {
    const rows = (c.challenges || []).length ? c.challenges.map(challengeRow).join('') : '<div class="empty">无待处理验证。搜索遇到验证码、滑块或登录墙时在这里处理。</div>';
    const verify = '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('shield') + '</span><h2>人机验证</h2></div><small>' + (c.challenges || []).length + ' 条</small></div><div class="live-toolbar">' + button('刷新', 'crawler-challenges-refresh', 'refresh') + '</div><p class="field-note">「打开验证页」会在弹窗里打开站点页面；完成后点「我已完成」，引擎用同一会话重新抓取。</p><div class="crawler-rules">' + rows + '</div></section>';
    return verify + browserPanel(c);
  }
  /** 内置库来源：规则列表的只读分区，单条导入后才成本地规则。 */
  function librarySourcesSection(c) {
    const libraries = (c.libraries || []).filter(function (library) { return library.id !== 'local'; });
    const localNames = {};
    (c.rules || []).forEach(function (rule) { localNames[rule.name] = true; });
    const rows = [];
    libraries.forEach(function (library) {
      (library.sources || []).forEach(function (source) {
        const name = source.name || source.id || '';
        const imported = !!localNames[name];
        rows.push('<div class="crawler-rule"><div class="crawler-rule-main"><div class="crawler-rule-title"><strong>' + esc(name) + '</strong>' + tag(library.name || library.id) + (imported ? tag('已导入', 'green') : '') + '</div>' +
          '<div class="crawler-rule-meta"><span>' + esc(library.description || '') + '</span></div></div>' +
          '<div class="crawler-rule-actions">' +
          (imported ? '' : '<button class="text-button" data-crawler-library-import="' + esc(library.id) + '" data-crawler-library-source="' + esc(name) + '">导入</button>') +
          '</div></div>');
      });
    });
    const empty = c.librariesLoading ? '读取中…' : '三个内置库暂无来源；先在「设置 → 来源库」配置地址。';
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('server') + '</span><h2>内置库来源</h2></div><small>' + rows.length + ' 条</small></div>' +
      '<p class="field-note">这些条目在各自库里执行；「导入」后编译成本地规则，可编辑、试跑、导出。</p>' +
      '<div class="crawler-rules">' + (rows.length ? rows.join('') : '<div class="empty">' + esc(empty) + '</div>') + '</div></section>';
  }

  function rulesPanel(c) {
    const rows = c.rules.length ? c.rules.map(ruleRow).join('') : '<div class="empty">暂无规则。可在 Agent 对话生成，也可手动新建或导入。</div>';
    const local = c.ruleSource === 'local' ? '<p class="field-note">引擎未运行，当前显示本地规则文件；启动后可测试和保存。</p>' : '';
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('server') + '</span><h2>站点规则</h2></div><small>' + c.rules.length + ' 条</small></div><div class="live-toolbar">' + button('新建规则', 'crawler-rule-new', 'check') + button('规则文档', 'crawler-doc', 'book') + button('导入', 'crawler-import', 'download') + button('导出全部', 'crawler-export-all', 'folder') + (selectedCount(c) ? button('导出选中 (' + selectedCount(c) + ')', 'crawler-export-selected', 'check') : '') + (selectedCount(c) ? button('删除选中 (' + selectedCount(c) + ')', 'crawler-delete-selected', 'trash', 'danger') : '') + '</div>' + local + '<div class="crawler-rules">' + rows + '</div></section>';
  }
  const TOOL_LABELS = {
    fetch_page: '打开页面', inspect_html: '检查页面', test_rule: '试跑规则',
    save_rule: '保存规则', get_rule: '读取规则', update_rule: '更新规则', delete_rule: '删除规则', list_rules: '列出规则',
    list_accounts: '查看账号', save_account: '保存账号', bind_account: '绑定账号',
    browser_open: '打开浏览器', browser_text: '读取页面', browser_html: '读取 HTML', browser_eval: '执行脚本',
    browser_show: '显示登录窗口', browser_save_login: '保存登录态', browser_hide: '收起浏览器',
    inspect_challenge: '分析验证', detect_challenge_html: '检测验证',
    search_logs: '查询日志', task_complete: '完成任务', ask_user: '询问用户'
  };
  function toolLabel(name) { return TOOL_LABELS[name] || name || '工具'; }
  function clampText(value, limit) {
    const text = String(value == null ? '' : value);
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
  function argsSummary(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = ['url', 'keyword', 'name', 'site', 'selector', 'query', 'message', 'summary', 'rule_id', 'ruleId', 'account_id', 'limit'];
    for (let i = 0; i < keys.length; i += 1) {
      const value = args[keys[i]];
      if (typeof value === 'string' && value.trim()) return clampText(value.trim(), 72);
    }
    try { return clampText(JSON.stringify(args), 72); } catch (error) { return ''; }
  }
  function resultLine(summary) {
    if (!summary || typeof summary !== 'object') return '';
    if (summary.error) return '失败：' + clampText(summary.error, 90);
    if (summary.success === false) return '失败';
    const parts = [];
    if (summary.completed === true) parts.push('已完成');
    else if (summary.success === true) parts.push('完成');
    if (summary.count != null) parts.push(summary.count + ' 条');
    if (summary.ruleId) parts.push('规则 ' + summary.ruleId);
    if (summary.deleted) parts.push('已删除');
    if (summary.saved) parts.push('已保存');
    if (!parts.length && summary.message) parts.push(clampText(summary.message, 80));
    return parts.join(' · ');
  }
  function mergeRunEvents(target, incoming) {
    (incoming || []).forEach(function (event) {
      if (!event || !event.kind) return;
      if (event.kind === 'thinking' || event.kind === 'tool') {
        const id = event.id || (event.kind + '-' + (event.step || '') + '-' + (event.seq || ''));
        const copy = Object.assign({}, event, { id: id });
        const found = target.findIndex(function (item) { return item.kind === event.kind && item.id === id; });
        if (found >= 0) target[found] = copy;
        else target.push(copy);
      } else if (event.kind === 'note' || event.kind === 'continue') {
        target.push(Object.assign({}, event));
      }
    });
  }
  function eventsToSteps(events) {
    const steps = [];
    (events || []).forEach(function (event) {
      if (!event || !event.kind) return;
      if (event.kind === 'tool') {
        const last = steps[steps.length - 1];
        if (last && last.type === 'tool' && last.name === event.name) last.calls.push(event);
        else steps.push({ type: 'tool', name: event.name, calls: [event] });
      } else if (event.kind === 'thinking') steps.push({ type: 'thinking', event: event });
      else if (event.kind === 'note' || event.kind === 'continue') steps.push({ type: event.kind, event: event });
    });
    return steps;
  }
  function workCounts(steps) {
    let thinking = 0, tools = 0, failed = 0;
    steps.forEach(function (step) {
      if (step.type === 'thinking') thinking += 1;
      if (step.type === 'tool') {
        tools += step.calls.length;
        step.calls.forEach(function (call) { if (call.status === 'error') failed += 1; });
      }
    });
    return { thinking: thinking, tools: tools, failed: failed };
  }
  function workSummaryText(steps, pending) {
    let running = null;
    steps.forEach(function (step) {
      if (step.type === 'tool') step.calls.forEach(function (call) { if (call.status === 'running') running = call; });
    });
    if (running) return '第 ' + (running.step || 1) + ' 步 · ' + toolLabel(running.name);
    if (pending) return '分析中…';
    const counts = workCounts(steps);
    const parts = [];
    if (counts.thinking) parts.push('思考 ' + counts.thinking + ' 次');
    if (counts.tools) parts.push('调用 ' + counts.tools + ' 个工具');
    if (counts.failed) parts.push(counts.failed + ' 个失败');
    return parts.length ? parts.join(' · ') : '已完成';
  }
  function isOpen(map, key, fallback) {
    return typeof map[key] === 'boolean' ? map[key] : fallback;
  }
  function renderToolDetail(call, key) {
    const args = call.arguments && Object.keys(call.arguments).length ? JSON.stringify(call.arguments, null, 2) : '';
    const summary = call.summary && Object.keys(call.summary).length ? JSON.stringify(call.summary, null, 2) : (call.detail || '');
    let html = '';
    if (args) html += '<div class="crawler-wlabel">参数</div><pre class="crawler-wpre">' + esc(clampText(args, 4000)) + '</pre>';
    if (summary) html += '<div class="crawler-wlabel">结果</div><pre class="crawler-wpre">' + esc(clampText(summary, 4000)) + '</pre>';
    return html ? '<div class="crawler-wdetail" data-scroll-key="tool:' + key + '">' + html + '</div>' : '';
  }
  function renderNoteStep(step, index, idx, c) {
    const text = step.event.text || '';
    if (!text) return '';
    const kind = step.type === 'continue' ? 'refresh' : 'chat';
    return '<div class="crawler-wstep"><div class="crawler-wnode">' + icon(kind) + '</div><div class="crawler-wbody"><div class="crawler-wnote">' + esc(text) + '</div></div></div>';
  }
  function renderThinkingStep(step, index, idx, c) {
    const event = step.event;
    const key = 's' + index + '-' + idx;
    const done = event.done !== false;
    const open = isOpen(c.stepOpen, key, !done);
    const seconds = event.durationMs ? Math.max(1, Math.round(event.durationMs / 1000)) : 0;
    const title = done ? ('思考已完成' + (seconds ? ' · 用时 ' + seconds + ' 秒' : '')) : '思考中…';
    const body = open && event.text ? '<div class="crawler-wdetail crawler-wthink" data-scroll-key="think:' + key + '">' + esc(event.text) + '</div>' : '';
    return '<div class="crawler-wstep"><div class="crawler-wnode ' + (done ? '' : 'running') + '">' + icon('bulb') + '</div><div class="crawler-wbody"><button class="crawler-wrow ' + (done ? '' : 'running') + '" data-crawler-step="' + key + '"><span class="crawler-wrow-title">' + esc(title) + '</span><span class="crawler-wchev">›</span></button>' + body + '</div></div>';
  }
  function renderToolStep(step, index, idx, c) {
    const key = 's' + index + '-' + idx;
    const calls = step.calls || [];
    if (!calls.length) return '';
    const latest = calls[calls.length - 1];
    const running = calls.some(function (call) { return call.status === 'running'; });
    const failed = calls.filter(function (call) { return call.status === 'error'; }).length;
    const open = isOpen(c.stepOpen, key, false);
    const title = toolLabel(step.name) + (calls.length > 1 ? ' · ' + calls.length + ' 次' : '');
    const sub = running ? argsSummary(latest.arguments) : (failed ? failed + ' 个失败' : (calls.length > 1 ? '' : (resultLine(latest.summary) || argsSummary(latest.arguments))));
    let body = '';
    if (open) {
      if (calls.length > 1) {
        body = '<div class="crawler-wdetail crawler-wcalls" data-scroll-key="tool:' + key + '">' + calls.map(function (call) {
          const tone = call.status === 'error' ? 'failed' : (call.status === 'running' ? 'running' : 'ok');
          return '<div class="crawler-wcall"><span class="crawler-wdot ' + tone + '"></span><div class="crawler-wcall-main"><div class="crawler-wcall-title">' + esc(argsSummary(call.arguments) || toolLabel(call.name)) + '</div><div class="crawler-wcall-sub">' + esc(resultLine(call.summary) || '') + '</div></div></div>';
        }).join('') + '</div>';
      } else body = renderToolDetail(latest, key);
    }
    const tone = failed ? 'failed' : (running ? 'running' : '');
    return '<div class="crawler-wstep"><div class="crawler-wnode ' + tone + '">' + icon('wrench') + '</div><div class="crawler-wbody"><button class="crawler-wrow ' + tone + '" data-crawler-step="' + key + '"><span class="crawler-wrow-title">' + esc(title) + '</span><span class="crawler-wchev">›</span></button>' + (sub ? '<div class="crawler-wrow-sub">' + esc(sub) + '</div>' : '') + body + '</div></div>';
  }
  function renderWorkProcess(item, index, c) {
    const steps = eventsToSteps(item.events || []);
    const key = 'w' + index;
    const open = isOpen(c.workOpen, key, Boolean(item.pending));
    const running = Boolean(item.pending);
    let runningTool = null;
    steps.forEach(function (step) { if (step.type === 'tool') step.calls.forEach(function (call) { if (call.status === 'running') runningTool = call; }); });
    const headIcon = runningTool ? 'wrench' : (running ? 'bulb' : 'check');
    const headText = workSummaryText(steps, running);
    const body = open ? '<div class="crawler-work-body">' + steps.map(function (step, idx) {
      if (step.type === 'thinking') return renderThinkingStep(step, index, idx, c);
      if (step.type === 'tool') return renderToolStep(step, index, idx, c);
      return renderNoteStep(step, index, idx, c);
    }).join('') + '</div>' : '';
    return '<div class="crawler-work' + (open ? ' expanded' : '') + (running ? ' running' : '') + '"><button class="crawler-work-head" data-crawler-work="' + key + '"><span class="crawler-work-icon">' + icon(headIcon) + '</span><span class="crawler-work-title">' + esc(headText) + '</span><span class="crawler-work-chevron">›</span></button>' + body + '</div>';
  }
  function findRule(c, id) {
    return (c.rules || []).find(function (rule) { return rule.id === id; });
  }
  function referencedRules(ruleIds) {
    const c = cs();
    return (ruleIds || []).map(function (id) { return findRule(c, id); }).filter(Boolean).map(function (rule) {
      return { id: rule.id, name: rule.name || rule.id, site: rule.site || '' };
    });
  }
  function mentionCandidates(c, query) {
    const q = String(query || '').toLowerCase();
    return (c.rules || []).filter(function (rule) {
      if (!q) return true;
      return ((rule.name || '') + ' ' + (rule.site || '') + ' ' + (rule.id || '')).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 8);
  }
  function closeMentions() {
    const c = cs();
    c.mentionOpen = false;
    c.mentionQuery = '';
    c.mentionIndex = 0;
    const slot = document.getElementById('crawler-mentions');
    if (slot) { slot.hidden = true; slot.innerHTML = ''; }
  }
  function renderMentions() {
    const c = cs();
    const slot = document.getElementById('crawler-mentions');
    if (!slot) return;
    if (!c.mentionOpen) { slot.hidden = true; slot.innerHTML = ''; return; }
    const items = mentionCandidates(c, c.mentionQuery);
    if (!items.length) {
      slot.innerHTML = '<div class="crawler-mention-empty">无匹配规则</div>';
    } else {
      if (c.mentionIndex >= items.length) c.mentionIndex = items.length - 1;
      if (c.mentionIndex < 0) c.mentionIndex = 0;
      slot.innerHTML = items.map(function (rule, index) {
        return '<button type="button" class="crawler-mention' + (index === c.mentionIndex ? ' active' : '') + '" data-crawler-mention="' + esc(rule.id) + '"><span class="crawler-mention-name">@' + esc(rule.name || rule.id) + '</span><span class="crawler-mention-site">' + esc(rule.site || '') + '</span></button>';
      }).join('');
    }
    slot.hidden = false;
  }
  function mentionMatch(input) {
    if (!input) return null;
    const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const before = input.value.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return null;
    return { query: match[1], start: caret - match[1].length - 1, end: caret };
  }
  function updateMentions() {
    const c = cs();
    const input = document.getElementById('crawler-chat-input');
    const match = mentionMatch(input);
    if (!match) { closeMentions(); return; }
    c.mentionOpen = true;
    c.mentionQuery = match.query;
    c.mentionStart = match.start;
    c.mentionEnd = match.end;
    const items = mentionCandidates(c, match.query);
    if (c.mentionIndex >= items.length) c.mentionIndex = 0;
    renderMentions();
  }
  function selectMention(id) {
    const c = cs();
    const rule = findRule(c, id);
    const input = document.getElementById('crawler-chat-input');
    if (!rule || !input) return;
    const start = typeof c.mentionStart === 'number' ? c.mentionStart : input.selectionStart;
    const end = typeof c.mentionEnd === 'number' ? c.mentionEnd : input.selectionEnd;
    input.setRangeText('@' + (rule.name || rule.id) + ' ', start, end, 'end');
    if (c.chatRuleRefs.indexOf(rule.id) < 0) c.chatRuleRefs.push(rule.id);
    c.chatDraft = input.value;
    closeMentions();
    input.focus();
  }
  function attachmentsHtml(c) {
    const images = c.chatImages || [];
    return '<div class="crawler-attachments" id="crawler-attachments"' + (images.length ? '' : ' hidden') + '><div class="crawler-attachments-list">' + images.map(function (image) {
      return '<div class="crawler-attach-item"><img src="' + image.data + '" alt=""><button type="button" class="crawler-attach-remove" data-crawler-image-remove="' + esc(image.id) + '" title="移除图片" aria-label="移除图片">×</button></div>';
    }).join('') + '</div></div>';
  }
  function renderAttachments() {
    const c = cs();
    const slot = document.getElementById('crawler-attachments');
    if (!slot) return;
    const holder = document.createElement('div');
    holder.innerHTML = attachmentsHtml(c);
    const fresh = holder.firstChild;
    slot.innerHTML = fresh.innerHTML;
    slot.hidden = !(c.chatImages || []).length;
  }
  function imageEncode(canvas, quality) {
    return canvas.toDataURL('image/jpeg', quality);
  }
  function compressImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('不是图片文件')); return; }
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取图片失败')); };
      reader.onload = function () {
        const image = new Image();
        image.onerror = function () { reject(new Error('解析图片失败')); };
        image.onload = function () {
          try {
            const max = 1600;
            const scale = Math.min(1, max / Math.max(image.width || 1, image.height || 1));
            let width = Math.max(1, Math.round((image.width || 1) * scale));
            let height = Math.max(1, Math.round((image.height || 1) * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);
            let quality = 0.86;
            let data = imageEncode(canvas, quality);
            while (data.length > 2900000 && quality > 0.5) {
              quality -= 0.1;
              data = imageEncode(canvas, quality);
            }
            if (data.length > 2950000) {
              const smaller = document.createElement('canvas');
              const scale2 = 1200 / Math.max(width, height);
              smaller.width = Math.max(1, Math.round(width * scale2));
              smaller.height = Math.max(1, Math.round(height * scale2));
              const ctx2 = smaller.getContext('2d');
              ctx2.fillStyle = '#ffffff';
              ctx2.fillRect(0, 0, smaller.width, smaller.height);
              ctx2.drawImage(canvas, 0, 0, smaller.width, smaller.height);
              data = imageEncode(smaller, 0.75);
            }
            if (data.length > 2950000) { reject(new Error('图片过大')); return; }
            resolve({ id: 'img' + Date.now() + Math.random().toString(36).slice(2, 7), name: file.name || '图片', data: data });
          } catch (error) { reject(error); }
        };
        image.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }
  async function addImageFiles(files) {
    const c = cs();
    const list = Array.prototype.slice.call(files || []).filter(function (file) { return file && /^image\//.test(file.type || ''); });
    if (!list.length) return;
    for (let index = 0; index < list.length; index += 1) {
      if (c.chatImages.length >= 4) { ui.toast('最多添加 4 张图片'); break; }
      try {
        const image = await compressImageFile(list[index]);
        c.chatImages.push(image);
        renderAttachments();
      } catch (error) {
        ui.toast(message(error));
      }
    }
    const input = document.getElementById('crawler-chat-input');
    if (input) input.focus();
  }
  function chatMessage(item, index, c) {
    if (item.role === 'user') {
      const images = item.images || [];
      return '<div class="crawler-msg own"><div class="crawler-msg-body">' + (item.content ? esc(item.content) : '') + (images.length ? '<div class="crawler-msg-images">' + images.map(function (src) { return '<img src="' + src + '" alt="">'; }).join('') + '</div>' : '') + '</div></div>';
    }
    const events = item.events || [];
    let html = '<div class="crawler-msg agent">';
    if (events.length || item.pending) html += renderWorkProcess(item, index, c);
    if (item.content) html += '<div class="crawler-msg-body crawler-md">' + renderMarkdown(item.content) + '</div>';
    if (item.pending && !item.content && !events.length) html += '<div class="crawler-pending-hint">准备中…</div>';
    if (item.content) html += '<div class="crawler-msg-actions"><button class="crawler-icon-btn" data-crawler-copy="' + index + '" title="复制">' + icon('copy') + '</button></div>';
    html += '</div>';
    return html;
  }
  function messagesHtml(c) {
    if (!c.messages.length) {
      const suggestions = [
        '给这个站点生成电影搜索规则',
        '检查规则为什么抓不到结果',
        '配置人机验证并绑定登录态'
      ];
      return '<div class="crawler-chat-empty"><div class="crawler-chat-empty-icon">' + icon('chat') + '</div><strong>生成站点规则</strong><p>输入站点地址或要修的规则，完成抓取、试跑和保存。</p><div class="crawler-suggestions">' + suggestions.map(function (text) { return '<button class="crawler-suggest" data-crawler-suggest="' + esc(text) + '">' + esc(text) + '</button>'; }).join('') + '</div></div>';
    }
    return c.messages.map(function (item, index) { return chatMessage(item, index, c); }).join('');
  }
  function syncSessionSelect(c) {
    const select = $('#crawler-session');
    if (!select) return;
    select.innerHTML = '<option value="">新对话</option>' + c.sessions.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (item.id === c.sessionId ? ' selected' : '') + '>' + esc(item.title || item.id) + ' · ' + esc(item.turns || 0) + ' 轮</option>';
    }).join('');
    select.value = c.sessionId || '';
  }
  function queueHtml(c) {
    if (!c.queue.length) return '';
    return '<div class="crawler-queue"><div class="crawler-queue-head"><span>排队中 · ' + c.queue.length + ' 条</span><button type="button" class="crawler-queue-clear" data-action="crawler-queue-clear">清空</button></div><div class="crawler-queue-list">' + c.queue.map(function (item) {
      const images = item.images || [];
      const thumbs = images.length ? '<span class="crawler-queue-images">' + images.slice(0, 3).map(function (image) { return '<img src="' + image.data + '" alt="">'; }).join('') + (images.length > 3 ? '<i>+' + (images.length - 3) + '</i>' : '') + '</span>' : '';
      return '<div class="crawler-queue-row"><span class="crawler-queue-text">' + (item.text ? esc(item.text) : '') + thumbs + '</span><button type="button" class="crawler-queue-remove" data-crawler-queue-remove="' + esc(item.id) + '" title="移出队列" aria-label="移出队列">×</button></div>';
    }).join('') + '</div></div>';
  }
  function renderQueue(c) {
    const slot = $('#crawler-queue');
    if (slot) slot.innerHTML = queueHtml(c);
  }
  function renderChat(forceScroll) {
    if (state.page !== 'crawler' || cs().tab !== 'agent') return;
    const c = cs();
    const box = $('#crawler-chat');
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    // 运行中每 450ms 轮询都会重绘一次，展开的详情框（参数 JSON / 思考文本）会因 innerHTML 重建把滚动位置重置到顶部，
    // 这里先按 data-scroll-key 记住再恢复，否则用户没法在详情框里继续往下翻。
    const scrolls = {};
    box.querySelectorAll('[data-scroll-key]').forEach(function (el) { scrolls[el.getAttribute('data-scroll-key')] = el.scrollTop; });
    box.innerHTML = messagesHtml(c);
    box.querySelectorAll('[data-scroll-key]').forEach(function (el) {
      const top = scrolls[el.getAttribute('data-scroll-key')];
      if (typeof top === 'number' && top > 0) el.scrollTop = top;
    });
    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
    syncSessionSelect(c);
    renderQueue(c);
    renderAttachments();
    const status = $('#crawler-chat-status');
    if (status) status.textContent = c.chatSending ? '连接中…' : c.runBusy ? (c.runStatus === 'cancelling' ? '停止中…' : '执行中…') : (c.generatingSession ? '生成中…' : '就绪');
    const stop = $('#crawler-chat-stop');
    if (stop) stop.hidden = !c.runBusy;
    const send = $('#crawler-chat-send');
    if (send) {
      send.disabled = Boolean(c.chatSending);
      send.title = c.runBusy ? '加入队列，执行完毕后发送' : '发送';
    }
  }
  function modelId(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item.id === 'string') return item.id;
    if (item && typeof item.name === 'string') return item.name;
    return '';
  }
  function normalizeModels(raw) {
    return (raw || []).map(function (item) {
      const id = modelId(item);
      const ownedBy = (item && typeof item === 'object' && (item.ownedBy || item.owned_by)) || '';
      return { id: id, ownedBy: String(ownedBy) };
    }).filter(function (item) { return item.id; });
  }
  function modelOptions(c) {
    const current = c.sessionModel || '';
    const items = [['', '模型：跟随设置']].concat((c.models || []).map(function (item) { return [item.id, '模型：' + item.id]; }));
    if (current && !items.some(function (item) { return item[0] === current; })) items.push([current, '模型：' + current]);
    return items.map(function (item) {
      return '<option value="' + esc(item[0]) + '"' + (item[0] === current ? ' selected' : '') + '>' + esc(item[1]) + '</option>';
    }).join('');
  }

  function helpPanel() {
    return '<section class="panel crawler-help-panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('info') + '</span><h2>功能</h2></div></div><div class="crawler-help-grid"><div class="check-item">' + icon('globe') + '<div><strong>生成规则</strong><br>输入站点地址与搜索词，分析页面并试跑规则。</div></div><div class="check-item">' + icon('settings') + '<div><strong>修改规则</strong><br>说明抓取问题，读取现有规则后修改。</div></div><div class="check-item">' + icon('lock') + '<div><strong>登录站点</strong><br>打开浏览器窗口登录，保存登录态并绑定账号。</div></div></div><p class="field-note">MCP 客户端可通过工具增删改规则。</p></section>';
  }

  function agentPanel(c) {
    const options = c.sessions.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (item.id === c.sessionId ? ' selected' : '') + '>' + esc(item.title || item.id) + ' · ' + esc(item.turns || 0) + ' 轮</option>';
    }).join('');
    const effortOptions = EFFORT_LEVELS.map(function (item) {
      return '<option value="' + item[0] + '"' + (item[0] === (c.sessionEffort || '') ? ' selected' : '') + '>思考：' + item[1] + '</option>';
    }).join('');
    // 只保留会话切换和新建/删除；模型与思考强度移入输入框下方，按 DSH composer 布局。
    const sessions = '<div class="crawler-session-bar"><select id="crawler-session" aria-label="对话会话"><option value="">新对话</option>' + options + '</select>' + button('新会话', 'crawler-session-new', 'chat') + (c.sessionId ? button('重命名', 'crawler-session-rename', 'edit') : '') + (c.sessionId ? button('删除会话', 'crawler-session-delete', 'trash') : '') + '</div>';
    const compose = '<div class="crawler-compose-wrap"><div class="crawler-queue-slot" id="crawler-queue">' + queueHtml(c) + '</div><div class="crawler-compose"><div class="crawler-mentions" id="crawler-mentions" hidden></div>' + attachmentsHtml(c) + '<textarea id="crawler-chat-input" placeholder="描述要做什么，例如：给某影视站生成搜索规则。@ 引用规则" rows="2" autocomplete="off">' + esc(c.chatDraft || '') + '</textarea><div class="crawler-compose-row"><div class="crawler-compose-tools"><button type="button" class="crawler-attach" data-action="crawler-image-pick" title="添加图片" aria-label="添加图片">' + icon('image') + '</button><input type="file" id="crawler-image-input" accept="image/*" multiple hidden><select id="crawler-session-model" class="crawler-compose-select" aria-label="本会话模型" title="仅当前会话，下一条消息生效">' + modelOptions(c) + '</select><select id="crawler-session-reasoning" class="crawler-compose-select" aria-label="本会话思考强度" title="只影响当前会话">' + effortOptions + '</select></div><div class="crawler-compose-actions"><button type="button" class="crawler-stop-btn" id="crawler-chat-stop" data-action="crawler-chat-stop" title="停止生成" aria-label="停止生成" hidden>' + icon('stop') + '</button><button type="button" class="crawler-send-btn" id="crawler-chat-send" data-action="crawler-chat-send" title="发送" aria-label="发送">' + icon('arrow') + '</button></div></div></div></div>';
    return '<div class="crawler-agent"><section class="panel crawler-chat-panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('chat') + '</span><h2>Agent 对话</h2></div><small id="crawler-chat-status">' + (c.chatSending ? '连接中…' : c.runBusy ? '执行中…' : '就绪') + '</small></div>' + sessions + '<div class="crawler-chat" id="crawler-chat">' + messagesHtml(c) + '</div>' + compose + '</section>' + '</div>';
  }
  function aboutPanel(c) {
    return '<div class="crawler-about">' + statusCard(c) + helpPanel() + '</div>';
  }

  const SUBMISSION_STATUS = {
    pending: ['待处理', ''],
    queued: ['排队中', ''],
    processing: ['生成中', 'green'],
    done: ['已生成', 'green'],
    failed: ['失败', 'danger'],
    ignored: ['已忽略', '']
  };
  function submissionStatus(item) {
    const entry = SUBMISSION_STATUS[item.status] || [item.status || '未知', ''];
    const tone = entry[1] === 'danger' ? 'pill red' : entry[1] === 'green' ? 'pill green' : 'pill';
    let label = entry[0];
    if (item.status === 'queued' && item.queuePosition) label += ' · 第 ' + item.queuePosition + ' 位';
    return '<span class="' + tone + '"><i></i>' + esc(label) + '</span>';
  }
  function submissionRow(item) {
    const id = item.id || '';
    const ruleText = item.ruleName || item.ruleId ? '规则：' + (item.ruleName || item.ruleId) : '';
    const errorText = item.error ? '<p class="field-note">失败原因：' + esc(item.error) + '</p>' : '';
    const canGenerate = item.status !== 'processing' && item.status !== 'queued';
    return '<div class="crawler-rule"><div class="crawler-rule-main"><div class="crawler-rule-title"><strong>' + esc(item.name || item.site || id) + '</strong>' + submissionStatus(item) + (item.duplicate ? tag('重复提交') : '') + '</div><div class="crawler-rule-meta"><span>' + esc(item.site || '') + '</span><span>' + esc(item.url || '') + '</span><span>搜索词 ' + esc(item.keyword || '未填') + '</span><span>' + esc(item.roomName || item.roomId || '未带房间') + '</span><span>' + esc(item.submittedBy || '匿名成员') + '</span><span>' + esc((item.createdAt || '').slice(0, 19)) + '</span></div>' + (ruleText ? '<p class="field-note">' + esc(ruleText) + '</p>' : '') + errorText + '</div><div class="crawler-rule-actions">' + (canGenerate ? '<button class="text-button" data-crawler-submission="' + esc(id) + '" data-crawler-do="generate">生成规则</button>' : '') + (item.sessionId ? '<button class="text-button" data-crawler-submission="' + esc(id) + '" data-crawler-do="session">查看会话</button>' : '') + '<button class="text-button" data-crawler-submission="' + esc(id) + '" data-crawler-do="add">手动添加</button><button class="text-button danger" data-crawler-submission="' + esc(id) + '" data-crawler-do="delete">删除</button></div></div>';
  }
  function submissionsPanel(c) {
    const pending = c.submissions.filter(function (item) { return item.status === 'pending' || item.status === 'failed'; }).length;
    const rows = c.submissions.length ? c.submissions.map(submissionRow).join('') : '<div class="empty">暂无成员提交。提交记录显示在这里。</div>';
    const toggle = '<label class="check-item crawler-toggle"><input type="checkbox" id="crawler-auto-generate"' + (c.autoGenerate ? ' checked' : '') + '><div><strong>自动添加</strong><br>成员提交后自动生成搜索规则。</div></label>';
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('globe') + '</span><h2>成员提交</h2></div><small>' + c.submissions.length + ' 条 · ' + pending + ' 条待处理</small></div><div class="live-toolbar">' + button('手动提交站点', 'crawler-submission-new', 'plus', 'primary') + button('刷新', 'crawler-submissions-refresh', 'refresh') + '</div>' + toggle + '<p class="field-note">提交记录保存在 data/submissions.json。生成后可在「站点规则」调整。</p><div class="crawler-rules">' + rows + '</div></section>';
  }
  function browserPanel(c) {
    const b = c.browser || {};
    const localHint = b.available ? '' : '未检测到本机浏览器。';
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('globe') + '</span><h2>站点登录</h2></div><span class="pill green"><i></i>网页内登录</span></div><p class="field-note">点「打开登录页」会在弹窗里打开站点页面，直接在里面输入账号密码；登录完成后点「保存登录态」。</p><div class="form-row"><label class="field"><span>站点地址</span><input id="crawler-login-url" value="' + esc(c.loginUrl || '') + '" placeholder="https://example.com" autocomplete="off"></label><label class="field"><span>域名（可选）</span><input id="crawler-login-site" value="' + esc(c.loginSite || '') + '" placeholder="example.com" autocomplete="off"></label></div><label class="field"><span>账号名称（可选）</span><input id="crawler-login-name" value="' + esc(c.loginName || '') + '" placeholder="例如 站长账号" autocomplete="off"></label><div class="form-actions">' + button('打开登录页', 'crawler-login-open', 'globe', 'primary') + '</div><p class="field-note">' + esc(localHint) + '登录态保存在 data/accounts.json，可在规则里绑定账号。</p></section>';
  }
  const EFFORT_LEVELS = [['', '默认（不指定）'], ['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高']];
  function effortSelect(id, current, note) {
    const options = EFFORT_LEVELS.map(function (item) {
      return '<option value="' + item[0] + '"' + (item[0] === (current || '') ? ' selected' : '') + '>' + item[1] + '</option>';
    }).join('');
    return '<label class="field"><span>思考强度</span><select id="' + id + '">' + options + '</select><small>' + esc(note || '') + '</small></label>';
  }
  // 可用模型列表：直接平铺成按钮，点了就填进输入框。
  // 不用 datalist 是因为浏览器会按输入框里已有的文字过滤选项，看起来像「只有一个模型」。
  function modelChips(c) {
    if (!c.models.length) return '<div class="crawler-model-chips" id="crawler-model-chips" hidden></div>';
    return '<div class="crawler-model-chips" id="crawler-model-chips">' + c.models.map(function (item) {
      return '<button type="button" class="crawler-model-chip" data-crawler-model="' + esc(item.id) + '" title="' + esc(item.ownedBy || item.id) + '">' + esc(item.id) + '</button>';
    }).join('') + '</div>';
  }
  function settingsPanel(c) {
    const config = (c.info && c.info.config) || {};
    const modelValue = config.model && config.model !== 'undefined' ? config.model : '';
    const modelNote = c.modelsLoading ? '获取模型列表…' : (c.modelError ? ('获取失败：' + c.modelError) : (c.models.length ? ('可用 ' + c.models.length + ' 个模型，可直接输入或点下面的模型名') : '填入 Key 后可拉取模型列表，也可直接填写模型名'));
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('settings') + '</span><h2>大模型设置</h2></div><small>OpenAI 兼容接口</small></div><div class="form-row"><label class="field"><span>服务地址</span><input id="crawler-base-url" value="' + esc(config.baseUrl || '') + '" placeholder="https://api.deepseek.com/v1" autocomplete="off"></label><label class="field"><span>模型</span><input id="crawler-model" value="' + esc(modelValue) + '" placeholder="deepseek-chat" autocomplete="off"></label></div>' + modelChips(c) + '<label class="field"><span>API Key <small>' + (config.apiKeyConfigured ? '已保存' : '必填') + '</small></span><input id="crawler-api-key" type="password" placeholder="' + (config.apiKeyConfigured ? '已配置 ' + esc(config.apiKeyMasked || '') : 'sk-…') + '" autocomplete="off"></label><div class="form-actions">' + button('获取模型', 'crawler-models-load', 'refresh') + button('保存设置', 'crawler-config-save', 'check', 'primary') + '</div><p class="field-note" id="crawler-model-note">' + esc(modelNote) + '</p><div class="form-row">' + effortSelect('crawler-reasoning-effort', c.settingsEffort, '新会话默认强度') + effortSelect('crawler-submission-reasoning-effort', c.submissionEffort, '自动生成规则时的强度') + '</div>' + '<label class="field"><span>自定义提示词 <small>追加到系统提示词末尾</small></span><textarea id="crawler-custom-prompt" rows="4" maxlength="4000" placeholder="例如：优先使用 hls 线路；站点名取网页标题">' + esc(config.customPrompt || '') + '</textarea><span class="field-note">对生成、修复和对话生效。</span></label><label class="check-item crawler-toggle"><input type="checkbox" id="crawler-repair-enabled"' + (c.repairEnabled ? ' checked' : '') + '><div><strong>规则自动修复</strong><br>搜索失败时自动修复规则并重试，同一规则 10 分钟内最多一次。</div></label><p class="field-note">配置保存在 crawler/config.json。</p></section>' + librariesPanel(c);
  }

  // ----------------------------------------------------------- 来源库

  /** 读取四个库的状态与地址（本地规则 + 三个内置库，同一个接口）。 */
  async function loadLibraries(force) {
    const c = cs();
    if (c.librariesLoading) return;
    if (!force && (c.libraries || []).length) return;
    c.librariesLoading = true;
    renderIf();
    try {
      const data = await api('GET', '/api/crawler/libraries');
      c.libraries = data.libraries || [];
    } catch (error) {
      c.libraries = [];
      ui.toast(message(error));
    } finally {
      c.librariesLoading = false;
      renderIf();
    }
  }

  /** 导入某一条源（source 为空表示导入整个库）。 */
  async function importLibrarySource(kind, source) {
    if (!kind) return;
    try {
      const data = await api('POST', '/api/crawler/libraries/import', { kind: kind, source: source || '', dryRun: false });
      const saved = (data && data.saved) || 0;
      const skipped = ((data && data.items) || []).filter(function (item) { return item.skipped; });
      if (saved) ui.toast('已导入 ' + saved + ' 条规则');
      else if (skipped.length) ui.toast(skipped[0].skipped || '没有可导入的规则');
      else ui.toast('没有可导入的规则');
      await loadRules();
      await loadLibraries(true);
    } catch (error) {
      ui.toast(message(error));
    }
  }

  function libraryPill(library) {
    if (library.available) return tag('可用', 'green');
    return tag('未启用');
  }

  /** 来源库分区：设置页底部，和「大模型设置」并列。 */
  function librariesPanel(c) {
    const libraries = c.libraries || [];
    const rows = libraries.length
      ? libraries.map(function (library) {
          const urls = library.urls || [];
          return '<div class="crawler-rule"><div class="crawler-rule-main"><div class="crawler-rule-title"><strong>' + esc(library.name || library.id) + '</strong>' + libraryPill(library) + '<span class="crawler-rule-meta">' + esc((library.count || 0) + ' 个源') + '</span></div>' +
            (library.description ? '<p class="field-note">' + esc(library.description) + '</p>' : '') +
            (library.error ? '<p class="field-note">' + esc(library.error) + '</p>' : '') +
            (library.editable ? '<p class="field-note">' + esc(urls.length ? (urls.length + ' 个地址') : (library.note || '未配置地址')) + '</p>' : '') +
            '</div><div class="crawler-rule-actions">' +
            (library.id !== 'local' ? '<button class="text-button" data-crawler-library-import="' + esc(library.id) + '">导入为本地规则</button>' : '') +
            (library.editable ? '<button class="text-button" data-crawler-library="' + esc(library.id) + '">配置</button>' : '') +
            '</div></div>';
        }).join('')
      : '<div class="empty">' + esc(c.librariesLoading ? '读取中…' : '暂无来源库信息') + '</div>';
    return '<section class="panel"><div class="panel-heading"><div class="panel-heading-title"><span class="icon-box">' + icon('server') + '</span><h2>来源库</h2></div><small>' + libraries.length + ' 个</small></div><div class="live-toolbar">' + button('刷新', 'crawler-libraries-refresh', 'refresh') + '</div><p class="field-note">本地规则与三个内置库并列；点片时按库搜索。地址留空表示不启用，AniSubs 留空用内置订阅。</p><div class="crawler-rules">' + rows + '</div></section>';
  }

  function libraryModal(library) {
    const urls = (library.urls || []).join('\n');
    ui.modal(
      '<h2>' + esc(library.name || library.id) + '</h2>' +
      '<p class="field-note">' + esc(library.note || '每行一个地址') + '</p>' +
      '<textarea class="codebox config-editor" id="crawler-library-urls" rows="8" spellcheck="false" placeholder="https://…">' + esc(urls) + '</textarea>' +
      '<div class="modal-actions">' + button('取消', 'close-modal') +
        '<button class="btn primary" data-crawler-library-save="' + esc(library.id) + '">' + icon('check') + '保存</button>' +
      '</div>',
      { wide: true }
    );
  }

  async function saveLibrary(id) {
    const editor = $('#crawler-library-urls');
    if (!id || !editor) return;
    const urls = editor.value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
    try {
      await api('PUT', '/api/crawler/libraries/' + encodeURIComponent(id) + '/config', { urls: urls });
      const modal = $('#modal');
      if (modal) modal.close();
      await loadLibraries(true);
      ui.toast('已保存');
    } catch (error) {
      ui.toast(message(error));
    }
  }
  // ---------------------------------------------------------------- markdown
  function mdInline(text) {
    let out = esc(text);
    out = out.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }
  function mdCells(line) {
    return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); });
  }
  function mdTable(header, rows) {
    const head = mdCells(header).map(function (cell) { return '<th>' + mdInline(cell) + '</th>'; }).join('');
    const body = rows.map(function (row) {
      return '<tr>' + mdCells(row).map(function (cell) { return '<td>' + mdInline(cell) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="crawler-doc-table"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  function renderMarkdown(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = [];
    let index = 0;
    const isFence = function (line) { return line.indexOf('\x60\x60\x60') === 0; };
    const isBlockStart = function (line) { return /^(#{1,6}\s|\x60{3}|\||\s*[-*]\s)/.test(line); };
    while (index < lines.length) {
      const line = lines[index];
      if (isFence(line)) {
        index += 1;
        const buffer = [];
        while (index < lines.length && !isFence(lines[index])) { buffer.push(lines[index]); index += 1; }
        index += 1;
        out.push('<pre class="crawler-doc-code"><code>' + esc(buffer.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*$/.test(line)) { index += 1; continue; }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = Math.min(6, heading[1].length + 1);
        out.push('<h' + level + '>' + mdInline(heading[2]) + '</h' + level + '>');
        index += 1;
        continue;
      }
      if (line.charAt(0) === '|' && index + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].charAt(0) === '|') { rows.push(lines[index]); index += 1; }
        out.push(mdTable(line, rows));
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          items.push('<li>' + mdInline(lines[index].replace(/^\s*[-*]\s+/, '')) + '</li>');
          index += 1;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      const paragraph = [];
      while (index < lines.length && !/^\s*$/.test(lines[index]) && !isBlockStart(lines[index])) {
        paragraph.push(mdInline(lines[index]));
        index += 1;
      }
      if (paragraph.length) out.push('<p>' + paragraph.join('<br>') + '</p>');
      else index += 1;
    }
    return out.join('');
  }
  async function openDocs() {
    const doc = await cmd('crawler-doc');
    ui.modal('<h2>爬虫规则文档</h2><p class="field-note">' + esc(doc.path || '') + '</p><div class="crawler-doc">' + renderMarkdown(doc.content) + '</div><div class="modal-actions">' + button('关闭', 'close-modal') + '</div>');
  }

  // ----------------------------------------------------------- MCP 工具

  // 当前弹窗里选中的客户端。只影响文本框与路径提示，不参与渲染状态机。
  let mcpClient = 'claude';
  // 弹窗打开时缓存的命令、参数、客户端状态与部署提示词：切标签时不用再问一次后端。
  let mcpView = { command: '', args: [], clients: [], prompt: '' };

  // 手动配置的标签顺序：先桌面三家，再 Claude Code / Windsurf / Codex。
  const MCP_CLIENT_TABS = [
    ['claude', 'Claude Desktop'],
    ['claude-code', 'Claude Code'],
    ['cursor', 'Cursor'],
    ['vscode', 'VS Code'],
    ['windsurf', 'Windsurf'],
    ['codex', 'Codex']
  ];

  /** 各客户端的配置片段。VS Code 用 servers + type，Codex 是 TOML，其余都是 mcpServers。 */
  function mcpSnippets(command, args) {
    const entry = { command: command, args: args };
    const servers = JSON.stringify({ mcpServers: { 'zviewer-crawler': entry } }, null, 2);
    const toml = [
      '[mcp_servers.zviewer-crawler]',
      'command = ' + JSON.stringify(command),
      'args = ' + JSON.stringify(args)
    ].join('\n');
    return {
      claude: servers,
      'claude-code': servers,
      cursor: servers,
      windsurf: servers,
      vscode: JSON.stringify({ servers: { 'zviewer-crawler': Object.assign({ type: 'stdio' }, entry) } }, null, 2),
      codex: toml
    };
  }

  function mcpClientInfo(id) {
    const clients = mcpView.clients || [];
    for (let i = 0; i < clients.length; i += 1) {
      if (clients[i].id === id) return clients[i];
    }
    return null;
  }

  /** 标题区常驻入口：MCP 配置和引擎启停无关，放状态卡里会被「引擎信息」标签藏起来。 */
  function mcpButton() {
    return '<button class="btn" data-crawler-mcp-open="1">' + icon('terminal') + 'MCP 工具</button>';
  }

  function renderMcpConfig() {
    const textarea = $('#crawler-mcp-text');
    const hint = $('#crawler-mcp-path');
    const prompt = $('#crawler-mcp-prompt');
    const snippets = mcpSnippets(mcpView.command, mcpView.args);
    if (textarea) textarea.value = snippets[mcpClient] || '';
    if (prompt) prompt.value = mcpView.prompt || '';
    const client = mcpClientInfo(mcpClient);
    if (hint) {
      hint.textContent = client
        ? ('配置文件：' + (client.path || '—') + '　' + (client.hint || ''))
        : '粘进客户端的 MCP 配置文件。';
    }
    document.querySelectorAll('[data-mcp-client]').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.mcpClient === mcpClient);
    });
  }

  async function openMcp() {
    let info;
    try {
      info = await cmd('mcp-info');
    } catch (error) {
      ui.toast(message(error));
      return;
    }
    if (!info || info.available === false) {
      ui.toast((info && info.reason) || 'MCP 不可用');
      return;
    }
    const tools = info.tools || [];
    mcpView = {
      command: info.command || '',
      args: info.args || ['--mcp'],
      clients: info.clients || [],
      prompt: info.prompt || ''
    };
    const toolCount = tools.length
      ? tools.length + ' 个'
      : (info.engineReady ? '0 个' : '待服务启动');
    const list = tools.length
      ? '<ul class="mcp-tools">' + tools.map(function (tool) {
          return '<li><code>' + esc(tool.name || '') + '</code><span>' + esc(tool.description || '') + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="field-note">' + esc(info.toolsError || '工具清单暂不可用。') + '</p>';
    const source = info.toolsSource === 'stdio'
      ? '清单由 MCP 服务直连读出。'
      : '';
    ui.modal(
      '<h2>MCP 工具</h2>' +
      '<p class="field-note">通过 stdio 接入 MCP 客户端，调用爬虫工具：抓取页面、生成与测试规则、管理站点规则。</p>' +
      '<div class="crawler-facts">' +
        '<div class="crawler-fact wide"><span>命令</span><code>' + esc(info.command || '') + '</code></div>' +
        fact('参数', (info.args || []).join(' ')) +
        fact('工具', toolCount) +
        '<div class="crawler-fact wide"><span>数据目录</span><code>' + esc(info.root || '') + '</code></div>' +
      '</div>' +
      (info.commandExists ? '' : notice('未找到 zviewer-backend.exe，请构建或重装。', true)) +
      '<h3 class="mcp-tools-title">手动配置</h3>' +
      '<div class="tabs crawler-tabs" id="crawler-mcp-tabs">' + MCP_CLIENT_TABS.map(function (item) {
        return '<button data-mcp-client="' + item[0] + '"' + (item[0] === mcpClient ? ' class="active"' : '') + '>' + item[1] + '</button>';
      }).join('') + '</div>' +
      '<p class="field-note" id="crawler-mcp-path"></p>' +
      '<textarea class="codebox config-editor crawler-json" id="crawler-mcp-text" readonly spellcheck="false"></textarea>' +
      '<div class="mcp-actions"><button class="btn" data-crawler-mcp-copy="1">' + icon('copy') + '复制配置</button></div>' +
      '<h3 class="mcp-tools-title">工具清单' + (tools.length ? '（' + tools.length + '）' : '') + '</h3>' + list +
      (source ? '<p class="field-note">' + esc(source) + '</p>' : '') +
      '<h3 class="mcp-tools-title">部署提示词</h3>' +
      '<p class="field-note">发给可读写文件的 Agent，由它查找客户端配置、写入并校验。</p>' +
      '<textarea class="codebox config-editor crawler-json mcp-prompt" id="crawler-mcp-prompt" readonly spellcheck="false"></textarea>' +
      '<div class="mcp-actions"><button class="btn primary" data-crawler-mcp-prompt="1">' + icon('copy') + '复制部署提示词</button></div>' +
      '<div class="modal-actions">' + button('关闭', 'close-modal') + '</div>',
      { wide: true }
    );
    renderMcpConfig();
  }

  // ----------------------------------------------------------- manual submission
  function submissionModal() {
    ui.modal('<h2>手动提交站点</h2><p class="field-note">提交后可在 Agent 对话生成规则，过程可查看和继续调整。</p><label class="field"><span>站点地址</span><input id="crawler-new-url" placeholder="https://example.com" autocomplete="off"></label><div class="form-row"><label class="field"><span>站点名称（可选）</span><input id="crawler-new-name" placeholder="例如 示例影视" autocomplete="off"></label><label class="field"><span>想看的影片（可选）</span><input id="crawler-new-keyword" placeholder="测试关键词，默认 电影" autocomplete="off"></label></div><label class="field"><span>备注（可选）</span><input id="crawler-new-note" placeholder="例如 只能搜电影、需要登录" autocomplete="off"></label><div class="modal-actions">' + button('取消', 'close-modal') + button('提交', 'crawler-submission-save', 'check', 'primary') + '</div>');
  }
  async function saveSubmission() {
    const c = cs();
    const url = (($('#crawler-new-url') || {}).value || '').trim();
    if (!url) { ui.toast('请填写站点地址'); return; }
    const body = {
      url: url,
      name: (($('#crawler-new-name') || {}).value || '').trim(),
      keyword: (($('#crawler-new-keyword') || {}).value || '').trim(),
      note: (($('#crawler-new-note') || {}).value || '').trim()
    };
    try {
      const result = await api('POST', '/api/crawler/submissions', body);
      $('#modal').close();
      await refreshSubmissions();
      if (result.autoQueued) {
        const sub = result.submission || {};
        ui.toast(sub.status === 'queued'
          ? '已提交，队列第 ' + (sub.queuePosition || 1) + ' 位'
          : '已提交，正在生成规则');
        schedulePoll();
      } else if (result.duplicate) {
        ui.toast('站点已提交');
      } else {
        ui.toast(result.llmConfigured ? '已提交，可生成规则' : '已提交；配置 Key 后自动生成');
      }
    } catch (error) { ui.toast(message(error)); }
  }
  // 把正在跑的生成 run 接到当前会话上，实时显示 thinking/tool（排队后启动的任务也能看过程）。
  async function attachSubmissionRun(item) {
    const c = cs();
    if (!item || !item.runId || !item.sessionId || c.runBusy) return false;
    c.tab = 'agent';
    await loadSession(item.sessionId);
    c.messages.push({ role: 'assistant', content: '', pending: true, events: [] });
    c.runBusy = true;
    c.chatBusy = true;
    c.runStatus = 'running';
    c.runId = item.runId;
    c.runCursor = 0;
    c.runSteps = 0;
    c.generatingSession = '';
    stopSessionWatch();
    renderIf();
    renderChat(true);
    scrollChat();
    scheduleRunPoll();
    return true;
  }
  async function viewSubmissionSession(item, forceWatch) {
    if (!item || !item.sessionId) return;
    const c = cs();
    if (!c.sessions.some(function (entry) { return entry.id === item.sessionId; })) {
      try {
        const data = await api('GET', '/api/crawler/agent/sessions');
        c.sessions = data.sessions || [];
      } catch (error) { /* 会话列表拉取失败也可以直接打开 */ }
    }
    c.tab = 'agent';
    if (await attachSubmissionRun(item)) return;
    await loadSession(item.sessionId);
    if (forceWatch || item.status === 'queued' || item.status === 'processing' || item.status === 'pending') {
      c.generatingSession = item.sessionId;
      watchGeneratingSession(item.sessionId, item.id);
    }
    renderIf();
    // renderIf 只重绘整页 HTML，状态文案是硬编码的，这里再刷一次聊天区把「规则生成中…」显示出来。
    renderChat();
  }

  let sessionWatchTimer = null;
  function stopSessionWatch() {
    if (sessionWatchTimer) { clearInterval(sessionWatchTimer); sessionWatchTimer = null; }
  }
  // 成员提交的规则在后台线程里生成，期间会话里只有用户消息；这里每 2.5s 看一次提交状态，
  // 生成结束（成功/失败）就自动重载会话，避免用户停留在空会话 / 半截内容上。
  function watchGeneratingSession(sessionId, submissionId) {
    stopSessionWatch();
    const startedAt = Date.now();
    sessionWatchTimer = setInterval(async function () {
      const c = cs();
      if (!c.sessionId || c.sessionId !== sessionId) { stopSessionWatch(); return; }
      if (Date.now() - startedAt > 30 * 60 * 1000) { stopSessionWatch(); return; }
      try {
        const data = await api('GET', '/api/crawler/submissions');
        const item = (data.submissions || []).find(function (entry) { return entry.id === submissionId; });
        if (!item) return;
        // 排队中的任务轮到它时会带上 runId，这时把事件流接到会话上实时显示。
        if (item.status === 'processing' && item.runId) {
          stopSessionWatch();
          if (await attachSubmissionRun(item)) { ui.toast('已开始生成规则'); }
          return;
        }
        if (item.status === 'queued' || item.status === 'processing') return;
        stopSessionWatch();
        c.generatingSession = '';
        await loadSession(sessionId);
        ui.toast(item.status === 'done' ? '规则已生成' : '生成结束');
      } catch (error) { /* 轮询失败就等下一轮 */ }
    }, 2500);
  }
  let pollTimer = null;
  function hasActiveSubmissions() {
    return cs().submissions.some(function (item) { return item.status === 'queued' || item.status === 'processing'; });
  }
  function schedulePoll() {
    if (pollTimer || !hasActiveSubmissions()) return;
    pollTimer = window.setTimeout(async function () {
      pollTimer = null;
      await refreshSubmissions();
      if (hasActiveSubmissions()) schedulePoll();
    }, 2500);
  }

  function bodyFor(c) {
    if (c.starting) return '<section class="panel"><div class="empty">启动引擎…</div></section>';
    if (c.loading && !c.info) return '<section class="panel"><div class="empty">读取引擎状态…</div></section>';
    if (c.info && c.info.available === false) {
      return notice('爬虫引擎不可用：' + esc(c.info.reason || '未知原因') + '。启动引擎后重试。', true);
    }
    if (!c.info && c.error) return notice(esc(c.error), true);
    const content = c.tab === 'agent' ? agentPanel(c) : c.tab === 'about' ? aboutPanel(c) : c.tab === 'settings' ? settingsPanel(c) : c.tab === 'rules' ? rulesPanel(c) + librarySourcesSection(c) : c.tab === 'challenges' ? challengesPanel(c) : submissionsPanel(c);
    return tabs(c) + (c.error ? notice(esc(c.error), true) : '') + content;
  }
  function page() {
    const c = cs();
    if (!c.info && !c.loading) ensure(false);
    return heading('爬虫引擎', '生成影视站点搜索规则，供全网搜片使用。',
      enginePill(c) + button('刷新', 'crawler-refresh', 'refresh') + mcpButton()) + bodyFor(c);
  }

  function ruleModal(rule) {
    const initial = rule || { name: '', site: '', description: '', enabled: true, visibility: 'public', allowed_rooms: [], search: { mode: 'http', request: { url: 'https://example.com/search?q={keyword}', method: 'GET', headers: {} }, account_id: '' }, parse: { type: 'html', container: '.result', fields: { title: { selector: '.title' }, url: { selector: 'a', attr: 'href', absolute: true } } } };
    const json = JSON.stringify(initial, null, 2);
    ui.modal('<h2>' + (rule ? '编辑规则' : '新建规则') + '</h2><label class="field"><span>规则名称</span><input id="crawler-rule-name" value="' + esc(initial.name || '') + '" data-initial-name="' + esc(initial.name || '') + '" placeholder="例如：某某影视" autocomplete="off"></label><p class="field-note">保存后网页端立即显示该名称。</p><p class="field-note">JSON 规则。search.mode：http / script；parse.type：html / json / script。</p><textarea class="codebox config-editor crawler-json" id="crawler-rule-json" spellcheck="false" autocomplete="off">' + esc(json) + '</textarea><div class="modal-actions">' + button('取消', 'close-modal') + button('保存规则', 'crawler-rule-save', 'check', 'primary') + '</div>');
  }

  async function saveRule() {
    const editor = $('#crawler-rule-json');
    if (!editor) return;
    let rule;
    try { rule = JSON.parse(editor.value); } catch (error) { ui.toast('JSON 无效：' + message(error)); return; }
    const nameInput = $('#crawler-rule-name');
    const name = nameInput ? nameInput.value.trim() : '';
    const initialName = nameInput ? String(nameInput.dataset.initialName || '') : '';
    // 名称输入框改名时以输入框为准；如果只改了下方 JSON 里的 name，则沿用 JSON 的新名字。
    if (name && name !== initialName) rule.name = name;
    else if (!rule.name) rule.name = name;
    if (!rule.name) { ui.toast('请填写规则名称'); return; }
    await api('POST', '/api/crawler/rules', { rule: rule });
    $('#modal').close();
    await loadRules();
    ui.toast('规则已保存');
  }
  async function toggleRule(id) {
    const c = cs();
    const rule = c.rules.find(function (item) { return item.id === id; });
    if (!rule) return;
    const enabled = rule.enabled === false;
    await api('PUT', '/api/crawler/rules/' + encodeURIComponent(id), { patch: { enabled: enabled } });
    await loadRules();
    ui.toast(enabled ? '规则已启用' : '规则已停用');
  }
  async function deleteRule(id) {
    if (!id) return;
    if (!window.confirm('确定删除规则 ' + id + '？')) return;
    await api('DELETE', '/api/crawler/rules/' + encodeURIComponent(id));
    await loadRules();
    ui.toast('规则已删除');
  }
  // 批量删除：一次请求，服务端逐条删；返回里 missing 是已经不在的（不算错）。
  async function deleteSelectedRules() {
    const ids = Object.keys(cs().selectedRules || {});
    if (!ids.length) { ui.toast('选择要删除的规则'); return; }
    if (!window.confirm('确定删除选中的 ' + ids.length + ' 条规则？此操作不可撤销。')) return;
    const data = await api('POST', '/api/crawler/rules/batch-delete', { ids: ids });
    cs().selectedRules = {};
    await loadRules();
    const deleted = (data && data.deleted) || 0;
    const failed = Object.keys((data && data.failed) || {}).length;
    ui.toast(failed ? ('已删除 ' + deleted + ' 条，' + failed + ' 条失败') : ('已删除 ' + deleted + ' 条规则'));
    renderIf();
  }
  function scrollChat() {
    const box = $('#crawler-chat');
    if (box) box.scrollTop = box.scrollHeight;
  }
  function modelOptionsHtml(c) {
    return c.models.map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(item.ownedBy || item.id) + '</option>'; }).join('');
  }
  function setModelNote(text) {
    const note = $('#crawler-model-note');
    if (note) note.textContent = text;
  }
  async function loadModels() {
    const c = cs();
    if (c.modelsLoading) return;
    const config = (c.info && c.info.config) || {};
    const baseInput = $('#crawler-base-url');
    const keyInput = $('#crawler-api-key');
    const modelInput = $('#crawler-model');
    const baseUrl = baseInput ? baseInput.value.trim() : (config.baseUrl || '');
    const apiKey = keyInput ? keyInput.value.trim() : '';
    if (!apiKey && !config.apiKeyConfigured) {
      c.modelError = '请填写 API Key';
      setModelNote('请填写 API Key，再获取模型列表');
      ui.toast('请填写 API Key');
      return;
    }
    c.modelsLoading = true;
    c.modelError = '';
    setModelNote('正在获取模型列表…');
    try {
      const data = await api('POST', '/api/crawler/models', { baseUrl: baseUrl, apiKey: apiKey });
      if (!data.success) throw new Error(data.error || '获取模型列表失败');
      c.models = normalizeModels(data.models);
      if (!c.models.length) {
        c.modelError = '接口未返回模型';
        setModelNote('接口未返回模型，可直接填写模型名');
        return;
      }
      const chips = document.getElementById('crawler-model-chips');
      if (chips) {
        chips.outerHTML = modelChips(c);
      } else if (modelInput && modelInput.parentNode) {
        modelInput.parentNode.insertAdjacentHTML('afterend', modelChips(c));
      }
      if (modelInput) {
        const currentValue = modelInput.value.trim();
        if (!currentValue || currentValue === 'undefined') modelInput.value = c.models[0].id;
      }
      const sessionModelSelect = document.getElementById('crawler-session-model');
      if (sessionModelSelect) sessionModelSelect.innerHTML = modelOptions(c);
      setModelNote('可用 ' + c.models.length + ' 个模型，可直接输入或点下面的模型名');
      ui.toast('已获取 ' + c.models.length + ' 个可用模型');
    } catch (error) {
      c.modelError = message(error);
      setModelNote('获取失败：' + c.modelError);
      ui.toast(c.modelError);
    } finally {
      c.modelsLoading = false;
    }
  }
  async function setSessionEffort(effort) {
    const c = cs();
    c.sessionEffort = effort || '';
    if (!c.sessionId) { renderIf(); return; }
    try {
      const data = await api('PUT', '/api/crawler/agent/sessions/' + encodeURIComponent(c.sessionId), { reasoningEffort: c.sessionEffort });
      if (data.session && typeof data.session.reasoningEffort === 'string') c.sessionEffort = data.session.reasoningEffort;
      ui.toast('本会话思考强度已更新');
    } catch (error) { ui.toast(message(error)); }
    renderIf();
  }
  async function setSessionModel(model) {
    const c = cs();
    c.sessionModel = model || '';
    if (!c.sessionId) { renderIf(); return; }
    try {
      const data = await api('PUT', '/api/crawler/agent/sessions/' + encodeURIComponent(c.sessionId), { model: c.sessionModel });
      if (data.session && typeof data.session.model === 'string') c.sessionModel = data.session.model;
      await refreshSessions(c);
      ui.toast('本会话模型已切换，从下一条消息生效');
    } catch (error) { ui.toast(message(error)); }
    renderIf();
  }
  let runPollTimer = null;
  function scheduleRunPoll() {
    if (runPollTimer) window.clearTimeout(runPollTimer);
    runPollTimer = window.setTimeout(pollRun, 450);
  }
  async function refreshSessions(c) {
    try {
      const data = await api('GET', '/api/crawler/agent/sessions');
      c.sessions = data.sessions || [];
    } catch (error) { /* 会话列表刷新失败不影响本轮 */ }
  }
  function copyText(value, doneText) {
    const text = String(value || '');
    const done = doneText || '已复制';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { ui.toast(done); }).catch(function () { ui.toast('复制失败'); });
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); ui.toast(done); } catch (error) { ui.toast('复制失败'); }
    document.body.removeChild(area);
  }
  function runContext(ruleIds, text) {
    const refs = referencedRules(ruleIds).filter(function (rule) { return !text || text.indexOf('@' + rule.name) >= 0; });
    return refs.length ? { rules: refs } : undefined;
  }
  async function legacyChat(text, images, ruleIds) {
    const c = cs();
    try {
      const result = await api('POST', '/api/crawler/agent/chat', { sessionId: c.sessionId, message: text, reasoningEffort: c.sessionEffort || undefined, model: c.sessionModel || undefined, context: runContext(ruleIds, text), images: (images || []).map(function (image) { return image.data; }) });
      c.messages = result.messages || c.messages.concat([{ role: 'assistant', content: result.reply || '' }]);
      c.runBusy = false;
      c.chatBusy = false;
      c.runStatus = 'done';
      renderChat(true);
      scrollChat();
      await refreshSessions(c);
    } catch (error) {
      const last = c.messages[c.messages.length - 1];
      if (last && last.role === 'assistant') { last.pending = false; last.content = '请求失败：' + message(error); }
      c.runBusy = false;
      c.chatBusy = false;
      c.runStatus = 'error';
      renderChat(true);
      ui.toast(message(error));
    }
  }
  async function beginRun(text, images, ruleIds) {
    const c = cs();
    if (!c.info || !c.info.running) { ui.toast('引擎未运行，请先启动引擎'); return false; }
    c.error = '';
    if (!c.sessionId) {
      try {
        const created = await api('POST', '/api/crawler/agent/sessions', { reasoningEffort: c.sessionEffort || undefined, model: c.sessionModel || undefined });
        c.sessionId = created.session && created.session.id || '';
        if (created.session && typeof created.session.reasoningEffort === 'string') c.sessionEffort = created.session.reasoningEffort;
        if (created.session && typeof created.session.model === 'string') c.sessionModel = created.session.model;
      } catch (error) { ui.toast(message(error)); return false; }
    }
    const placeholder = { role: 'assistant', content: '', pending: true, events: [] };
    c.messages.push({ role: 'user', content: text, images: (images || []).map(function (image) { return image.data; }) });
    c.messages.push(placeholder);
    c.runBusy = true;
    c.chatBusy = true;
    c.runStatus = 'starting';
    c.runId = '';
    c.runCursor = 0;
    c.runSteps = 0;
    renderChat(true);
    scrollChat();
    try {
      let started;
      try {
        started = await api('POST', '/api/crawler/agent/runs', { sessionId: c.sessionId, message: text, reasoningEffort: c.sessionEffort || undefined, model: c.sessionModel || undefined, context: runContext(ruleIds, text), images: (images || []).map(function (image) { return image.data; }) });
      } catch (error) {
        if (error && error.status === 404) { await legacyChat(text, images, ruleIds); return true; }
        throw error;
      }
      c.runId = started.runId || '';
      if (started.sessionId) c.sessionId = started.sessionId;
      c.runStatus = 'running';
      if (!c.runId) throw new Error('引擎未返回 runId');
      renderChat();
      scheduleRunPoll();
    } catch (error) {
      placeholder.pending = false;
      placeholder.content = '请求失败：' + message(error);
      c.runBusy = false;
      c.chatBusy = false;
      c.runStatus = 'error';
      renderChat(true);
      ui.toast(message(error));
    }
    return true;
  }
  async function startRunMessage(text, images, ruleIds) {
    const c = cs();
    if (c.chatSending || c.runBusy) return false;
    c.chatSending = true;
    renderChat();
    try { return await beginRun(text, images, ruleIds); }
    finally { c.chatSending = false; renderChat(); }
  }
  function enqueueChat(text, images, ruleIds) {
    const c = cs();
    if (!text && !(images || []).length) return;
    if (c.queue.length >= 20) { ui.toast('排队消息最多 20 条'); return; }
    c.queueSeq += 1;
    c.queue.push({ id: 'q' + c.queueSeq, text: text, images: images || [], ruleIds: ruleIds || [] });
    c.chatDraft = '';
    c.chatImages = [];
    c.chatRuleRefs = [];
    closeMentions();
    const input = $('#crawler-chat-input');
    if (input) input.value = '';
    renderAttachments();
    renderChat(true);
    ui.toast('已加入队列，当前任务结束后自动发送');
  }
  async function startNextQueued() {
    const c = cs();
    if (c.runBusy || c.chatSending || !c.queue.length) return;
    const next = c.queue.shift();
    if (!next) return;
    renderChat(true);
    const ok = await startRunMessage(next.text, next.images || [], next.ruleIds || []);
    if (!ok) {
      c.queue.unshift(next);
      renderChat();
    }
  }
  async function sendChat() {
    const input = $('#crawler-chat-input');
    const c = cs();
    if (!input || c.chatSending) return;
    const text = input.value.trim();
    const images = (c.chatImages || []).slice();
    const ruleIds = (c.chatRuleRefs || []).slice();
    if (!text && !images.length) { ui.toast(c.runBusy ? '回车加入队列' : '请输入内容或添加图片'); return; }
    if (c.runBusy) { enqueueChat(text, images, ruleIds); return; }
    input.value = '';
    c.chatDraft = '';
    c.chatImages = [];
    c.chatRuleRefs = [];
    closeMentions();
    renderAttachments();
    const ok = await startRunMessage(text, images, ruleIds);
    if (!ok) {
      c.chatDraft = text;
      c.chatImages = images;
      c.chatRuleRefs = ruleIds;
      if (input) input.value = text;
      renderAttachments();
      renderChat();
    }
  }
  async function pollRun() {
    runPollTimer = null;
    const c = cs();
    if (!c.runBusy || !c.runId) return;
    let payload;
    try {
      payload = await api('GET', '/api/crawler/agent/runs/' + encodeURIComponent(c.runId) + '?cursor=' + encodeURIComponent(c.runCursor || 0));
    } catch (error) {
      await finishRun({ status: 'error', error: message(error), reply: '' });
      return;
    }
    // 引擎返回 {success, run:{status,events,nextCursor,done,...}}，这里必须解包，
    // 否则 events/done 全是 undefined，会一直空轮询、界面永远停在「正在执行」。
    const snap = (payload && payload.run) ? payload.run : (payload || {});
    const msg = c.messages[c.messages.length - 1];
    if (msg && msg.role === 'assistant' && msg.pending) {
      msg.events = msg.events || [];
      mergeRunEvents(msg.events, snap.events || []);
    }
    c.runCursor = Number(snap.nextCursor || c.runCursor || 0);
    c.runSteps = Number(snap.steps || 0);
    c.runStatus = snap.status || 'running';
    renderChat();
    if (snap.done) { await finishRun(snap); return; }
    scheduleRunPoll();
  }
  async function finishRun(snap) {
    const c = cs();
    if (runPollTimer) { window.clearTimeout(runPollTimer); runPollTimer = null; }
    const status = snap && snap.status || 'done';
    c.runBusy = false;
    c.chatBusy = false;
    c.runStatus = status;
    c.runId = '';
    c.runCursor = 0;
    c.runSteps = 0;
    const msg = c.messages[c.messages.length - 1];
    if (msg && msg.role === 'assistant') {
      msg.pending = false;
      if (snap && snap.reply) msg.content = snap.reply;
      if (!msg.content) {
        if (status === 'cancelled') msg.content = '已停止生成。';
        else if (status === 'error') msg.content = '请求失败：' + ((snap && snap.error) || '未知错误');
        else msg.content = '（模型未返回内容）';
      }
    }
    renderChat();
    await refreshSessions(c);
    // 生成规则 run 结束后提交状态会被引擎回写，这里同步刷新成员提交列表。
    try { await refreshSubmissions(); } catch (error) { /* 列表刷新失败不阻塞对话 */ }
    renderChat();
    if (c.tab === 'rules') { loadRules().catch(function () { /* 规则页刷新失败不阻塞对话 */ }); }
    // 当前任务结束后自动继续执行排队消息。
    if (c.queue.length) await startNextQueued();
  }
  async function stopChat() {
    const c = cs();
    if (!c.runId) return;
    c.runStatus = 'cancelling';
    renderChat();
    try {
      await api('POST', '/api/crawler/agent/runs/' + encodeURIComponent(c.runId) + '/cancel');
      ui.toast('已请求停止');
    } catch (error) { ui.toast(message(error)); }
  }
  async function refreshSubmissions() {
    const c = cs();
    try {
      const data = await api('GET', '/api/crawler/submissions');
      c.submissions = data.submissions || [];
    } catch (error) { ui.toast(message(error)); }
    renderIf();
    schedulePoll();
  }
  async function refreshBrowser() {
    const c = cs();
    try {
      const status = await api('GET', '/api/crawler/status');
      c.autoGenerate = Boolean(status.autoGenerate);
      c.browser = status.browser || null;
    } catch (error) { ui.toast(message(error)); }
    renderIf();
  }
  async function generateSubmission(id) {
    const c = cs();
    if (!id) return;
    try {
      // 和人工操作完全一致：新建会话 + 发一条消息，再接管这次 run 的事件流。
      // 引擎保证同一时间只跑一个生成任务，忙的时候会排队，结束后自动开始。
      const started = await api('POST', '/api/crawler/submissions/' + encodeURIComponent(id) + '/run', {
        reasoningEffort: c.submissionEffort || undefined
      });
      if (!started || !started.success) {
        throw new Error((started && started.error) || '引擎拒绝生成请求');
      }
      if (started.queued && !started.runId) {
        await refreshSubmissions();
        ui.toast(started.running
          ? '这个站点正在生成规则，完成后可查看会话'
          : (started.position
            ? '已加入生成队列（第 ' + started.position + ' 位），上一个任务结束后自动开始'
            : '已加入生成队列，上一个任务结束后自动开始'));
        schedulePoll();
        return;
      }
      if (!started.runId || !started.sessionId) {
        throw new Error((started && started.error) || '引擎未返回 runId');
      }
      const prompt = String(started.message || '').trim();
      c.tab = 'agent';
      await loadSession(started.sessionId);
      if (!c.messages.some(function (msg) { return msg.role === 'user' && String(msg.content || '').trim() === prompt; })) {
        c.messages.push({ role: 'user', content: prompt });
      }
      c.messages.push({ role: 'assistant', content: '', pending: true, events: [] });
      c.runBusy = true;
      c.chatBusy = true;
      c.runStatus = 'running';
      c.runId = started.runId;
      c.runCursor = 0;
      c.runSteps = 0;
      c.generatingSession = '';
      stopSessionWatch();
      renderIf();
      renderChat(true);
      scrollChat();
      scheduleRunPoll();
      ui.toast('已新建会话，正在生成规则');
    } catch (error) { ui.toast(message(error)); }
  }
  function submissionRule(item) {
    const site = item.site || '';
    return {
      name: item.name || site,
      site: site,
      description: '由成员提交的站点（' + (item.submittedBy || '匿名') + '）',
      enabled: true,
      visibility: 'public',
      allowed_rooms: [],
      search: { mode: 'http', request: { url: 'https://' + site + '/search?q={keyword}', method: 'GET', headers: {} }, account_id: '' },
      parse: { type: 'html', container: '.result', fields: { title: { selector: '.title' }, url: { selector: 'a', attr: 'href', absolute: true } } }
    };
  }
  async function deleteSubmission(id) {
    if (!id || !window.confirm('确定删除这条成员提交？')) return;
    try {
      await api('DELETE', '/api/crawler/submissions/' + encodeURIComponent(id));
      await refreshSubmissions();
      ui.toast('提交已删除');
    } catch (error) { ui.toast(message(error)); }
  }
  async function setAutoGenerate(enabled) {
    const c = cs();
    try {
      await api('PUT', '/api/crawler/config', { submissions: { auto_generate: Boolean(enabled) } });
      c.autoGenerate = Boolean(enabled);
      ui.toast(enabled ? '自动添加已开启' : '自动添加已关闭');
    } catch (error) {
      ui.toast(message(error));
    }
    renderIf();
  }
  async function setRepair(enabled) {
    const c = cs();
    try {
      await api('PUT', '/api/crawler/config', { repair: { enabled: Boolean(enabled) } });
      c.repairEnabled = Boolean(enabled);
      ui.toast(enabled ? '规则自动修复已开启' : '规则自动修复已关闭');
    } catch (error) {
      ui.toast(message(error));
    }
    renderIf();
  }
  function loginSite() {
    const siteInput = $('#crawler-login-site');
    const urlInput = $('#crawler-login-url');
    let site = ((siteInput && siteInput.value) || '').trim().toLowerCase();
    if (!site && urlInput && urlInput.value.trim()) {
      try { site = new URL(urlInput.value.trim()).hostname; } catch (error) { site = ''; }
    }
    return site.replace(/^www./, '');
  }
  // 网页内登录：先向后端要一个登录会话，再把同源反代地址塞进 iframe 弹窗。
  // Cookie 由引擎的登录会话收集（第一方 Cookie），保存后落成账号；Linux 没有本机浏览器也能用。
  async function openLogin(urlOverride) {
    const c = cs();
    const nameInput = $('#crawler-login-name');
    // 从规则列表「去登录」进来时 DOM 里没有账号名输入框，回退到 c.loginName（规则名）。
    const name = (nameInput && nameInput.value.trim()) || (c.loginName || '').trim() || '';
    let url = String(urlOverride || '').trim();
    if (!url) {
      const urlInput = $('#crawler-login-url');
      url = (urlInput && urlInput.value.trim()) || '';
      if (!url) {
        const guess = loginSite();
        if (guess) url = 'https://' + guess;
      }
    }
    if (!url || url === 'https://') { ui.toast('请填写站点地址'); return; }
    const site = loginSite() || hostOf(url);
    c.loginSite = site;
    if ($('#crawler-login-url')) $('#crawler-login-url').value = url;
    if ($('#crawler-login-site')) $('#crawler-login-site').value = site;
    renderIf();
    let session = null;
    try {
      session = await api('POST', '/api/crawler/login/session', { site: site, url: url });
    } catch (error) {
      ui.toast('打开登录页失败：' + message(error));
      return;
    }
    const id = (session && session.id) || '';
    if (!id) { ui.toast('登录会话创建失败，请重试'); return; }
    const sessionSite = session.site || site;
    const label = sessionSite || hostOf(url) || site;
    openSiteModal({
      kind: 'login',
      id: id,
      site: sessionSite,
      name: name || (label ? label + ' 登录' : '登录账号'),
      url: session.url || url,
      src: session.proxyUrl || siteSessionSrc(id)
    });
  }
  function ruleSite(rule) {
    let site = String((rule && rule.site) || '').trim().toLowerCase();
    if (!site) {
      try { site = new URL(((rule.search || {}).request || {}).url || '').hostname; } catch (error) { site = ''; }
    }
    return site.replace(/^www\./, '');
  }
  async function startSiteLogin(ruleId) {
    const c = cs();
    const rule = (c.rules || []).find(function (item) { return item.id === ruleId; });
    if (!rule) { ui.toast('找不到这条规则'); return; }
    const site = ruleSite(rule);
    if (!site) { ui.toast('这条规则没有站点域名，无法启动登录'); return; }
    c.tab = 'challenges';
    c.loginUrl = 'https://' + site;
    c.loginSite = site;
    c.loginName = rule.name || '';
    renderIf();
    await openLogin(c.loginUrl);
  }

  async function refreshChallenges() {
    const c = cs();
    const data = await api('GET', '/api/crawler/challenges');
    c.challenges = data.challenges || [];
    renderIf();
  }
  // ---------------- 网页内登录 / 站点验证（同源反代 iframe） ----------------
  // 弹窗用 iframe 打开 /api/crawler/challenge/<id>/site：浏览器只看到自己来源下的路径，
  // Cookie 是第一方 Cookie，登录与人机验证都在普通浏览器里完成（Linux 无本机浏览器也能用）。
  // 纯前端路由的 SPA（腾讯视频等）反代页可能异常，这类站点以后单独处理。
  let siteView = null; // 当前反代弹窗会话；同一时间只允许开一个。

  function hostOf(url) {
    try { return new URL(String(url || '')).hostname.replace(/^www\./, ''); } catch (error) { return ''; }
  }
  // 后端返回的反代根路径（/api/crawler/challenge/<id>/site），控制台与网页端都会转给后端。
  function siteSessionSrc(id) {
    return '/api/crawler/challenge/' + encodeURIComponent(id) + '/site';
  }
  function siteProxyBase(current) {
    return String((current && current.proxySrc) || '').replace(/\/+$/, '');
  }
  function setSiteLoading(text) {
    const current = siteView;
    if (!current || !current.loading) return;
    if (text) {
      current.loading.textContent = String(text);
      current.loading.hidden = false;
    } else {
      current.loading.hidden = true;
    }
  }
  // 反代页与本页同源，能直接读 iframe 的地址：把站点路径还原成真实地址显示在工具栏。
  function syncSiteAddress() {
    const current = siteView;
    if (!current || current.closed || !current.iframe) return;
    const input = current.urlInput;
    if (!input || document.activeElement === input) return;
    let path = '';
    let search = '';
    try {
      const loc = current.iframe.contentWindow.location;
      const base = siteProxyBase(current);
      if (loc && loc.pathname && base && loc.pathname.indexOf(base) === 0) {
        path = loc.pathname.slice(base.length) || '/';
        search = loc.search || '';
      }
    } catch (error) { return; }
    if (!path) return;
    input.value = 'https://' + (current.site || '') + path + search;
  }
  // 「前往」只允许在同一个站点域名内跳转：把真实地址换算回反代路径。
  function navigateSiteView(raw) {
    const current = siteView;
    if (!current || current.closed || !current.iframe) return;
    const value = String(raw || '').trim();
    if (!value) return;
    let parsed = null;
    try { parsed = new URL(value); } catch (error) { ui.toast('请填写完整地址，例如 https://example.com'); return; }
    const host = parsed.hostname.replace(/^www\./, '');
    if (current.site && host && host !== current.site) { ui.toast('只能在这个站点的域名内跳转'); return; }
    const base = siteProxyBase(current);
    if (!base) return;
    setSiteLoading('正在加载站点页面…');
    current.iframe.src = base + (parsed.pathname || '/') + (parsed.search || '');
  }
  function refreshSiteView() {
    const current = siteView;
    if (!current || current.closed || !current.iframe) return;
    setSiteLoading('正在刷新站点页面…');
    try {
      current.iframe.contentWindow.location.reload();
    } catch (error) {
      current.iframe.src = current.iframe.src;
    }
  }
  function openSiteModal(options) {
    const opts = options || {};
    const isLogin = opts.kind === 'login';
    const site = opts.site || hostOf(opts.url) || '';
    const label = site || '站点';
    const src = opts.src || siteSessionSrc(opts.id);
    if (siteView) closeSiteView();
    if (!src) { ui.toast('登录会话创建失败，请重试'); return; }
    const title = (isLogin ? '网页内登录 · ' : '站点验证 · ') + label;
    const hint = isLogin
      ? '在这个窗口里完成登录，完成后点「保存登录态」。'
      : '在这个窗口里完成人机验证，完成后点「我已完成」，引擎会用同一会话重新抓取。';
    const primary = isLogin
      ? button('保存登录态', 'crawler-site-save', 'check', 'primary')
      : button('我已完成', 'crawler-site-verify', 'check', 'primary');
    ui.modal(
      '<h2>' + esc(title) + '</h2><p class="field-note">' + esc(hint) + '</p>' +
      '<div class="crawler-site-frame"><iframe id="crawler-site-iframe" src="' + esc(src) + '" referrerpolicy="same-origin"></iframe><div class="crawler-site-loading">正在加载站点页面…</div></div>' +
      '<div class="crawler-site-toolbar"><input id="crawler-site-url" class="crawler-site-url" value="' + esc(opts.url || '') + '" placeholder="https://example.com" spellcheck="false" autocomplete="off" aria-label="页面地址">' +
      button('前往', 'crawler-site-go', 'link') + button('刷新', 'crawler-site-refresh', 'refresh') + primary + button('关闭', 'crawler-site-close') + '</div>',
      { wide: true }
    );
    const iframe = $('#crawler-site-iframe');
    siteView = {
      kind: isLogin ? 'login' : 'challenge',
      id: opts.id || '',
      site: site,
      name: opts.name || '',
      proxySrc: src,
      iframe: iframe,
      loading: document.querySelector('.crawler-site-loading'),
      urlInput: $('#crawler-site-url'),
      closed: false
    };
    if (iframe) {
      iframe.addEventListener('load', function () {
        if (!siteView || siteView.closed || siteView.iframe !== iframe) return;
        setSiteLoading('');
        syncSiteAddress();
      });
    }
  }
  function closeSiteView() {
    const current = siteView;
    siteView = null;
    if (current) {
      current.closed = true;
      // 断开加载，避免隐藏的 iframe 继续在后台跑。
      if (current.iframe) current.iframe.removeAttribute('src');
      // 登录会话用完即删（Cookie 已存成账号或用户放弃）；验证会话保留，方便稍后重试。
      if (current.kind === 'login' && current.id) {
        api('DELETE', '/api/crawler/login/' + encodeURIComponent(current.id)).catch(function () {});
      }
    }
    const dialog = $('#modal');
    if (dialog && dialog.open) dialog.close();
  }
  async function saveSiteLogin() {
    const current = siteView;
    if (!current) { ui.toast('登录窗口已关闭，请重新打开'); return; }
    if (!current.id) { ui.toast('登录会话已失效，请重新打开登录页'); return; }
    const site = current.site || hostOf(current.urlInput ? current.urlInput.value : '');
    const name = current.name || (site ? site + ' 登录' : '站点 登录');
    try {
      await api('POST', '/api/crawler/login/' + encodeURIComponent(current.id) + '/save', { site: site, name: name });
      closeSiteView();
      ui.toast('已保存登录态：' + name);
      await refreshBrowser();
    } catch (error) { ui.toast(message(error)); }
  }
  async function verifySiteChallenge() {
    const current = siteView;
    if (!current || !current.id) { ui.toast('验证会话已失效，请刷新列表'); return; }
    const id = current.id;
    try {
      const data = await api('POST', '/api/crawler/challenge/' + encodeURIComponent(id) + '/verify');
      const result = (data && data.result) || {};
      const count = Number(result.count || (result.items || []).length || 0);
      closeSiteView();
      await refreshChallenges();
      ui.toast('验证通过，已获取 ' + count + ' 条结果');
    } catch (error) {
      // 验证失败不关窗：用户通常还要在同一个页面里再操作一次。
      ui.toast(message(error));
    }
  }
  function openChallenge(id) {
    const item = (cs().challenges || []).find(function (entry) { return entry.id === id; });
    if (!item) { ui.toast('验证会话不存在，请刷新列表'); return; }
    const site = item.site || item.name || '';
    const url = item.pageUrl || item.url || (site ? 'https://' + site : '');
    if (!url) { ui.toast('验证页地址未就绪，请刷新'); return; }
    openSiteModal({ kind: 'challenge', id: id, site: site, url: url, src: siteSessionSrc(id) });
  }
  async function verifyChallenge(id) {
    const data = await api('POST', '/api/crawler/challenge/' + encodeURIComponent(id) + '/verify');
    const result = (data && data.result) || {};
    const count = Number(result.count || (result.items || []).length || 0);
    ui.toast('验证通过，已获取 ' + count + ' 条结果');
    await refreshChallenges();
  }
  async function deleteChallenge(id) {
    await api('DELETE', '/api/crawler/challenge/' + encodeURIComponent(id));
    ui.toast('已删除验证会话');
    await refreshChallenges();
  }
  async function act(name) {
    const c = cs();
    if (name === 'crawler-refresh') { ensure(true); return; }
    if (name === 'crawler-challenges-refresh') {
      refreshChallenges().catch(function (error) { ui.toast(message(error)); });
      return;
    }
    if (name === 'crawler-libraries-refresh') {
      loadLibraries(true).catch(function (error) { ui.toast(message(error)); });
      return;
    }
    if (name === 'crawler-start' || name === 'crawler-stop') {
      c.starting = name === 'crawler-start';
      renderIf();
      try {
        c.info = await cmd(name);
        if (name === 'crawler-start') await loadData();
      } catch (error) {
        c.error = message(error);
        ui.toast(c.error);
      } finally {
        c.starting = false;
        renderIf();
      }
      return;
    }
    if (name === 'crawler-rule-new') { ruleModal(null); return; }
    if (name === 'crawler-doc') { await openDocs(); return; }
    if (name === 'crawler-submission-new') { submissionModal(); return; }
    if (name === 'crawler-submission-save') { await saveSubmission(); return; }
    if (name === 'crawler-rule-save') { await saveRule(); return; }
    if (name === 'crawler-import') {
      const report = await cmd('crawler-import', { mode: 'merge' });
      if (!report || report.canceled) return;
      await loadRules();
      ui.toast('导入完成：新增 ' + (report.imported || 0) + '，更新 ' + (report.updated || 0) + '，失败 ' + (report.failed || 0));
      return;
    }
    if (name === 'crawler-delete-selected') { await deleteSelectedRules(); return; }
    if (name === 'crawler-export-all' || name === 'crawler-export-selected') {
      const ids = name === 'crawler-export-selected' ? Object.keys(c.selectedRules || {}) : [];
      if (name === 'crawler-export-selected' && !ids.length) { ui.toast('选择要导出的规则'); return; }
      const result = await cmd('crawler-export', { ids: ids });
      if (!result || result.canceled) return;
      // 单文件包 / Docker 版没有 GUI，只能把这个文件拿去服务端导入
      ui.toast('已导出 ' + (result.count || 0) + ' 条规则，可在服务端「管理 → 全网搜片」导入');
      return;
    }
    if (name === 'crawler-chat-send') { await sendChat(); return; }
    if (name === 'crawler-chat-stop') { await stopChat(); return; }
    if (name === 'crawler-image-pick') {
      const picker = document.getElementById('crawler-image-input');
      if (picker) picker.click();
      return;
    }
    if (name === 'crawler-queue-clear') { c.queue = []; renderChat(); return; }
    if (name === 'crawler-session-new') {
      if (c.runBusy) { ui.toast('正在执行，停止或等待完成后再新建会话'); return; }
      c.sessionId = '';
      c.messages = [];
      c.sessionEffort = c.settingsEffort || '';
      c.sessionModel = '';
      c.workOpen = {};
      c.stepOpen = {};
      c.chatDraft = '';
      c.runId = '';
      c.runCursor = 0;
      c.runStatus = 'idle';
      c.tab = 'agent';
      renderIf();
      return;
    }
    if (name === 'crawler-session-rename') {
      if (!c.sessionId) return;
      const current = (c.sessions.find(function (item) { return item.id === c.sessionId; }) || {}).title || '';
      ui.modal('<h2>重命名会话</h2><p class="field-note">标题用于会话列表，最多 32 字。</p><label class="field"><span>会话标题</span><input id="crawler-session-title" maxlength="32" value="' + esc(current) + '" placeholder="例如：某影视站的搜索规则" autocomplete="off"></label><div class="modal-actions">' + button('取消', 'close-modal') + button('保存', 'crawler-session-rename-save', 'check', 'primary') + '</div>');
      const input = document.getElementById('crawler-session-title');
      if (input) { input.focus(); input.select(); }
      return;
    }
    if (name === 'crawler-session-rename-save') {
      const input = document.getElementById('crawler-session-title');
      const title = ((input && input.value) || '').trim();
      if (!title) { ui.toast('标题不能为空'); return; }
      const result = await api('PUT', '/api/crawler/agent/sessions/' + encodeURIComponent(c.sessionId), { title: title });
      const session = result.session || {};
      const entry = c.sessions.find(function (item) { return item.id === c.sessionId; });
      if (entry) entry.title = session.title || title;
      $('#modal').close();
      renderIf();
      ui.toast('会话已重命名');
      return;
    }
    if (name === 'crawler-session-delete') {
      if (c.runBusy) { ui.toast('正在执行，停止或等待完成后再删除会话'); return; }
      if (!c.sessionId || !window.confirm('删除当前对话？')) return;
      await api('DELETE', '/api/crawler/agent/sessions/' + encodeURIComponent(c.sessionId));
      c.sessionId = '';
      c.messages = [];
      const data = await api('GET', '/api/crawler/agent/sessions');
      c.sessions = data.sessions || [];
      renderIf();
      ui.toast('对话已删除');
      return;
    }
    if (name === 'crawler-submissions-refresh') { await refreshSubmissions(); await refreshBrowser(); return; }
    if (name === 'crawler-auto-save') { await setAutoGenerate(Boolean($('#crawler-auto-generate') && $('#crawler-auto-generate').checked)); return; }
    if (name === 'crawler-login-open') { await openLogin(); return; }
    if (name === 'crawler-site-save') { await saveSiteLogin(); return; }
    if (name === 'crawler-site-verify') { await verifySiteChallenge(); return; }
    if (name === 'crawler-site-refresh') { refreshSiteView(); return; }
    if (name === 'crawler-site-go') { const input = $('#crawler-site-url'); navigateSiteView(input ? input.value : ''); return; }
    if (name === 'crawler-site-close') { closeSiteView(); return; }
    if (name === 'crawler-models-load') { await loadModels(); return; }
    if (name === 'crawler-config-save') {
      const payload = {
        baseUrl: ($('#crawler-base-url') || {}).value || '',
        model: ($('#crawler-model') || {}).value || '',
        apiKey: ($('#crawler-api-key') || {}).value || '',
        reasoningEffort: ($('#crawler-reasoning-effort') || {}).value || '',
        submissionReasoningEffort: ($('#crawler-submission-reasoning-effort') || {}).value || '',
        customPrompt: ($('#crawler-custom-prompt') || {}).value || ''
      };
      const saved = await cmd('crawler-config-save', payload);
      if (c.info) c.info.config = saved;
      c.settingsEffort = saved.reasoningEffort || '';
      c.submissionEffort = saved.submissionReasoningEffort || '';
      renderIf();
      ui.toast('大模型设置已保存');
      if (!c.models.length) loadModels();
      return;
    }
  }

  document.addEventListener('click', function (event) {
    const stateNow = cs();
    if (stateNow.mentionOpen && event.target.id !== 'crawler-chat-input' && !event.target.closest('#crawler-mentions')) closeMentions();
    const mentionButton = event.target.closest('[data-crawler-mention]');
    if (mentionButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectMention(mentionButton.dataset.crawlerMention);
      return;
    }
    const imageRemove = event.target.closest('[data-crawler-image-remove]');
    if (imageRemove) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const c = cs();
      const id = imageRemove.dataset.crawlerImageRemove;
      c.chatImages = c.chatImages.filter(function (image) { return image.id !== id; });
      renderAttachments();
      return;
    }
    const workHead = event.target.closest('[data-crawler-work]');
    if (workHead) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const c = cs();
      const key = workHead.dataset.crawlerWork;
      const index = Number(key.slice(1));
      const item = c.messages[index];
      c.workOpen[key] = !isOpen(c.workOpen, key, Boolean(item && item.pending));
      renderChat();
      return;
    }
    const stepHead = event.target.closest('[data-crawler-step]');
    if (stepHead) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const c = cs();
      const key = stepHead.dataset.crawlerStep;
      c.stepOpen[key] = !isOpen(c.stepOpen, key, false);
      renderChat();
      return;
    }
    const copyButton = event.target.closest('[data-crawler-copy]');
    if (copyButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const item = cs().messages[Number(copyButton.dataset.crawlerCopy)];
      if (item) copyText(item.content || '');
      return;
    }
    const suggestButton = event.target.closest('[data-crawler-suggest]');
    if (suggestButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = $('#crawler-chat-input');
      if (input) {
        input.value = suggestButton.dataset.crawlerSuggest || '';
        cs().chatDraft = input.value;
        input.focus();
      }
      return;
    }
    const tab = event.target.closest('[data-crawler-tab]');
    if (tab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cs().tab = tab.dataset.crawlerTab;
      renderIf();
      // 来源库要走远端规则地址，进设置页才拉，避免每次打开页面都等它。
      if (cs().tab === 'settings' || cs().tab === 'rules') loadLibraries(false).catch(function () {});
      return;
    }
    const libraryEdit = event.target.closest('[data-crawler-library]');
    if (libraryEdit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = libraryEdit.dataset.crawlerLibrary;
      const library = (cs().libraries || []).find(function (item) { return item.id === id; });
      if (library) libraryModal(library);
      return;
    }
    const librarySave = event.target.closest('[data-crawler-library-save]');
    if (librarySave) {
      event.preventDefault();
      event.stopImmediatePropagation();
      saveLibrary(librarySave.dataset.crawlerLibrarySave);
      return;
    }
    const libraryImport = event.target.closest('[data-crawler-library-import]');
    if (libraryImport) {
      event.preventDefault();
      event.stopImmediatePropagation();
      importLibrarySource(libraryImport.dataset.crawlerLibraryImport, libraryImport.dataset.crawlerLibrarySource || '');
      return;
    }
    const mcpOpen = event.target.closest('[data-crawler-mcp-open]');
    if (mcpOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openMcp();
      return;
    }
    const mcpTab = event.target.closest('[data-mcp-client]');
    if (mcpTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      mcpClient = mcpTab.dataset.mcpClient;
      renderMcpConfig();
      return;
    }
    const mcpCopy = event.target.closest('[data-crawler-mcp-copy]');
    if (mcpCopy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const textarea = $('#crawler-mcp-text');
      copyText(textarea ? textarea.value : '');
      return;
    }
    const mcpPromptCopy = event.target.closest('[data-crawler-mcp-prompt]');
    if (mcpPromptCopy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const area = $('#crawler-mcp-prompt');
      copyText(area ? area.value : '', '提示词已复制');
      return;
    }
    const ruleButton = event.target.closest('[data-crawler-rule]');
    if (ruleButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = ruleButton.dataset.crawlerRule;
      const c = cs();
      const ruleAction = ruleButton.dataset.crawlerDo;
      if (ruleAction === 'delete') deleteRule(id).catch(function (error) { ui.toast(message(error)); });
      else if (ruleAction === 'login') startSiteLogin(id).catch(function (error) { ui.toast(message(error)); });
      else if (ruleAction === 'toggle') toggleRule(id).catch(function (error) { ui.toast(message(error)); });
      else if (ruleAction === 'select') {
        const next = Object.assign({}, c.selectedRules || {});
        if (next[id]) delete next[id]; else next[id] = true;
        c.selectedRules = next;
        renderIf();
      }
      else {
        const rule = c.rules.find(function (item) { return item.id === id; });
        if (rule) ruleModal(rule);
      }
      return;
    }
    const challengeButton = event.target.closest('[data-crawler-challenge]');
    if (challengeButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = challengeButton.dataset.crawlerChallenge;
      const action = challengeButton.dataset.crawlerDo;
      if (action === 'open') openChallenge(id);
      else if (action === 'verify') verifyChallenge(id).catch(function (error) { ui.toast(message(error)); });
      else if (action === 'delete') deleteChallenge(id).catch(function (error) { ui.toast(message(error)); });
      return;
    }
    const submissionButton = event.target.closest('[data-crawler-submission]');
    if (submissionButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = submissionButton.dataset.crawlerSubmission;
      const c = cs();
      const item = c.submissions.find(function (entry) { return entry.id === id; });
      if (submissionButton.dataset.crawlerDo === 'delete') deleteSubmission(id).catch(function (error) { ui.toast(message(error)); });
      else if (submissionButton.dataset.crawlerDo === 'generate') generateSubmission(id).catch(function (error) { ui.toast(message(error)); });
      else if (submissionButton.dataset.crawlerDo === 'session') viewSubmissionSession(item).catch(function (error) { ui.toast(message(error)); });
      else if (item) ruleModal(submissionRule(item));
      return;
    }
    const queueRemove = event.target.closest('[data-crawler-queue-remove]');
    if (queueRemove) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const c = cs();
      const id = queueRemove.dataset.crawlerQueueRemove;
      c.queue = c.queue.filter(function (item) { return item.id !== id; });
      renderChat();
      return;
    }
    const modelChip = event.target.closest('[data-crawler-model]');
    if (modelChip) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const modelInput = $('#crawler-model');
      if (modelInput) {
        modelInput.value = modelChip.dataset.crawlerModel || '';
        modelInput.focus();
      }
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action && action.dataset.action.indexOf('crawler-') === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      act(action.dataset.action).catch(function (error) { ui.toast(message(error)); });
    }
  }, true);

  document.addEventListener('change', function (event) {
    if (event.target && event.target.id === 'crawler-session') {
      const c = cs();
      if (c.runBusy) {
        event.target.value = c.sessionId || '';
        ui.toast('正在执行，停止或等待完成后再切换会话');
        return;
      }
      loadSession(event.target.value).catch(function (error) { ui.toast(message(error)); });
    }
    if (event.target && event.target.id === 'crawler-session-model') {
      setSessionModel(event.target.value).catch(function (error) { ui.toast(message(error)); });
      return;
    }
    if (event.target && event.target.id === 'crawler-session-reasoning') {
      setSessionEffort(event.target.value).catch(function (error) { ui.toast(message(error)); });
    }
    if (event.target && event.target.id === 'crawler-api-key' && event.target.value.trim()) {
      loadModels().catch(function (error) { ui.toast(message(error)); });
    }
    if (event.target && event.target.id === 'crawler-auto-generate') {
      setAutoGenerate(event.target.checked).catch(function (error) { ui.toast(message(error)); });
    }
    if (event.target && event.target.id === 'crawler-repair-enabled') {
      setRepair(event.target.checked).catch(function (error) { ui.toast(message(error)); });
    }
    if (event.target && event.target.id === 'crawler-image-input') {
      addImageFiles(event.target.files).catch(function (error) { ui.toast(message(error)); });
      event.target.value = '';
    }
  });
  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'crawler-chat-input') {
      cs().chatDraft = event.target.value;
      updateMentions();
    }
  });
  document.addEventListener('paste', function (event) {
    if (!event.target || event.target.id !== 'crawler-chat-input') return;
    const items = event.clipboardData && event.clipboardData.items ? Array.prototype.slice.call(event.clipboardData.items) : [];
    const files = items.filter(function (item) { return item.kind === 'file' && item.type.indexOf('image/') === 0; }).map(function (item) { return item.getAsFile(); }).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    addImageFiles(files).catch(function (error) { ui.toast(message(error)); });
  });
  document.addEventListener('keydown', function (event) {
    if (!event.target || event.target.id !== 'crawler-chat-input') return;
    const c = cs();
    if (c.mentionOpen) {
      const items = mentionCandidates(c, c.mentionQuery);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length) c.mentionIndex = (c.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderMentions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (items.length) {
          event.preventDefault();
          selectMention(items[Math.max(0, Math.min(c.mentionIndex, items.length - 1))].id);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentions();
        return;
      }
    }
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) return;
    // Ctrl+Enter 在光标处插入换行（浏览器默认不会给 textarea 插入）。
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const input = event.target;
      const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
      const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
      input.setRangeText('\n', start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // Shift/Alt+Enter 保留默认换行；输入法组合中的回车不触发发送。
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    sendChat().catch(function (error) { ui.toast(message(error)); });
  });

  if (window.zviewerDesktop && window.zviewerDesktop.onCrawlerChallenge) {
    window.zviewerDesktop.onCrawlerChallenge(function () {
      if (state.page !== 'crawler') return;
      refreshChallenges().catch(function () {});
    });
  }
  window.setInterval(function () {
    const c = cs();
    if (state.page !== 'crawler' || c.tab !== 'challenges' || !c.info || c.info.available === false) return;
    refreshChallenges().catch(function () {});
  }, 15000);

  // 弹窗被 ESC/遮罩关掉时也要清理反代会话：断开 iframe 加载、删掉临时登录会话，
  // 否则隐藏的页面会在后台继续请求。
  (function bindModalReset() {
    const dialog = $('#modal');
    if (!dialog) return;
    dialog.addEventListener('close', function () {
      if (siteView) closeSiteView();
    });
  })();

  window.ZViewerCrawlerPage = { page: page, ensure: ensure };
})();