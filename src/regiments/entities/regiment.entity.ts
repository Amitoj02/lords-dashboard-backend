import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { Member } from '../../members/entities/member.entity';
import { AccentTone } from './accent-tone.entity';

/** Tenant root. One row in v1; every domain table carries a regiment_id FK. */
@Entity('regiments')
export class Regiment extends ShortIdEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  missionStatement: string | null;

  @Column({ type: 'varchar', length: 20, default: 'brass' })
  accentTone: string;

  @ManyToOne(() => AccentTone, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'accent_tone', referencedColumnName: 'key' })
  accentToneRef?: AccentTone;

  @Column({ type: 'varchar', length: 512, nullable: true })
  crestUrl: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  bannerUrl: string | null;

  @Column({ type: 'smallint', unsigned: true, nullable: true })
  establishedYear: number | null;

  // Full establishment date (YYYY-MM-DD). Read back from MySQL as a string; drives
  // the landing "Since est MM/YYYY" line (T-0102). `establishedYear` is retained.
  @Column({ type: 'date', nullable: true })
  establishedAt: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  discordInviteUrl: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  discordServerId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  discordServerName: string | null;

  @Column({ type: 'tinyint', unsigned: true, default: 1 })
  setupStep: number;

  @Column({ default: false })
  setupComplete: boolean;

  @Column({ type: 'char', length: 12, nullable: true })
  ownerMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'owner_member_id' })
  ownerMember?: Member | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'dissolved_at', type: 'datetime', precision: 6, nullable: true })
  dissolvedAt: Date | null;
}
