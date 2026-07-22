/**
 * Movie 模块入口。
 *
 * 导出影片 CRUD 服务、广播服务、Socket 事件处理器与 REST 路由。
 */
export { MovieService, movieService } from './movie.service';
export { MovieBroadcasterService, movieBroadcasterService } from './movie-broadcaster.service';
export { MovieListHandler } from './handlers/movie-list.handler';
export { PreviewHandler } from './handlers/preview.handler';
export type { PreviewSourcePayload } from './handlers/preview.handler';
export { createMovieRouter } from './movie.routes';
