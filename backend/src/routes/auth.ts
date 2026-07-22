import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../data-source';
import { User } from '../entities/User';
import {
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
  setAuthCookies,
  setAccessTokenCookie,
  clearAuthCookies,
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
        status: 'pending',
      });
      await userRepository().save(user);

      const tokens = generateTokens(user.id, user.role, user.username);
      setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
      res.status(201).json({
        success: true,
        ...tokens,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
        },
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
      if (user.status === 'pending') {
        res.status(403).json({ success: false, message: '账号正在审核中，请稍后再试' });
        return;
      }

      const tokens = generateTokens(user.id, user.role, user.username);
      setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
      res.json({
        success: true,
        ...tokens,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
        },
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
      // 优先从 cookie 读取 refresh_token（httpOnly，前端无法读取）
      // 兼容旧 body.refreshToken 字段以便过渡期不破坏老客户端
      const refreshToken =
        (req.cookies?.refresh_token as string | undefined) ||
        (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');

      if (!refreshToken) {
        res.status(401).json({ success: false, message: '未提供刷新令牌' });
        return;
      }

      const payload = verifyRefreshToken(refreshToken);
      if (payload.userId === 0 && payload.role === 'guest') {
        const { accessToken } = generateTokens(0, 'guest', 'guest');
        setAccessTokenCookie(res, accessToken);
        res.json({ success: true, accessToken });
        return;
      }
      const user = await userRepository().findOneBy({ id: payload.userId });
      if (!user) {
        res.status(403).json({ success: false, message: '用户不存在' });
        return;
      }
      if (user.status === 'pending') {
        res.status(403).json({ success: false, message: '账号正在审核中' });
        return;
      }

      const { accessToken } = generateTokens(user.id, user.role, user.username);
      setAccessTokenCookie(res, accessToken);
      res.json({ success: true, accessToken });
    } catch (err) {
      console.error('refresh error:', err);
      res.status(403).json({ success: false, message: '刷新令牌无效或已过期' });
    }
  },
);

/** 登出：清空 auth cookie。前端调用此接口后浏览器立即清除 token。 */
router.post(
  '/logout',
  (_req: import('express').Request, res: import('express').Response): void => {
    clearAuthCookies(res);
    res.json({ success: true, message: '已退出登录' });
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
      if (req.user!.userId === 0 && req.user!.role === 'guest') {
        res.json({
          success: true,
          user: { id: 0, username: 'guest', role: 'guest', status: 'active' },
        });
        return;
      }
      const user = await userRepository().findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
        },
      });
    } catch (err) {
      console.error('me error:', err);
      res.status(500).json({ success: false, message: '获取用户信息失败' });
    }
  },
);

/** 修改当前用户密码 */
router.patch(
  '/password',
  authenticateToken,
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (req.user!.userId === 0 && req.user!.role === 'guest') {
        res.status(403).json({ success: false, message: '游客无法修改密码' });
        return;
      }

      const { oldPassword, newPassword } = req.body;
      if (
        typeof oldPassword !== 'string' ||
        typeof newPassword !== 'string' ||
        !oldPassword ||
        newPassword.length < 4
      ) {
        res.status(400).json({
          success: false,
          message: '原密码或新密码格式不正确，新密码至少 4 位',
        });
        return;
      }

      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      if (!bcrypt.compareSync(oldPassword, user.passwordHash)) {
        res.status(401).json({ success: false, message: '原密码错误' });
        return;
      }

      user.passwordHash = bcrypt.hashSync(newPassword, 10);
      await userRepo.save(user);
      res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
      console.error('change password error:', err);
      res.status(500).json({ success: false, message: '修改密码失败' });
    }
  },
);

/** root 修改当前用户名 */
router.patch(
  '/username',
  authenticateToken,
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (req.user!.role !== 'root') {
        res.status(403).json({ success: false, message: '仅 root 可修改用户名' });
        return;
      }

      const { username } = req.body;
      if (typeof username !== 'string' || !username.trim()) {
        res.status(400).json({ success: false, message: '用户名不能为空' });
        return;
      }

      const trimmedUsername = username.trim();
      const userRepo = userRepository();
      const existing = await userRepo.findOneBy({ username: trimmedUsername });
      if (existing && existing.id !== req.user!.userId) {
        res.status(409).json({ success: false, message: '用户名已存在' });
        return;
      }

      const user = await userRepo.findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      user.username = trimmedUsername;
      await userRepo.save(user);
      res.json({
        success: true,
        message: '用户名修改成功',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
        },
      });
    } catch (err) {
      console.error('change username error:', err);
      res.status(500).json({ success: false, message: '修改用户名失败' });
    }
  },
);

/** 获取匿名 guest 令牌 */
router.post(
  '/guest',
  async (
    _req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const tokens = generateTokens(0, 'guest', 'guest');
      setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
      res.json({
        success: true,
        ...tokens,
        user: { id: 0, username: 'guest', role: 'guest', status: 'active' },
      });
    } catch (err) {
      console.error('guest token error:', err);
      res.status(500).json({ success: false, message: '获取游客令牌失败' });
    }
  },
);

export default router;
