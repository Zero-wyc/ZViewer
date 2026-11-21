'use strict';
// ZViewer crawler JS rule runner. Reads JSON payload from stdin, evaluates the
// user script from argv[2], prints one JSON object on stdout.
const fs = require('fs');
const vm = require('vm');

function emit(value) {
  process.stdout.write(JSON.stringify(value));
}

(async () => {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (err) {
    emit({ ok: false, error: 'bad input json: ' + String(err) });
    process.exit(2);
  }
  const logs = [];
  const sandbox = Object.assign({}, input, {
    input: input,
    ctx: input,
    console: {
      log: (...args) => logs.push(args.map((item) => {
        if (typeof item === 'string') return item;
        try { return JSON.stringify(item); } catch (err) { return String(item); }
      }).join(' ')),
      error: (...args) => logs.push(args.map(String).join(' ')),
    },
    fetch: typeof fetch === 'function' ? fetch : undefined,
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: atob,
    btoa: btoa,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    const source = fs.readFileSync(process.argv[2], 'utf8');
    const script = new vm.Script('(async () => {\n' + source + '\n})()', { filename: 'rule-script.js' });
    const result = await script.runInContext(sandbox);
    emit({ ok: true, result: result === undefined ? null : result, logs: logs });
  } catch (err) {
    emit({ ok: false, error: String(err && err.stack ? err.stack : err), logs: logs });
    process.exitCode = 1;
  }
})();
