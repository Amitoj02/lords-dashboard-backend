import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { DiscordConnection } from './discord-connection.entity';

/** A recent bot operation row; `resolvable` flips when an admin resolves it. */
@Entity('bot_operations')
export class BotOperation extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  discordConnectionId: string;

  @ManyToOne(() => DiscordConnection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'discord_connection_id' })
  discordConnection?: DiscordConnection;

  @Column({ type: 'datetime', precision: 6 })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 255 })
  operation: string;

  @Column()
  success: boolean;

  @Column({ default: false })
  resolvable: boolean;
}
