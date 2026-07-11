import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Room } from './Room';

export type SessionRole = 'sharer' | 'viewer';

@Entity()
export class Session {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  roomId!: string;

  @Column()
  socketId!: string;

  @Column({ type: 'simple-enum', enum: ['sharer', 'viewer'] })
  role!: SessionRole;

  @CreateDateColumn()
  startedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  endedAt!: Date | null;

  @ManyToOne(() => Room, (room) => room.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
