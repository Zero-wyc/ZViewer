/**
 * Comment 模块入口。
 *
 * 导出评论服务与 Socket 事件处理器。
 */
export { CommentService, commentService } from './comment.service';
export { CommentHandler } from './handlers/comment.handler';
export type { CommentDto, AnnotationStroke } from './handlers/comment.handler';
