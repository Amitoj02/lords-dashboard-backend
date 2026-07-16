import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { Regiment } from '../../regiments/entities/regiment.entity';
import { Member } from './member.entity';

/** A member's service timeline entry (enlistment, promotion, award, deployment). */
@Entity('service_record_entries')
export class ServiceRecordEntry extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'datetime', precision: 6 })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 40 })
  type: string;

  @Column({ type: 'varchar', length: 160 })
  event: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
