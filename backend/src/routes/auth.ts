import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { AppDataSource } from '../data-source';
import { User } from '../entities/User';
import { getSystemSettings } from '../index';
import {
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
  setAuthCookies,
  setAccessTokenCookie,
  clearAuthCookies,
  invalidateUserTokens,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  authLimiter,
  loginPreCheck,
  recordLoginFailure,
  clearLoginFailures,
  passwordLimiter,
} from '../middleware/rate-limit';
import { AVATARS_DIR } from '../services/paths';
import { writeAuditLog } from '../services/audit';

const router = Router();
const userRepository = () => AppDataSource.getRepository(User);

/**
 * 密码强度软提示（不阻断注册/改密，仅返回建议）。
 * 评分维度：长度 ≥8、含小写、含大写、含数字、含特殊字符。
 */
function passwordStrengthHint(password: string): string | undefined {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 2) {
    return '密码强度较弱：建议至少 8 位并混合大小写字母、数字和特殊字符';
  }
  if (score === 3) {
    return '密码强度一般：加入更多字符类型可提高安全性';
  }
  return undefined; // 强密码不提示
}

/** 头像上传 multer 配置：仅接受图片，存储到 AVATARS_DIR。 */
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(AVATARS_DIR)) {
      fs.mkdirSync(AVATARS_DIR, { recursive: true });
    }
    cb(null, AVATARS_DIR);
  },
  filename: (req, file, cb) => {
    const userId = (req as AuthenticatedRequest).user?.userId ?? 0;
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    // 文件名格式：<userId>-<timestamp>.<ext>，避免冲突并便于清理
    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JPG / PNG / GIF / WEBP 格式'));
    }
  },
});

router.post(
  '/register',
  authLimiter,
  async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { username, password } = req.body;

      // 用户名格式：2-24 位，允许中文字母数字下划线连字符空格（首尾空白已 trim）
      const USERNAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24}$/;
      if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !username.trim() ||
        !USERNAME_PATTERN.test(username.trim()) ||
        password.length < 4
      ) {
        res.status(400).json({
          success: false,
          message:
            '用户名需 2-24 位（中文/字母/数字/下划线/连字符/空格），密码至少 4 位',
        });
        return;
      }

      const settings = await getSystemSettings();
      const mode = settings.registrationMode;

      if (mode === 'closed') {
        res.status(403).json({ success: false, message: '注册已关闭' });
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

      const passwordHash = await bcrypt.hash(password, 10);
      const isOpen = mode === 'open';
      const user = userRepository().create({
        username: trimmedUsername,
        passwordHash,
        role: 'user',
        status: isOpen ? 'active' : 'pending',
      });
      await userRepository().save(user);
      // 显式触发 autoSave，确保注册用户立即写入文件
      await (AppDataSource.driver as import('typeorm/driver/sqljs/SqljsDriver').SqljsDriver).autoSave().catch(() => {});

      if (isOpen) {
        const tokens = generateTokens(user.id, user.role, user.username);
        setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
      }

      res.status(201).json({
        success: true,
        message: isOpen
          ? '注册成功'
          : '注册成功，请等待管理员审核通过后再登录',
        passwordHint: passwordStrengthHint(password),
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
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
  loginPreCheck,
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
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        // 记录登录失败（防暴力破解：连续失败达阈值后临时锁定）
        recordLoginFailure(req);
        writeAuditLog({
          action: 'login_failed',
          actorUsername: username.trim(),
          ip: req.ip,
          success: false,
          detail: '用户名或密码错误',
        });
        res.status(401).json({ success: false, message: '用户名或密码错误' });
        return;
      }
      if (user.status === 'pending') {
        res.status(403).json({ success: false, message: '账号正在审核中，请稍后再试' });
        return;
      }

      clearLoginFailures(req);

      const tokens = generateTokens(user.id, user.role, user.username);
      setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);

      // V3：root 使用默认密码时向响应携带告警标记，前端据此显示安全警告
      const usingDefaultPassword =
        user.role === 'root' &&
        bcrypt.compareSync('root', user.passwordHash);

      writeAuditLog({
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        action: 'login',
        ip: req.ip,
      });

      res.json({
        success: true,
        ...tokens,
        mustChangePassword: usingDefaultPassword || undefined,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
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
        setAccessTokenCookie(req, res, accessToken);
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
      setAccessTokenCookie(req, res, accessToken);
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
  (req: import('express').Request, res: import('express').Response): void => {
    clearAuthCookies(req, res);
    res.json({ success: true, message: '已退出登录' });
  },
);

/** 公开接口：获取当前注册模式，供登录/注册页展示用。 */
router.get(
  '/registration-mode',
  async (
    _req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const settings = await getSystemSettings();
      res.json({
        success: true,
        mode: settings.registrationMode,
      });
    } catch (err) {
      console.error('registration-mode error:', err);
      res.status(500).json({ success: false, message: '获取注册模式失败' });
    }
  },
);

/**
 * 公开接口：返回前端启动所需的公开系统设置（无需鉴权）。
 *
 * 仅暴露非敏感字段：
 * - registrationMode：注册模式（登录/注册页展示）
 * - roomCreationMode：房间创建权限模式（HomePage 据此决定是否显示「开始共享」按钮）
 * - betaFeaturesEnabled：Beta 功能开关
 *
 * 管理员级完整设置走 GET /api/admin/settings。
 */
router.get(
  '/public-settings',
  async (
    _req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const settings = await getSystemSettings();
      res.json({
        success: true,
        settings: {
          registrationMode: settings.registrationMode,
          roomCreationMode: settings.roomCreationMode,
          betaFeaturesEnabled: settings.betaFeaturesEnabled,
          dashDisabled: settings.dashDisabled,
          playsvideoEnabled: settings.playsvideoEnabled,
        },
      });
    } catch (err) {
      console.error('public-settings error:', err);
      res.status(500).json({ success: false, message: '获取公开设置失败' });
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
      if (req.user!.userId === 0 && req.user!.role === 'guest') {
        res.json({
          success: true,
          user: { id: 0, username: 'guest', role: 'guest', status: 'active', avatar: null },
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
          avatar: user.avatar,
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
  passwordLimiter,
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

      if (!(await bcrypt.compare(oldPassword, user.passwordHash))) {
        res.status(401).json({ success: false, message: '原密码错误' });
        return;
      }

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      await userRepo.save(user);
      // 显式触发 autoSave，确保密码修改立即写入文件
      await (AppDataSource.driver as import('typeorm/driver/sqljs/SqljsDriver').SqljsDriver).autoSave().catch(() => {});
      // V5：改密后使此前签发的所有 token 立即失效（含被盗的 refresh token）。
      // 客户端下次请求会收到 401，凭新密码重新登录获取新 token。
      await invalidateUserTokens(user.id);
      writeAuditLog({
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        action: 'password_changed',
        ip: req.ip,
      });
      res.json({
        success: true,
        message: '密码修改成功，请重新登录',
        passwordHint: passwordStrengthHint(newPassword),
      });
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
      // 显式触发 autoSave，确保用户名修改立即写入文件
      await (AppDataSource.driver as import('typeorm/driver/sqljs/SqljsDriver').SqljsDriver).autoSave().catch(() => {});
      writeAuditLog({
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        action: 'username_changed',
        ip: req.ip,
      });
      res.json({
        success: true,
        message: '用户名修改成功',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
        },
      });
    } catch (err) {
      console.error('change username error:', err);
      res.status(500).json({ success: false, message: '修改用户名失败' });
    }
  },
);

/** 上传/更新当前用户头像 */
router.post(
  '/avatar',
  authenticateToken,
  avatarUpload.single('avatar'),
  async (
    req: AuthenticatedRequest & { file?: Express.Multer.File },
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (req.user!.userId === 0 && req.user!.role === 'guest') {
        res.status(403).json({ success: false, message: '游客无法设置头像' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, message: '未接收到头像文件' });
        return;
      }

      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      // 删除旧头像文件（非 root 默认头像）
      const oldAvatar = user.avatar;
      if (oldAvatar && oldAvatar.startsWith('/uploads/avatars/')) {
        const oldPath = path.join(AVATARS_DIR, path.basename(oldAvatar));
        try {
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch {
          // 旧文件删除失败不阻断流程
        }
      }

      // 存储相对路径，前端拼接 API_URL 使用
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;
      user.avatar = avatarUrl;
      await userRepo.save(user);

      res.json({
        success: true,
        message: '头像更新成功',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
        },
      });
    } catch (err) {
      console.error('upload avatar error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '头像上传失败',
      });
    }
  },
);

/** 删除当前用户头像（恢复默认） */
router.delete(
  '/avatar',
  authenticateToken,
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (req.user!.userId === 0 && req.user!.role === 'guest') {
        res.status(403).json({ success: false, message: '游客无头像' });
        return;
      }
      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id: req.user!.userId });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }
      if (user.avatar && user.avatar.startsWith('/uploads/avatars/')) {
        const oldPath = path.join(AVATARS_DIR, path.basename(user.avatar));
        try {
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch {
          // ignore
        }
      }
      user.avatar = null;
      await userRepo.save(user);
      res.json({
        success: true,
        message: '头像已删除',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
        },
      });
    } catch (err) {
      console.error('delete avatar error:', err);
      res.status(500).json({ success: false, message: '删除头像失败' });
    }
  },
);

/** 获取匿名 guest 令牌 */
router.post(
  '/guest',
  async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const tokens = generateTokens(0, 'guest', 'guest');
      setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
      res.json({
        success: true,
        ...tokens,
        user: { id: 0, username: 'guest', role: 'guest', status: 'active', avatar: null },
      });
    } catch (err) {
      console.error('guest token error:', err);
      res.status(500).json({ success: false, message: '获取游客令牌失败' });
    }
  },
);

export default router;
