import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  ValueTransformer,
} from 'typeorm';
import crypto from 'crypto';
import { Room } from './Room';

const CRYPTO_KEY = process.env.MOVIE_SECRET_KEY || 'zcontrol-movie-secret-key-32b';

function getKeyBuffer(): Buffer {
  return Buffer.from(CRYPTO_KEY.padEnd(32, '0').slice(0, 32));
}

export function encryptMovieField(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKeyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptMovieField(encrypted: string): string {
  const [ivHex, dataHex] = encrypted.split(':');
  if (!ivHex || !dataHex) return '';
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKeyBuffer(), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

const secretTransformer: ValueTransformer = {
  to: (value: unknown) => {
    if (typeof value !== 'string' || !value) return value;
    return encryptMovieField(value);
  },
  from: (value: unknown) => {
    if (typeof value !== 'string' || !value) return value;
    return decryptMovieField(value);
  },
};

@Entity()
export class Movie {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  roomId!: string;

  @Column()
  url!: string;

  @Column()
  title!: string;

  @Column({ type: 'varchar', nullable: true })
  cover!: string | null;

  @Column({ type: 'varchar', nullable: true })
  source!: string | null;

  @Column({ type: 'varchar', nullable: true })
  audioUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  format!: string | null;

  @Column({ type: 'varchar', nullable: true })
  videoCodec!: string | null;

  @Column({ type: 'varchar', nullable: true })
  audioCodec!: string | null;

  @Column({ type: 'float', nullable: true })
  duration!: number | null;

  @Column({ type: 'integer', nullable: true })
  cid!: number | null;

  @Column({ type: 'integer', nullable: true })
  currentQn!: number | null;

  @Column({ type: 'text', nullable: true })
  acceptQuality!: string | null;

  @Column({ type: 'varchar', nullable: true })
  serverUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true, transformer: secretTransformer })
  password!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  @Column({ type: 'integer', default: 0 })
  order!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Room, (room) => room.movies_relation, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
