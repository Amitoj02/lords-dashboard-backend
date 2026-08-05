import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import {
  USERNAME_COOLDOWN_DAYS,
  isReservedUsername,
  isUsername,
  normalizeUsername,
} from '../common/ids/username';
import { Member } from './entities/member.entity';
import {
  UsernameReservation,
  UsernameReservationReason,
} from './entities/username-reservation.entity';

/** Why a handle cannot be claimed, in a form the UI can render verbatim. */
export type UsernameRejection =
  'invalid' | 'reserved' | 'taken' | 'cooldown_target' | 'cooldown_actor';

export interface UsernameAvailability {
  available: boolean;
  reason?: UsernameRejection;
  /** For `cooldown_actor`: when the caller may next rename. */
  retryAfter?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything that decides whether a member may hold a handle (T-0215).
 *
 * Split out of `MembersService` — which is already 1300 lines — because the
 * rules here are the kind that get quietly broken by an unrelated edit: four
 * separate refusals, two of them time-based, and one of them enforced by a
 * database index rather than by any code path you can read.
 *
 * ── THE FOUR REFUSALS ───────────────────────────────────────────────────────
 *  1. shape       — {@link isUsername}, enforced again here and not only in the
 *                   DTO, because {@link claimFor} is also reachable from
 *                   non-HTTP callers.
 *  2. reserved    — the code-owned blocklist.
 *  3. held        — a `username_reservations` row that has not lapsed.
 *  4. in use      — the UNIQUE index. Checked optimistically here for a decent
 *                   error message, and enforced by the index for correctness:
 *                   between the check and the write, two callers can race, and
 *                   only ER_DUP_ENTRY is authoritative. Both paths produce the
 *                   same 409, so the race is invisible to the client.
 *
 * Plus the rename cooldown, which is about the CALLER rather than the handle.
 */
@Injectable()
export class UsernameService {
  constructor(
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(UsernameReservation)
    private readonly reservations: Repository<UsernameReservation>,
  ) {}

  /**
   * Can `member` claim `candidate` right now? Never throws — this backs the
   * live availability check the account form calls while typing, so every
   * refusal is data.
   */
  async check(candidate: string, member: Member | null): Promise<UsernameAvailability> {
    const username = normalizeUsername(candidate);

    if (!isUsername(username)) return { available: false, reason: 'invalid' };
    if (isReservedUsername(username)) return { available: false, reason: 'reserved' };

    // Re-claiming the handle you already hold is a no-op, not a conflict.
    if (member?.username === username) return { available: true };

    const cooldown = this.renameCooldownFor(member);
    if (cooldown) {
      return { available: false, reason: 'cooldown_actor', retryAfter: cooldown.toISOString() };
    }

    const held = await this.activeReservation(username);
    if (held) {
      return {
        available: false,
        // A permanently blocked handle and one still in its cooldown are
        // different answers to "when could I have this?", so the UI can say so.
        reason: held.reason === UsernameReservationReason.Blocked ? 'reserved' : 'cooldown_target',
      };
    }

    const taken = await this.members.findOne({
      where: { username },
      withDeleted: true,
      select: { id: true },
    });
    if (taken && taken.id !== member?.id) return { available: false, reason: 'taken' };

    return { available: true };
  }

  /**
   * Apply a handle change to a member IN MEMORY, and return the previous handle
   * so the caller can reserve it after the row is saved.
   *
   * Deliberately does not save: the caller owns the transaction, and the old
   * handle must not be reserved until the new one has actually landed —
   * otherwise a failed save leaves the member holding a handle that the
   * reservation table has already released.
   */
  async claimFor(member: Member, candidate: string | null): Promise<string | null> {
    // An explicit null clears the handle. The member drops back to their
    // short-id URL, and the released handle goes into cooldown like any rename.
    if (candidate === null) {
      const previous = member.username;
      if (previous === null) return null;
      member.username = null;
      member.usernameChangedAt = new Date();
      return previous;
    }

    const username = normalizeUsername(candidate);
    if (member.username === username) return null;

    const verdict = await this.check(username, member);
    if (!verdict.available) {
      throw new ConflictException(this.messageFor(verdict));
    }

    const previous = member.username;
    member.username = username;
    member.usernameChangedAt = new Date();
    return previous;
  }

  /** Hold a released handle for the cooldown window. No-op for null. */
  async holdAfterRelease(username: string | null, formerMemberId: string): Promise<void> {
    if (!username) return;
    await this.reservations.save(
      this.reservations.create({
        username,
        reason: UsernameReservationReason.Cooldown,
        formerMemberId,
        heldUntil: new Date(Date.now() + USERNAME_COOLDOWN_DAYS * DAY_MS),
      }),
    );
  }

  /**
   * Block a handle forever, because its holder deleted their account.
   *
   * Not a cooldown: a departed member is still addressed by that handle in
   * Discord history, in event embeds and in the audit ledger, and letting a
   * stranger pick it up later is the one squat with an identifiable victim.
   */
  async blockPermanently(username: string | null, formerMemberId: string): Promise<void> {
    if (!username) return;
    await this.reservations.save(
      this.reservations.create({
        username,
        reason: UsernameReservationReason.Blocked,
        formerMemberId,
        heldUntil: null,
      }),
    );
  }

  /**
   * Translate the ER_DUP_ENTRY the UNIQUE index raises when two callers claim
   * the same handle in the same instant. Anything else is rethrown untouched —
   * swallowing unknown database errors here would hide real faults behind a
   * "username taken" message.
   */
  isDuplicateHandleError(error: unknown): boolean {
    const code = (error as { code?: string; driverError?: { code?: string } })?.code;
    const driverCode = (error as { driverError?: { code?: string } })?.driverError?.code;
    return code === 'ER_DUP_ENTRY' || driverCode === 'ER_DUP_ENTRY';
  }

  /** When this member may next rename, or null when they may rename now. */
  renameCooldownFor(member: Member | null): Date | null {
    if (!member?.usernameChangedAt) return null;
    const next = new Date(member.usernameChangedAt.getTime() + USERNAME_COOLDOWN_DAYS * DAY_MS);
    return next > new Date() ? next : null;
  }

  /** A live reservation for the handle, or null when none applies. */
  private async activeReservation(username: string): Promise<UsernameReservation | null> {
    // Two shapes of live hold: permanent (`held_until IS NULL`) and a cooldown
    // that has not lapsed. A lapsed cooldown row is simply ignored — it is left
    // in place rather than deleted, so the history of a handle stays readable.
    const permanent = await this.reservations.findOne({
      where: { username, heldUntil: IsNull() },
    });
    if (permanent) return permanent;

    const active = await this.reservations.findOne({
      where: { username, heldUntil: Not(LessThanOrEqual(new Date())) },
    });
    return active ?? null;
  }

  private messageFor(verdict: UsernameAvailability): string {
    switch (verdict.reason) {
      case 'invalid':
        return 'A username must be 3-20 characters using lowercase letters, numbers or underscore';
      case 'reserved':
        return 'That username is not available';
      case 'taken':
        return 'That username is already taken';
      case 'cooldown_target':
        return 'That username was recently released and is not available yet';
      case 'cooldown_actor':
        return `You can change your username again after ${verdict.retryAfter}`;
      default:
        return 'That username is not available';
    }
  }
}
