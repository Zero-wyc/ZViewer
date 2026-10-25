#!/usr/bin/env node
/**
 * 对拍预载：把 Node 版的内部 NCM 服务换成「指向假服务」的桩。
 *
 * 为什么需要：Node 版用 `@neteasecloudmusicapienhanced/api` 在本进程内起
 * 127.0.0.1:36530 的服务，端口和内容都不受控（而且会真打网易云）。对拍要的是
 * 「同一份上游、两边分别解析」，所以把 `getNcmApiBase()` 固定到假服务。
 *
 * 做法：`ncm-api.service` 里 `ncmApiBase` 是模块级变量、没有 setter，
 * 只能在加载前把编译产物塞进 require.cache —— 模块解析到同一个 `.ts` 路径后
 * 直接命中缓存，不会真的执行原文件。
 *
 * 用法（必须排在 ts-node 之后）：
 *   node -r ts-node/register/transpile-only -r scripts/ncm-parity-preload.js src/index.ts
 */
'use strict';

const path = require('node:path');
const Module = require('node:module');

const base = process.env.NCM_API_BASE || '';
const target = path.resolve(__dirname, '../../backend/src/modules/music/ncm-api.service.ts');

const stub = new Module(target, module);
stub.filename = target;
stub.loaded = true;
stub.exports = {
  getNcmApiBase: () => base,
  startNcmApiService: async () => base,
  stopNcmApiService: () => {},
};

require.cache[target] = stub;
