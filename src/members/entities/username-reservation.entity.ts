import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { USERNAME_MAX_LENGTH } from '../../common/ids/username';

/** Why a handle is unclaimable while no member holds it. */
export enum UsernameReservationReason {
  /** The previous holder renamed; released once `heldUntil` passes. */
  Cooldown = 'cooldown',
  /** The previous holder deleted their account; never released. */
  Blocked = 'blocked',
}

/**
 * A handle that is free in `members.username` but must not be claimable
 * (T-0215).
 *
 * The UNIQUE index on `members.username` answers "is someone using this?". It
 * cannot answer "did someone JUST stop using this?", and both cases where that
 * matters are cases where letting the next caller win is the wrong outcome:
 *
 *  - a rename leaves the old handle live in Discord messages, event embeds and
 *    anyone's bookmarks for a while, so it is held for a cooldown rather than
 *    handed to whoever is polling for it;
 *  - a deleted account leaves the old handle live in the audit ledger and in
 *    the regiment's memory forever, so it is blocked forever — impersonating a
 *    departed member is the one squat with a real victim.
 *
 * The row deliberately carries no foreign key to `members`: a `blocked`
 * reservation has to outlive the member row it refers to, which is the whole
 * point of it.
 */
@Entity('username_reservations')
export class UsernameReservation {
  /** The normalised (lowercase) handle. */
  @PrimaryColumn({ type: 'varchar', length: USERNAME_MAX_LENGTH })
  username: string;

  @Column({ type: 'enum', enum: UsernameReservationReason })
  reason: UsernameReservationReason;

  /** Who held it, for support questions. Not an FK — see the class note. */
  @Column({ type: 'char', length: 12, nullable: true })
  formerMemberId: string | null;

  /** When the hold lapses. NULL means never. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  heldUntil: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
