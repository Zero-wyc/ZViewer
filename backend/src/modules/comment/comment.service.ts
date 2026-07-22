/**
 * 评论服务。
 *
 * 封装 Comment 实体的 CRUD 操作。弹幕为不持久化的瞬时事件，不走此服务。
 *
 * 设计目的：
 * - 消除旧架构中 index.ts 内联的 commentRepository 操作
 * - 提供评论创建与历史查询的统一入口
 */
import { AppDataSource } from '../../data-source';
import { Comment } from '../../entities/Comment';

/**
 * 评论服务。
 *
 * 单例服务。
 */
export class CommentService {
  /**
   * 创建评论记录。
   *
   * @param roomId 房间 ID
   * @param userId 用户 ID（保留参数，便于未来扩展为关联用户）
   * @param username 用户名（冗余存储，避免联表查询）
   * @param content 评论内容
   * @param isDanmaku 是否为弹幕评论（仅影响 isDanmaku 标记，不影响持久化）
   */
  async createComment(
    roomId: string,
    userId: number,
    username: string,
    content: string,
    isDanmaku: boolean,
  ): Promise<Comment> {
    void userId; // 当前实体未关联 userId，保留参数以备扩展
    const repo = AppDataSource.getRepository(Comment);
    const comment = repo.create({
      roomId,
      username,
      content,
      isDanmaku,
    });
    await repo.save(comment);
    return comment;
  }

  /**
   * 查询指定房间的评论历史，按创建时间升序排列。
   */
  async listComments(roomId: string): Promise<Comment[]> {
    const repo = AppDataSource.getRepository(Comment);
    return repo.find({
      where: { roomId },
      order: { createdAt: 'ASC' },
    });
  }
}

/** 全局单例 */
export const commentService = new CommentService();
