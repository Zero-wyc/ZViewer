/**
 * B站 账号/番剧/视频/收藏/评论/栏目路由聚合入口。
 *
 * 原单文件 1775 行已按领域拆分为子路由（均挂载于同一前缀，
 * 需登录态，由父路由统一 authenticateToken）：
 *
 *   bilibili-account.routes.ts    扫码/Cookie 登录、登录状态、登出、用户信息
 *   bilibili-bangumi.routes.ts    关注番剧、番剧集数
 *   bilibili-videos.routes.ts     视频信息、分区榜单、相关推荐、搜索、AI 字幕
 *   bilibili-favorites.routes.ts  收藏夹浏览、收藏/取消收藏、收藏状态
 *   bilibili-comments.routes.ts   主楼评论、楼中楼回复
 *   bilibili-lists.routes.ts      合集/系列链接解析与分页
 */

import { Router } from 'express';

import bilibiliAccountRouter from './bilibili-account.routes';
import bilibiliBangumiRouter from './bilibili-bangumi.routes';
import bilibiliVideosRouter from './bilibili-videos.routes';
import bilibiliFavoritesRouter from './bilibili-favorites.routes';
import bilibiliCommentsRouter from './bilibili-comments.routes';
import bilibiliListsRouter from './bilibili-lists.routes';

const router = Router();

router.use(bilibiliAccountRouter);
router.use(bilibiliBangumiRouter);
router.use(bilibiliVideosRouter);
router.use(bilibiliFavoritesRouter);
router.use(bilibiliCommentsRouter);
router.use(bilibiliListsRouter);

export default router;
