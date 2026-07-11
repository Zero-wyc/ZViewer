import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Session } from './Session';
import { Movie } from './Movie';

export type RoomStatus = 'active' | 'closed';
export type RoomMode = 'screen-share' | 'watch-together' | 'bili-compat';

@Entity()
export class Room {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  roomId!: string;

  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'integer', default: 10 })
  maxViewers!: number;

  @Column({ type: 'simple-enum', enum: ['active', 'closed'], default: 'active' })
  status!: RoomStatus;

  @Column({ type: 'simple-enum', enum: ['screen-share', 'watch-together', 'bili-compat'], default: 'screen-share' })
  mode!: RoomMode;

  @Column({ type: 'boolean', default: true })
  requireApproval!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  lastAccessedAt!: Date;

  @OneToMany(() => Session, (session) => session.room)
  sessions!: Session[];

  @OneToMany(() => Movie, (movie) => movie.room, { cascade: true })
  movies_relation!: Movie[];
}
