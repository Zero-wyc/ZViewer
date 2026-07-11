import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_URL || 'dev.sqlite',
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
  entities: [Room, Session, User, Comment, BilibiliCredential, Movie, UserMount, SystemSettings],
  migrations: [],
  subscribers: [],
});
