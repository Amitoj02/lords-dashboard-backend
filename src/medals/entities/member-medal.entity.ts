import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Member } from '../../members/entities/member.entity';
import { Medal } from './medal.entity';

/** Junction: a medal awarded to a member, with per-award metadata. */
@Entity('member_medals')
@Index(['memberId', 'medalId'], { unique: true })
export class MemberMedal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Index()
  @Column({ type: 'char', length: 36 })
  medalId: string;

  @ManyToOne(() => Medal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'medal_id' })
  medal?: Medal;

  @Column({ type: 'varchar', length: 255, nullable: true })
  detail: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  awardedByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'awarded_by_member_id' })
  awardedByMember?: Member | null;

  @CreateDateColumn({ name: 'awarded_at', type: 'datetime', precision: 6 })
  awardedAt: Date;
}
