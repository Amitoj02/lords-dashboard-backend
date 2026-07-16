import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { Member } from '../../members/entities/member.entity';
import { Medal } from './medal.entity';

/**
 * Junction: a medal awarded to a member, with per-award metadata. A medal may be
 * awarded to the same member MORE THAN ONCE (owner decision) — the frontend shows
 * how many times each medal was earned — so (member_id, medal_id) is a plain,
 * non-unique index (for fast per-member lookups), not a unique constraint. Each
 * award is its own row with its own awardedAt/awardedByMemberId/detail.
 */
@Entity('member_medals')
@Index(['memberId', 'medalId'])
export class MemberMedal extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Index()
  @Column({ type: 'char', length: 12 })
  medalId: string;

  @ManyToOne(() => Medal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'medal_id' })
  medal?: Medal;

  @Column({ type: 'varchar', length: 255, nullable: true })
  detail: string | null;

  @Column({ type: 'char', length: 12, nullable: true })
  awardedByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'awarded_by_member_id' })
  awardedByMember?: Member | null;

  @CreateDateColumn({ name: 'awarded_at', type: 'datetime', precision: 6 })
  awardedAt: Date;
}
