import { Router } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import { getUpdateInfo, applyUpdate } from '../services/updater';

const router = Router();

function rootOnly(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅 root 可操作' });
    return;
  }
  next();
}

router.use(authenticateToken, rootOnly);

/** 检查更新 */
router.get(
  '/check',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const info = await getUpdateInfo();
      res.json({ success: true, info });
    } catch (err) {
      console.error('update check error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '检查更新失败',
      });
    }
  },
);

/** 应用更新 */
router.post(
  '/apply',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const result = await applyUpdate();
      res.json(result);
    } catch (err) {
      console.error('update apply error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '应用更新失败',
      });
    }
  },
);

export default router;
