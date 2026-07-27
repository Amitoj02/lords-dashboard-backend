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
import { encryptionTransformer } from '../../common/crypto/encryption.transformer';
import { EventStatus, RecurrenceCadence } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** A scheduled regiment event/operation (table `events`). */
@Entity('events')
@Index(['regimentId', 'status'])
// Uniqueness guard for materialized recurring-event occurrences (T-0075): two
// concurrent generation sweeps (or a second app instance) can never double-create
// the same occurrence. Templates and one-off events carry recurrenceTemplateId =
// NULL, and MySQL treats NULLs as distinct in a unique index, so only real
// occurrences are constrained.
@Index('UQ_event_occurrence', ['recurrenceTemplateId', 'startsAt'], { unique: true })
export class RegimentEvent extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'char', length: 12, nullable: true })
  createdByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_member_id' })
  createdByMember?: Member | null;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  bannerUrl: string | null;

  @Index()
  @Column({ type: 'datetime', precision: 6 })
  startsAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  endsAt: Date | null;

  @Column({ type: 'varchar', length: 40, default: 'UTC' })
  timezone: string;

  @Column({ default: false })
  isRecurring: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  recurrenceRule: string | null;

  /**
   * Structured cadence of a recurring template (T-0074). When set together with
   * `recurrenceActive`, the recurrence scheduler materializes this event's future
   * occurrences. Null on one-off events and on generated occurrences.
   */
  @Column({ type: 'enum', enum: RecurrenceCadence, nullable: true })
  recurrenceCadence: RecurrenceCadence | null;

  /**
   * The stop flag: while true (and this row is a template — `recurrenceTemplateId`
   * is null — with a cadence), the scheduler keeps generating occurrences. Setting
   * it false permanently stops generation. Generated occurrences carry false.
   */
  @Column({ default: false })
  recurrenceActive: boolean;

  /**
   * Template linkage: on a generated occurrence, the id of the template event it
   * was materialized from; null on templates and one-off events. Indexed so the
   * scheduler can cheaply find existing occurrences per template (idempotency).
   */
  @Index()
  @Column({ type: 'char', length: 12, nullable: true })
  recurrenceTemplateId: string | null;

  /**
   * The Discord role to ping when this event is ANNOUNCED (T-0205). Null ⇒ the
   * announcement is posted silently.
   *
   * ⚠️ IT IS PINGED EXACTLY ONCE, AT CREATION. Not on the pre-event reminder,
   * not when the embed is re-rendered after an RSVP, and not when the buttons
   * are retired: a role ping is a notification to potentially the whole
   * regiment, and one event must not be able to produce dozens of them. The
   * lead-time notification reaches attendees through a thread on this same
   * message instead, which pings only the people who said they were coming.
   *
   * Cloned onto every generated recurrence occurrence, because each occurrence
   * gets its own announcement and therefore its own single ping.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  announceRoleId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  serverName: string | null;

  @Column({ type: 'text', nullable: true, transformer: encryptionTransformer })
  serverPassword: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  serverRegion: string | null;

  @Column({ type: 'enum', enum: EventStatus, default: EventStatus.Upcoming })
  status: EventStatus;

  @Column({ type: 'int', nullable: true })
  expectedAttendance: number | null;

  @Column({ type: 'int', nullable: true })
  attendanceGoal: number | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  outcome: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  twitchUrl: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  startedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  inLineCount: number | null;

  @Column({ default: false })
  isDraft: boolean;

  @Column({ default: false })
  isArchived: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'datetime', precision: 6, nullable: true })
  deletedAt: Date | null;
}
