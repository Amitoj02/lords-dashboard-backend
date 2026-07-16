import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { NotificationTone } from '../../common/enums';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** A "Field Dispatch" announcement. Author is a denormalized label (often bot/system). */
@Entity('notifications')
export class Notification extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: NotificationTone, default: NotificationTone.Info })
  tone: NotificationTone;

  @Column({ type: 'varchar', length: 120, nullable: true })
  authorLabel: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
