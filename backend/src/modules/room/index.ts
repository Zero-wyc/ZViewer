/**
 * Room 模块 —— 房间领域模块入口。
 *
 * 导出房间核心服务和 socket 事件处理器。
 */
export { RoomStateService, roomStateService, type RoomRuntimeState, HOST_RECONNECT_GRACE_MS } from './room-state.service';
export { RoomPermissionService, roomPermissionService } from './room-permission.service';
export { RoomSessionService, roomSessionService } from './room-session.service';
export { RoomLifecycleHandler } from './handlers/room-lifecycle.handler';
export { RoomSettingsHandler } from './handlers/room-settings.handler';
export { RoomDisconnectHandler } from './handlers/room-disconnect.handler';
export { RegisterHostHandler } from './handlers/register-host.handler';
