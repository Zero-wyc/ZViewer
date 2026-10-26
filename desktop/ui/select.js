// 自绘下拉：原生 <select> 的弹出列表由 WebView2 自己绘制，不跟随页面主题，
// 暗色下会出现白底白字（选项文字继承了 select 的 color）。这里把列表改成页面内渲染。
// 原生 select 仍留在 DOM 里（透明）作为取值与 change 事件源，
// 因此 $('#id').value、'change' 事件委托都不需要改。
(() => {
  'use strict';

  const GAP = 4;
  const MAX_HEIGHT = 320;
  let current = null;

  function close(restoreFocus) {
    if (!current) return;
    const state = current;
    current = null;
    state.menu.remove();
    state.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    if (restoreFocus) state.trigger.focus({ preventScroll: true });
  }

  function onDocumentPointerDown(event) {
    if (!current) return;
    if (current.menu.contains(event.target) || current.wrap.contains(event.target)) return;
    close(false);
  }

  function onDocumentKeyDown(event) {
    if (!current) return;
    const state = current;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(state, state.active + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(state, state.active);
    }
  }

  function reposition() {
    if (current) position(current);
  }

  function position(state) {
    const rect = state.trigger.getBoundingClientRect();
    const menu = state.menu;
    menu.style.minWidth = `${Math.round(rect.width)}px`;
    const below = window.innerHeight - rect.bottom - GAP - 8;
    const above = rect.top - GAP - 8;
    const flip = below < 140 && above > below;
    menu.style.maxHeight = `${Math.max(96, Math.min(MAX_HEIGHT, flip ? above : below))}px`;
    const box = menu.getBoundingClientRect();
    const top = flip ? Math.max(8, rect.top - GAP - box.height) : rect.bottom + GAP;
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - 8 - box.width));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  function setActive(state, index, scroll = true) {
    const items = state.menu.querySelectorAll('.select-option');
    if (!items.length) return;
    state.active = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, i) => item.setAttribute('data-active', String(i === state.active)));
    if (scroll) items[state.active].scrollIntoView({ block: 'nearest' });
  }

  function choose(state, index) {
    const select = state.select;
    if (index < 0 || index >= select.options.length) return;
    close(true);
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
      // 冒泡到 document：使用方原有的 change 委托照常触发。
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncLabel(state);
  }

  function syncLabel(state) {
    const option = state.select.options[state.select.selectedIndex];
    state.trigger.querySelector('.select-value').textContent = option ? option.textContent : '';
  }

  function open(state) {
    close(false);
    const menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    Array.from(state.select.options).forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === state.select.selectedIndex));
      item.textContent = option.textContent;
      item.addEventListener('pointerenter', () => setActive(state, index, false));
      item.addEventListener('click', () => choose(state, index));
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    state.menu = menu;
    state.trigger.setAttribute('aria-expanded', 'true');
    current = state;
    position(state);
    setActive(state, state.select.selectedIndex);
    menu.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }

  function decorate(select) {
    if (select.closest('.select')) return;
    const wrap = document.createElement('div');
    wrap.className = 'select';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('select-native');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.disabled = select.disabled;
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const label = select.getAttribute('aria-label');
    if (label) trigger.setAttribute('aria-label', label);
    const value = document.createElement('span');
    value.className = 'select-value';
    const arrow = document.createElement('span');
    arrow.className = 'select-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    trigger.append(value, arrow);
    wrap.appendChild(trigger);
    const state = { select, wrap, trigger, menu: null, active: select.selectedIndex };
    syncLabel(state);
    trigger.addEventListener('click', () => (current ? close(true) : open(state)));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(state);
      }
    });
  }

  // 每次 render 后调用：innerHTML 重建过的下拉重新装饰，已有的跳过。
  function enhance(root) {
    close(false);
    (root || document).querySelectorAll('select').forEach(decorate);
  }

  window.ZViewerSelect = { enhance, close };
})();
