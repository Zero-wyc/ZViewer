// 桌面歌词式评论浮层外壳：
// - 无边框、无标题栏，只有一层可调透明度的背景 + 评论页 iframe
// - 鼠标在窗口内移动时显示工具条与输入框；移开 3 秒后自动隐藏，只留评论内容
(() => {
  'use strict';
  const api = () => window.go?.main?.CommentsWindow;
  const runtime = () => window.runtime;
  const frame = document.getElementById('page');
  const toolbar = document.getElementById('toolbar');
  const pin = document.getElementById('pin');
  const close = document.getElementById('close');
  const bgRange = document.getElementById('bg-range');
  const bgValue = document.getElementById('bg-value');
  const colorInput = document.getElementById('color');
  const colorValue = document.getElementById('color-value');
  const resizeHandle = document.getElementById('resize');

  const BG_KEY = 'zviewer.comments-window.bg-alpha';
  const BG_DEFAULT = 35;
  const COLOR_KEY = 'zviewer.comments-window.text-color';
  const COLOR_DEFAULT = '#ffffff';
  const HIDE_DELAY_MS = 3000;

  let pinned = true;
  let hovered = false;
  let hideTimer = null;

  const clampBg = (value) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return BG_DEFAULT;
    return Math.min(100, Math.max(0, n));
  };

  const applyBg = (percent) => {
    const value = clampBg(percent);
    document.documentElement.style.setProperty('--bg-alpha', String(value / 100));
    bgRange.value = String(value);
    bgValue.textContent = value + '%';
    try {
      localStorage.setItem(BG_KEY, String(value));
    } catch {
      // 隐私模式等写不进去，忽略
    }
  };

  const loadBg = () => {
    let stored = BG_DEFAULT;
    try {
      const raw = localStorage.getItem(BG_KEY);
      if (raw !== null) stored = clampBg(raw);
    } catch {
      // 忽略
    }
    applyBg(stored);
  };

  const normalizeColor = (value) => (/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : COLOR_DEFAULT);

  /** 字体颜色深浅决定描边颜色：亮色文字配黑描边，暗色文字配白描边 */
  const shadowFor = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55
      ? '0 1px 2px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,1)'
      : '0 1px 2px rgba(255,255,255,0.92), 0 0 4px rgba(255,255,255,0.8), 0 0 1px rgba(255,255,255,0.95)';
  };

  /** 通知 iframe 应用文字颜色（颜色/描边都写进 CSS 变量） */
  const postStyle = () => {
    const color = colorInput.value;
    try {
      frame.contentWindow?.postMessage(
        { type: 'zviewer:lyrics-style', color, shadow: shadowFor(color) },
        '*'
      );
    } catch {
      // iframe 还没就绪，忽略
    }
  };

  const applyColor = (value) => {
    const hex = normalizeColor(value);
    colorInput.value = hex;
    colorValue.textContent = hex;
    try {
      localStorage.setItem(COLOR_KEY, hex);
    } catch {
      // 忽略
    }
    postStyle();
  };

  const loadColor = () => {
    let stored = COLOR_DEFAULT;
    try {
      const raw = localStorage.getItem(COLOR_KEY);
      if (raw !== null) stored = normalizeColor(raw);
    } catch {
      // 忽略
    }
    applyColor(stored);
  };

  /** 通知 iframe 展开/收起输入框 */
  const postHover = (value) => {
    try {
      frame.contentWindow?.postMessage({ type: 'zviewer:lyrics-hover', hover: value }, '*');
    } catch {
      // iframe 还没就绪，忽略
    }
  };

  const renderHover = (value) => {
    if (hovered === value) {
      if (value) clearHideTimer();
      return;
    }
    hovered = value;
    document.body.classList.toggle('hovered', value);
    postHover(value);
    if (value) clearHideTimer();
  };

  const clearHideTimer = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    hideTimer = setTimeout(() => renderHover(false), HIDE_DELAY_MS);
  };

  const renderPin = () => {
    pin.textContent = pinned ? '取消置顶' : '置顶';
    pin.classList.toggle('active', pinned);
  };

  const boot = async () => {
    loadBg();
    loadColor();
    // iframe 每次加载完都要重新下发样式（换页/重载会丢掉 CSS 变量）
    frame.addEventListener('load', () => {
      postStyle();
      postHover(hovered);
    });
    try {
      const info = await api().Info();
      if (info && info.url) frame.src = info.url;
      if (info && typeof info.pinned === 'boolean') pinned = info.pinned;
    } catch (err) {
      console.error('评论窗口初始化失败', err);
    }
    renderPin();
  };

  // iframe 内部把鼠标进入/离开窗口的事件转发过来
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'zviewer:lyrics-pointer') {
      if (data.hover) renderHover(true);
      else scheduleHide();
      return;
    }
    // 评论页里的「关闭」按钮：iframe 内拿不到 Wails 运行时，由外壳关掉整个独立窗口
    if (data.type === 'zviewer:comments-close') {
      Promise.resolve(api()?.Close()).catch(() => window.close());
      return;
    }
  });

  // 鼠标停在工具条上时不隐藏（iframe 此时已经收到 pointerleave）
  toolbar.addEventListener('pointerenter', () => renderHover(true));
  toolbar.addEventListener('pointerleave', () => scheduleHide());

  bgRange.addEventListener('input', (event) => applyBg(event.target.value));
  colorInput.addEventListener('input', (event) => applyColor(event.target.value));

  pin.addEventListener('click', async () => {
    const next = !pinned;
    try {
      await api().SetPinned(next);
      pinned = next;
      renderPin();
    } catch (err) {
      console.error('切换置顶失败', err);
    }
  });

  close.addEventListener('click', () => {
    Promise.resolve(api()?.Close()).catch(() => window.close());
  });

  // 无边框窗口没有原生缩放边框，这里用右下角抓手调 WindowSetSize
  let resizeStart = null;
  resizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizeStart = {
      x: event.screenX,
      y: event.screenY,
      w: window.outerWidth,
      h: window.outerHeight,
    };
    resizeHandle.setPointerCapture(event.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!resizeStart) return;
    const width = Math.max(220, resizeStart.w + (event.screenX - resizeStart.x));
    const height = Math.max(160, resizeStart.h + (event.screenY - resizeStart.y));
    runtime()?.WindowSetSize(width, height);
  });
  const endResize = () => {
    resizeStart = null;
  };
  resizeHandle.addEventListener('pointerup', endResize);
  resizeHandle.addEventListener('pointercancel', endResize);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
