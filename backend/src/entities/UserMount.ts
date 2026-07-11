import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type MountType = 'webdav' | 'ftp' | 'openlist';

@Entity()
export class UserMount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  userId!: number;

  @Column({ type: 'simple-enum', enum: ['webdav', 'ftp', 'openlist'] })
  type!: MountType;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  serverUrl!: string | null;

  @Column({ type: 'integer', nullable: true })
  port!: number | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'varchar', nullable: true })
  indexUrl!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
