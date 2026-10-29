const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'live.js'), 'utf8');

// Run the actual delegated click listener, rather than calling an action handler directly.
function consoleHarness() {
  const calls = [], messages = [], classes = new Set();
  const snapshot = { backend: 'stopped', config: { frp: {} }, events: [], runtime: {} };
  const state = { live: true, page: 'connect', info: {}, server: snapshot, ipv6: {} };
  const footer = {};
  let click, failure, renders = 0;
  const document = {
    body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    querySelector: selector => selector === '#footer-status' ? footer : null,
    addEventListener(type, listener, capture) {
      if (type === 'click' && capture === true) click = listener;
    }
  };
  const window = {
    ZViewerUI: {
      state, render: () => renders++, toast: message => messages.push(message),
      preview: { syncUpdate() {} }
    },
    zviewerDesktop: {
      async command(action, payload) {
        calls.push(JSON.parse(JSON.stringify({ action, payload })));
        if (failure) throw failure;
      },
      async info() { return snapshot; }
    },
    addEventListener() {}
  };
  vm.runInNewContext(source, { window, document, structuredClone, setTimeout }, { filename: 'live.js' });
  assert.equal(typeof click, 'function', 'the live UI must register its capture listener');
  return {
    calls, messages, classes, state,
    failWith(error) { failure = error; },
    async click(action) {
      const button = { dataset: { action } };
      const event = {
        // Also covers a click on an icon/text descendant of the button.
        target: { closest: selector => selector === '[data-action]' ? button : null },
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; }
      };
      click(event);
      await new Promise(setImmediate);
      return event;
    },
    get renders() { return renders; }
  };
}

for (const [action, component] of [['tunnel-install', 'cloudflared'], ['mesh-install', 'easytier']]) {
  test(`${action} dispatches only its component download`, async () => {
    const app = consoleHarness();
    const event = await app.click(action);
    assert.deepEqual(app.calls, [{ action: 'component-install', payload: { name: component } }]);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.equal(app.state.server.backend, 'stopped');
    assert.ok(app.renders > 0, 'refresh component status after dispatch');
    assert.match(app.messages.at(-1), /正在下载/);
    assert.equal(app.classes.has('live-busy'), false);
  });
}

test('cloudflared download errors are visible and the button can retry', async () => {
  const app = consoleHarness();
  app.failWith(new Error('无法创建临时文件'));
  await app.click('tunnel-install');
  assert.deepEqual(app.messages, ['无法创建临时文件']);
  assert.equal(app.classes.has('live-busy'), false);
  app.failWith(null);
  await app.click('tunnel-install');
  assert.deepEqual(app.calls, Array.from({ length: 2 }, () => ({
    action: 'component-install', payload: { name: 'cloudflared' }
  })));
  assert.match(app.messages.at(-1), /正在下载 cloudflared/);
});
