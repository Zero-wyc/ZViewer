import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type UserRole = 'root' | 'admin' | 'user' | 'guest';
export type UserStatus = 'active' | 'pending';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'simple-enum', enum: ['root', 'admin', 'user', 'guest'], default: 'guest' })
  role!: UserRole;

  @Column({ type: 'simple-enum', enum: ['active', 'pending'], default: 'pending' })
  status!: UserStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
