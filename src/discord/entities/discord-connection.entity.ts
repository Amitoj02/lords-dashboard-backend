import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { BotConnectionStatus } from '../../common/enums';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * Read-only persisted status of the "Quartermaster" Discord bot (the bot itself
 * is NOT built here). Server id/name are read from the regiment, not duplicated.
 */
@Entity('discord_connections')
export class DiscordConnection extends ShortIdEntity {
  @Index({ unique: true })
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @OneToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 20, nullable: true })
  botVersion: string | null;

  @Column({ type: 'enum', enum: BotConnectionStatus, default: BotConnectionStatus.Idle })
  connectionStatus: BotConnectionStatus;

  @Column({ type: 'int', nullable: true })
  botRolePosition: number | null;

  @Column({ type: 'int', nullable: true })
  totalRoles: number | null;

  @Column({ type: 'int', nullable: true })
  rolesUnderAuthority: number | null;

  @Column({ type: 'int', nullable: true })
  membersVisible: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastHeartbeatAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastFullSyncAt: Date | null;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  uptimeSeconds: string | null;

  @Column({ type: 'json', nullable: true })
  permissions: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  requiredPermissions: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
