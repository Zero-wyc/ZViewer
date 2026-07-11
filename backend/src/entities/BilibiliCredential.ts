import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class BilibiliCredential {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  userId!: string;

  @Column({ type: 'text' })
  cookie!: string;

  @Column({ type: 'text', nullable: true })
  refreshToken!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
