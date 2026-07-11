import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity()
export class Comment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  roomId!: string;

  @Column()
  username!: string;

  @Column()
  content!: string;

  @Column({ type: 'boolean', default: false })
  isDanmaku!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
