import bcrypt from 'bcryptjs';
import { AppDataSource } from '../data-source';
import { User } from '../entities/User';

/**
 * 默认超级管理员种子数据（从根 index.ts 抽出）。
 *
 * 仅在数据库无 role='root' 用户时创建 root/root；
 * 若存在同名 root 但角色不是 root（旧版管理员），迁移为 root。
 */
export async function seedRootAdmin(): Promise<void> {
  const userRepo = AppDataSource.getRepository(User);
  // 通过 role 查找而非 username 查找，避免 root 用户改名后服务器重启
  // 时重新创建默认 root 账户，导致出现两个超级管理员。
  const existingRoot = await userRepo.findOneBy({ role: 'root' });
  if (!existingRoot) {
    // 也没有 username='root' 的用户（首次启动或全新数据库），创建默认 root
    const existingByName = await userRepo.findOneBy({ username: 'root' });
    if (!existingByName) {
      const root = userRepo.create({
        username: 'root',
        passwordHash: bcrypt.hashSync('root', 10),
        role: 'root',
        status: 'active',
      });
      await userRepo.save(root);
      console.log('Default root user created: root / root');
    } else if (existingByName.role !== 'root') {
      // 迁移旧版管理员为 root
      existingByName.role = 'root';
      existingByName.status = 'active';
      await userRepo.save(existingByName);
      console.log('Existing root user role migrated to root');
    }
  }
  // 已存在 role='root' 的用户（可能是改过名的 root），不重新创建
}
