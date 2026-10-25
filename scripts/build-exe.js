#!/usr/bin/env node
/**
 * `npm run build:exe` 的历史入口，现在等价于 `node scripts/build-backend.js`。
 *
 * 真正的编译逻辑只保留一份（build-backend.js）：产物名带平台后缀、
 * `CGO_ENABLED=0`、`-trimpath`。这里只做参数透传——两处各写一份 go build
 * 迟早会走偏（一边改了 ldflags、另一边没改）。
 *
 * 后端自 2026-10 起只有 Go 实现，原来的 @yao-pkg/pkg 打包链路已随
 * `backend/` 一起删除，不再支持 `--backend=node`。
 */
'use strict';

require('./build-backend.js').main();
