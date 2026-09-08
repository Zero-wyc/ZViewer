import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { NcmCredential } from './entities/NcmCredential';
import { MusicQueueItem } from './entities/MusicQueueItem';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';
import { PlaybackState } from './entities/PlaybackState';
import { ServerFolder } from './entities/ServerFolder';
import { DanmakuTrack } from './entities/DanmakuTrack';
import { RoomDanmakuMeta } from './entities/RoomDanmakuMeta';
import { AuditLog } from './entities/AuditLog';
import { DATABASE_PATH } from './services/paths';

export const AppDataSource = new DataSource({
  // sql.js（wasm）驱动：纯 JS 实现，无原生模块，单文件版可在任意平台运行
  type: 'sqljs',
  // 数据库文件统一存放在 config/ 目录下，便于升级时整体保留。
  // 路径解析详见 services/paths.ts（支持 DATABASE_URL 环境变量覆盖）。
  location: DATABASE_PATH,
  // 变更后自动保存到文件（Node 环境使用文件系统持久化，而非浏览器 IndexedDB）
  autoSave: true,
  useLocalForage: false,
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
  entities: [Room, Session, User, Comment, BilibiliCredential, NcmCredential, MusicQueueItem, Movie, UserMount, SystemSettings, PlaybackState, ServerFolder, DanmakuTrack, RoomDanmakuMeta, AuditLog],
  migrations: [],
  subscribers: [],
});
