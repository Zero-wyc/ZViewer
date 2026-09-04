/**
 * 流量统计路由（仅 root）
 *
 * GET /api/stats/traffic —— 服务端网卡级收发流量（累计值 + 即时速度）
 */
import { Router } from 'express';
import {
  authenticateToken,
  requireRoot,
} from '../middleware/auth';
import { getNetworkStats } from '../services/traffic';

const router = Router();

router.get('/traffic', authenticateToken, requireRoot, async (_req, res) => {
  const stats = await getNetworkStats();
  if (!stats) {
    return res
      .status(501)
      .json({ success: false, message: '当前平台不支持网络流量统计' });
  }
  return res.json({ success: true, stats });
});

export default router;
