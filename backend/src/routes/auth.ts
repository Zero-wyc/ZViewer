import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../data-source';
import { User } from '../entities/User';
import {
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';

const router = Router();
const userRepository = () => AppDataSource.getRepository(User);

router.post(
  '/register',
  async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { username, password } = req.body;

      if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !username.trim() ||
        password.length < 4
      ) {
        res.status(400).json({
          success: false,
          message: '用户名或密码格式不正确，密码至少 4 位',
        });
        return;
      }

      const trimmedUsername = username.trim();
      const existing = await userRepository().findOneBy({
        username: trimmedUsername,
      });
      if (existing) {
        res.status(409).json({ success: false, message: '用户名已存在' });
        return;
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      const user = userRepository().create({
        username: trimmedUsername,
        passwordHash,
        role: 'user',
      });
      await userRepository().save(user);

      const tokens = generateTokens(user.id, user.role);
      res.status(201).json({
        success: true,
        ...tokens,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      console.error('register error:', err);
      res.status(500).json({ success: false, message: '注册失败' });
    }
  },
);

router.post(
  '/login',
  async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { username, password } = req.body;

      if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !username.trim()
      ) {
        res.status(400).json({
          success: false,
          message: '用户名或密码格式不正确',
        });
        return;
      }

      const user = await userRepository().findOneBy({ username: username.trim() });
      if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        res.status(401).json({ success: false, message: '用户名或密码错误' });
        return;
      }

      const tokens = generateTokens(user.id, user.role);
      res.json({
        success: true,
        ...tokens,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      console.error('login error:', err);
      res.status(500).json({ success: false, message: '登录失败' });
    }
  },
);

router.post(
  '/refresh',
  async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { refreshToken } = req.body;
      if (typeof refreshToken !== 'string' || !refreshToken) {
        res.status(401).json({ success: false, message: '未提供刷新令牌' });
        return;
      }

      const payload = verifyRefreshToken(refreshToken);
      const user = await userRepository().findOneBy({ id: payload.userId });
      if (!user) {
        res.status(403).json({ success: false, message: '用户不存在' });
        return;
      }

      const { accessToken } = generateTokens(user.id, user.role);
      res.json({ success: true, accessToken });
    } catch (err) {
      console.error('refresh error:', err);
      res.status(403).json({ success: false, message: '刷新令牌无效或已过期' });
    }
  },
);

router.get(
  '/me',
  authenticateToken,
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const user = await userRepository().findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      res.json({
        success: true,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      console.error('me error:', err);
      res.status(500).json({ success: false, message: '获取用户信息失败' });
    }
  },
);

export default router;
