/**
 * 网易云/B站 评论区共用的 arknights 风样式表
 * （Hydrogen Comments.vue scoped SCSS 平替）。
 *
 * 抽到独立模块是为了让评论面板外壳（CommentsShell）与两个数据源面板
 * 共享同一份样式，且避免 shell ↔ panel 的循环引用。
 */
export const COMMENTS_STYLE = `
.arknights-comments {
  --ac-border: rgba(0, 0, 0, 0.75);
  --ac-soft-bg: rgba(255, 255, 255, 0.6);
  --ac-card-bg: rgba(255, 255, 255, 0.55);
  --ac-ink: #1a1a1a;
  --ac-muted: rgba(26, 26, 26, 0.6);
  --ac-ink-contrast: #fff;
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background-color: rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ac-ink);
  font-family: 'Bender-Bold', 'SourceHanSansCN-Bold', sans-serif;
}
html.dark .arknights-comments {
  --ac-border: rgba(255, 255, 255, 0.85);
  --ac-soft-bg: rgba(255, 255, 255, 0.08);
  --ac-card-bg: rgba(255, 255, 255, 0.08);
  --ac-ink: #f5f5f5;
  --ac-muted: rgba(245, 245, 245, 0.6);
  --ac-ink-contrast: #000;
  background-color: rgba(0, 0, 0, 0.25);
}
.arknights-comments::-webkit-scrollbar { width: 3px; }
.arknights-comments::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.3); border-radius: 2px;
}
html.dark .arknights-comments::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
}
.ac-frame-corner {
  width: 8px; height: 8px; position: absolute; z-index: 1; pointer-events: none;
}
.ac-frame-tl { top: 0; left: 0; border-top: 2px solid var(--ac-border); border-left: 2px solid var(--ac-border); }
.ac-frame-tr { top: 0; right: 0; border-top: 2px solid var(--ac-border); border-right: 2px solid var(--ac-border); }
.ac-frame-bl { bottom: 0; left: 0; border-bottom: 2px solid var(--ac-border); border-left: 2px solid var(--ac-border); }
.ac-frame-br { bottom: 0; right: 0; border-bottom: 2px solid var(--ac-border); border-right: 2px solid var(--ac-border); }
.ac-comments-header { margin-bottom: 14px; }
.ac-header-frame {
  position: relative; height: 56px; display: flex; align-items: center; justify-content: center;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-header-title { font-size: 17px; font-weight: 800; letter-spacing: 0.3em; color: var(--ac-ink); }
.ac-title-underline { width: 64px; height: 2px; margin-top: 6px; margin-left: auto; margin-right: auto; background: var(--ac-ink); }
.ac-comment-input-section { margin-bottom: 16px; }
.ac-input-frame {
  position: relative; padding: 12px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-comment-textarea {
  min-height: 80px; width: 100%; resize: vertical; padding: 10px 12px;
  border: none; outline: none; display: block;
  background-color: var(--ac-soft-bg); color: var(--ac-ink);
  font-size: 13px; line-height: 1.6;
}
.ac-comment-textarea::placeholder { color: var(--ac-muted); }
.ac-input-border {
  position: absolute; inset: 0;
  border: 2px solid color-mix(in srgb, var(--ac-border) 30%, transparent);
  pointer-events: none; transition: border-color 0.2s;
}
.ac-comment-textarea:focus ~ .ac-input-border { border-color: var(--ac-border); }
.ac-input-actions { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; }
.ac-shortcut-hint { font-size: 10px; letter-spacing: 0.2em; color: var(--ac-muted); }
.ac-submit-button {
  padding: 10px 20px; border: none; cursor: pointer;
  background-color: var(--ac-border); color: var(--ac-ink-contrast);
  font-size: 12px; font-weight: 800; letter-spacing: 0.2em;
  transition: 0.15s;
}
.ac-submit-button:hover:not(:disabled) { transform: translateY(-1px); }
.ac-submit-button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.ac-login-prompt { margin-bottom: 16px; }
.ac-prompt-frame {
  position: relative; padding: 14px; text-align: center;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-prompt-text { font-size: 11px; letter-spacing: 0.25em; color: var(--ac-muted); }
.ac-section-header { margin: 18px 0 12px; display: flex; align-items: center; gap: 10px; }
.ac-section-title { font-size: 13px; font-weight: 800; letter-spacing: 0.2em; color: var(--ac-ink); }
.ac-section-count { font-size: 11px; font-weight: 700; color: var(--ac-muted); margin-left: 6px; }
.ac-section-line { flex: 1; height: 1px; background: color-mix(in srgb, var(--ac-border) 30%, transparent); }
.ac-comment-card {
  position: relative; padding: 14px 16px; margin-bottom: 10px;
  background-color: var(--ac-card-bg);
  border-left: 3px solid color-mix(in srgb, var(--ac-border) 28%, transparent);
  transition: transform 0.15s, box-shadow 0.15s;
}
.ac-comment-card:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,0.12); }
.ac-hot-card { border-left-color: rgba(233, 192, 104, 0.76); }
.ac-comment-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ac-user-avatar { position: relative; width: 28px; height: 28px; }
.ac-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ac-avatar-frame {
  position: absolute; inset: -2px;
  border: 2px solid color-mix(in srgb, var(--ac-border) 22%, transparent);
  pointer-events: none;
}
.ac-user-info { display: flex; flex-direction: column; min-width: 0; }
.ac-username { font-size: 13px; font-weight: 800; color: var(--ac-ink); }
.ac-timestamp { font-size: 10px; color: var(--ac-muted); }
.ac-comment-text {
  font-size: 14px; line-height: 1.7; color: var(--ac-ink); cursor: text; user-select: text;
}
.ac-emoji-img { width: 22px; height: 22px; vertical-align: -6px; margin: 0 1px; }
.ac-emoji-text { font-size: 18px; vertical-align: -2px; }
.ac-comment-controls { margin-top: 10px; display: flex; align-items: center; gap: 12px; }
.ac-control-item {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  padding: 3px 8px; border-radius: 3px;
  background-color: color-mix(in srgb, var(--ac-border) 10%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 700;
  transition: 0.15s;
}
.ac-control-item:hover {
  background-color: color-mix(in srgb, var(--ac-border) 18%, transparent);
  color: var(--ac-ink);
}
.ac-control-item svg { fill: currentColor; opacity: 1; }
.ac-control-item.ac-active { color: #ff4757; }
.ac-control-item.ac-active svg { opacity: 1; }
.ac-floor-replies { margin-top: 10px; }
.ac-floor-toggle {
  padding: 4px 10px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 12%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 700;
  transition: 0.15s;
}
.ac-floor-toggle:hover {
  background-color: color-mix(in srgb, var(--ac-border) 22%, transparent);
}
.ac-floor-panel {
  margin-top: 8px; padding: 8px;
  background-color: color-mix(in srgb, var(--ac-soft-bg) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--ac-border) 25%, transparent);
}
.ac-floor-item {
  padding: 8px 10px;
  border-left: 2px solid color-mix(in srgb, var(--ac-border) 30%, transparent);
}
.ac-floor-item + .ac-floor-item { margin-top: 6px; }
.ac-floor-avatar { width: 22px; height: 22px; overflow: hidden; }
.ac-floor-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ac-floor-meta { display: flex; align-items: baseline; gap: 8px; }
.ac-floor-username { font-size: 12px; font-weight: 800; color: var(--ac-ink); }
.ac-floor-time { font-size: 10px; color: var(--ac-muted); }
.ac-floor-main { margin-left: 30px; }
.ac-floor-controls { margin-top: 4px; display: flex; align-items: center; gap: 10px; }
.ac-floor-control-item {
  display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
  font-size: 10px; font-weight: 700; color: var(--ac-ink);
}
.ac-floor-control-item:hover { color: var(--ac-ink); }
.ac-floor-control-item svg { fill: currentColor; opacity: 1; }
.ac-floor-control-item.ac-active { color: #ff4757; }
.ac-floor-control-item.ac-active svg { opacity: 1; }
.ac-floor-status { margin-top: 8px; padding: 4px 10px; font-size: 11px; color: var(--ac-muted); }
.ac-floor-error { cursor: pointer; color: #ff4757; }
.ac-floor-more {
  margin-top: 8px; width: 100%; padding: 6px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 10%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 700;
}
.ac-floor-more:disabled { opacity: 0.6; cursor: wait; }
.ac-inline-reply-box {
  position: relative; margin-top: 10px; padding: 12px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 35%, transparent);
}
.ac-reply-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  padding-left: 8px; border-left: 2px solid var(--ac-border);
}
.ac-reply-prefix { font-size: 10px; font-weight: 800; letter-spacing: 0.15em; color: var(--ac-muted); }
.ac-reply-target {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 800; color: var(--ac-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ac-close-reply {
  cursor: pointer; font-size: 14px; font-weight: 700;
  color: var(--ac-muted); padding: 0 6px;
}
.ac-close-reply:hover { color: #ff4757; }
.ac-reply-textarea {
  min-height: 52px; width: 100%; resize: vertical; padding: 8px 10px;
  border: none; outline: none; display: block;
  background-color: var(--ac-soft-bg); color: var(--ac-ink); font-size: 12px;
}
.ac-reply-textarea::placeholder { color: var(--ac-muted); }
.ac-reply-input-border {
  height: 2px; margin-top: 2px;
  background-color: color-mix(in srgb, var(--ac-border) 25%, transparent);
}
.ac-reply-actions { margin-top: 8px; display: flex; align-items: center; justify-content: space-between; }
.ac-reply-buttons { display: flex; gap: 8px; }
.ac-cancel-reply-btn {
  padding: 8px 14px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 12%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 800;
}
.ac-cancel-reply-btn:hover { color: var(--ac-ink); }
.ac-send-reply-btn {
  padding: 8px 18px; border: none; cursor: pointer;
  background-color: var(--ac-border); color: var(--ac-ink-contrast);
  font-size: 12px; font-weight: 800;
}
.ac-send-reply-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ac-status-section { margin-top: 16px; }
.ac-status-frame {
  position: relative; padding: 14px; text-align: center; margin-bottom: 8px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-status-text { font-size: 11px; letter-spacing: 0.2em; color: var(--ac-muted); }
.ac-loading-content { display: flex; align-items: center; justify-content: center; gap: 10px; }
.ac-loading-indicator {
  width: 16px; height: 16px;
  border: 2px solid color-mix(in srgb, var(--ac-border) 25%, transparent);
  border-top-color: var(--ac-border); border-radius: 50%;
  animation: ac-spin 0.9s linear infinite;
}
@keyframes ac-spin { to { transform: rotate(360deg); } }
`
