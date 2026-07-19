import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** Medal/award catalogue (lookup table, per regiment). */
@Entity('medals')
@Index(['regimentId', 'title'], { unique: true })
export class Medal extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 4 })
  glyph: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  description: string | null;

  /** Public URL of an uploaded medal image (via the storage presign flow, T-0069). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  imageUrl: string | null;

  @Column({ type: 'int', default: 0 })
  precedence: number;

  @Column({ type: 'varchar', length: 80, nullable: true })
  discordRoleName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  discordRoleId: string | null;

  @Column({ default: false })
  linked: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
