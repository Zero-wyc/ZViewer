#!/usr/bin/env node
/**
 * 用 Node 的更新器实现生成「检查更新」的期望输出（Go 单测的基准）。
 *
 * GitHub API 是硬编码域名，没法起假站对拍。这里沿用弹幕阶段的做法：
 * 把 `https.get` 换成按 URL 回夹具的实现，再把 settings 读取打桩，
 * 直接调 Node 的 getUpdateInfo —— 得到的就是 Node 在同样输入下的真实输出。
 *
 * 覆盖不到的分支（本地版本是 0.0.0 / 0.0.0-dev.*）由 Go 单测直接喂
 * selectRelease，因为 Node 的本地版本取自 package.json，无法在进程内改。
 *
 * 用法：node backend-go/scripts/gen-updater-fixtures.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'backend-go', 'internal', 'updater', 'testdata', 'check-expected.json');

/** 一份正常的 Release（tag v1.0.0）+ 一份 latest 预发布，覆盖两条分支。 */
const RELEASE_STABLE_100 = {
  tag_name: 'v1.0.0',
  name: 'v1.0.0',
  body: '修复：<更新> & 其它\n- 条目一',
  html_url: 'https://github.com/Zero-wyc/ZViewer/releases/tag/v1.0.0',
  published_at: '2026-09-01T00:00:00Z',
  prerelease: false,
  assets: [
    { name: 'zviewer-windows-x64.zip', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/v1.0.0/zviewer-windows-x64.zip', size: 12345 },
    { name: 'zviewer-linux-x64.tar.gz', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/v1.0.0/zviewer-linux-x64.tar.gz', size: 23456 },
  ],
};

const RELEASE_STABLE_120 = {
  ...RELEASE_STABLE_100,
  tag_name: 'v1.2.0',
  html_url: 'https://github.com/Zero-wyc/ZViewer/releases/tag/v1.2.0',
  published_at: '2026-10-01T00:00:00Z',
  assets: [
    { name: 'zviewer-windows-x64.zip', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/v1.2.0/zviewer-windows-x64.zip', size: 34567 },
    { name: 'zviewer-linux-x64.tar.gz', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/v1.2.0/zviewer-linux-x64.tar.gz', size: 45678 },
  ],
};

const RELEASE_PRE_LATEST = {
  tag_name: 'latest',
  name: 'Latest build',
  body: null,
  html_url: 'https://github.com/Zero-wyc/ZViewer/releases/tag/latest',
  published_at: '2026-10-20T00:00:00Z',
  prerelease: true,
  assets: [
    { name: 'zviewer-windows-x64.zip', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip', size: 56789 },
    { name: 'zviewer-linux-x64.tar.gz', browser_download_url: 'https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz', size: 67890 },
  ],
};

const RELEASE_MISSING_ASSET = {
  ...RELEASE_STABLE_120,
  assets: [{ name: 'zviewer-darwin-arm64.zip', browser_download_url: 'https://example.com/x.zip', size: 1 }],
};

/** 每个用例：releases 列表 + includePrerelease */
const CASES = {
  'stable-equal': { releases: [RELEASE_STABLE_100], includePrerelease: false },
  'stable-newer': { releases: [RELEASE_STABLE_120], includePrerelease: false },
  'stable-newer-with-pre-on-top': {
    releases: [RELEASE_PRE_LATEST, RELEASE_STABLE_120],
    includePrerelease: false,
  },
  'prerelease-mode-takes-first': {
    releases: [RELEASE_PRE_LATEST, RELEASE_STABLE_120],
    includePrerelease: true,
  },
  'prerelease-mode-stable-first': {
    releases: [RELEASE_STABLE_120, RELEASE_PRE_LATEST],
    includePrerelease: true,
  },
  'only-prerelease-stable-mode': { releases: [RELEASE_PRE_LATEST], includePrerelease: false },
  'missing-asset': { releases: [RELEASE_MISSING_ASSET], includePrerelease: false },
  'empty-releases': { releases: [], includePrerelease: false },
};

let activeReleases = [];

/** 把 https.get 换掉：按 path 命中 GitHub releases 接口就吐当前用例的数据。 */
function installFakeHttps() {
  https.get = (target, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const request = new EventEmitter();
    request.destroy = () => {};
    const response = new Readable({ read() {} });
    const url = String(target);
    process.nextTick(() => {
      if (!url.includes('/repos/Zero-wyc/ZViewer/releases')) {
        response.statusCode = 404;
        response.headers = {};
        callback(response);
        response.push('Not Found');
        response.push(null);
        return;
      }
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.push(JSON.stringify(activeReleases));
      response.push(null);
    });
    return request;
  };
  return () => {
    delete https.get;
  };
}

async function main() {
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs' },
  });

  // 直接把 system-settings 塞进 require.cache，而不是 require 之后改导出：
  // 那个模块会链条式拉进 data-source → 全部 entities → typeorm 装饰器，
  // 在 ts-node 的默认编译选项下直接炸（缺 experimentalDecorators）。
  // 更新器只需要 getSystemSettings 一个函数，伪造整个模块更干净。
  const settingsPath = require.resolve(
    path.join(ROOT, 'backend', 'src', 'services', 'system-settings.ts'),
  );
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      getSystemSettings: async () => ({ cdnAccelerate: false, cdnProxyUrl: '' }),
    },
  };

  const restoreHttps = installFakeHttps();
  const { getUpdateInfo, getLocalVersion } = require(path.join(
    ROOT, 'backend', 'src', 'services', 'updater', 'index.ts',
  ));

  const output = {
    currentVersion: getLocalVersion(),
    platformAssetHint: {
      win32: 'zviewer-windows-x64.zip',
      linux: 'zviewer-linux-x64.tar.gz',
    },
    cases: {},
  };

  for (const [name, testCase] of Object.entries(CASES)) {
    activeReleases = testCase.releases;
    // 输入也写进夹具：Go 侧要拿同一份 releases 喂给假 GitHub，
    // 让两端从「输入 → 输出」整条链可比，而不是只比输出形状。
    const entry = {
      includePrerelease: testCase.includePrerelease,
      releases: testCase.releases,
    };
    try {
      entry.ok = await getUpdateInfo(testCase.includePrerelease);
    } catch (err) {
      entry.error = String((err && err.message) || err);
    }
    output.cases[name] = entry;
  }

  restoreHttps();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, OUT)}`);
  console.log(`  本地版本: ${output.currentVersion}`);
  for (const [name, value] of Object.entries(output.cases)) {
    console.log(`  ${name}: ${value.error ? `错误: ${value.error}` : `hasUpdate=${value.ok.hasUpdate}`}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
