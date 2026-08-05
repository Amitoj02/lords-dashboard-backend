import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Member } from './entities/member.entity';
import {
  UsernameReservation,
  UsernameReservationReason,
} from './entities/username-reservation.entity';
import { UsernameService } from './username.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'aB3x9KqLm2Zt',
    username: null,
    usernameChangedAt: null,
    ...overrides,
  } as unknown as Member;
}

describe('UsernameService', () => {
  let service: UsernameService;
  const members = { findOne: jest.fn() };
  const reservations = { findOne: jest.fn(), save: jest.fn(), create: jest.fn((row) => row) };

  beforeEach(async () => {
    jest.clearAllMocks();
    members.findOne.mockResolvedValue(null);
    reservations.findOne.mockResolvedValue(null);
    reservations.save.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsernameService,
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: getRepositoryToken(UsernameReservation), useValue: reservations },
      ],
    }).compile();
    service = module.get(UsernameService);
  });

  describe('check', () => {
    it('accepts a free, well-formed handle', async () => {
      await expect(service.check('panda', member())).resolves.toEqual({ available: true });
    });

    it('rejects a malformed handle as data, not as a thrown error', async () => {
      // This backs a keystroke-driven probe — a 400 mid-typing would give the
      // form nothing to render.
      await expect(service.check('no', member())).resolves.toEqual({
        available: false,
        reason: 'invalid',
      });
    });

    it('rejects a reserved handle', async () => {
      await expect(service.check('moderator', member())).resolves.toEqual({
        available: false,
        reason: 'reserved',
      });
    });

    it('rejects a handle another member already holds', async () => {
      members.findOne.mockResolvedValue({ id: 'someoneElse' });

      await expect(service.check('panda', member())).resolves.toEqual({
        available: false,
        reason: 'taken',
      });
    });

    it('treats re-claiming your OWN handle as a no-op, not a conflict', async () => {
      const holder = member({ username: 'panda' });

      await expect(service.check('Panda', holder)).resolves.toEqual({ available: true });
      // Short-circuits before touching the repositories at all.
      expect(members.findOne).not.toHaveBeenCalled();
    });

    it('distinguishes a permanently blocked handle from one still cooling down', async () => {
      reservations.findOne.mockResolvedValueOnce({
        username: 'panda',
        reason: UsernameReservationReason.Blocked,
        heldUntil: null,
      });
      await expect(service.check('panda', member())).resolves.toEqual({
        available: false,
        reason: 'reserved',
      });

      reservations.findOne.mockReset();
      reservations.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        username: 'panda',
        reason: UsernameReservationReason.Cooldown,
        heldUntil: new Date(Date.now() + 10 * DAY_MS),
      });
      await expect(service.check('panda', member())).resolves.toEqual({
        available: false,
        reason: 'cooldown_target',
      });
    });

    it('refuses a rename inside the 30-day cooldown and says when it lifts', async () => {
      const renamedYesterday = member({
        username: 'oldname',
        usernameChangedAt: new Date(Date.now() - DAY_MS),
      });

      const verdict = await service.check('panda', renamedYesterday);

      expect(verdict.available).toBe(false);
      expect(verdict.reason).toBe('cooldown_actor');
      expect(new Date(verdict.retryAfter!).getTime()).toBeGreaterThan(Date.now());
    });

    it('allows a rename once the cooldown has lapsed', async () => {
      const renamedLongAgo = member({
        username: 'oldname',
        usernameChangedAt: new Date(Date.now() - 31 * DAY_MS),
      });

      await expect(service.check('panda', renamedLongAgo)).resolves.toEqual({ available: true });
    });
  });

  describe('claimFor', () => {
    it('applies the handle in memory and returns the released one', async () => {
      const holder = member({
        username: 'oldname',
        usernameChangedAt: new Date(Date.now() - 60 * DAY_MS),
      });

      const released = await service.claimFor(holder, 'Panda');

      expect(holder.username).toBe('panda');
      expect(holder.usernameChangedAt).toBeInstanceOf(Date);
      expect(released).toBe('oldname');
      // It deliberately does NOT save, and does NOT reserve: the caller owns the
      // transaction, and the old handle must not be released until the new one
      // has actually landed.
      expect(reservations.save).not.toHaveBeenCalled();
    });

    it('clears the handle when given an explicit null', async () => {
      const holder = member({ username: 'panda' });

      const released = await service.claimFor(holder, null);

      expect(holder.username).toBeNull();
      expect(released).toBe('panda');
    });

    it('is a no-op when the member already holds that handle', async () => {
      const holder = member({ username: 'panda' });

      await expect(service.claimFor(holder, 'panda')).resolves.toBeNull();
      expect(holder.usernameChangedAt).toBeNull();
    });

    it('throws a 409 for an unavailable handle', async () => {
      members.findOne.mockResolvedValue({ id: 'someoneElse' });

      await expect(service.claimFor(member(), 'panda')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reservations', () => {
    it('holds a released handle for 30 days', async () => {
      await service.holdAfterRelease('oldname', 'aB3x9KqLm2Zt');

      const row = reservations.save.mock.calls[0][0] as UsernameReservation;
      expect(row.username).toBe('oldname');
      expect(row.reason).toBe(UsernameReservationReason.Cooldown);
      expect(row.heldUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    });

    it('blocks a deleted member’s handle FOREVER, not for a cooldown', async () => {
      // A departed member is still addressed by that handle in Discord history
      // and the audit ledger — this is the one squat with an identifiable victim.
      await service.blockPermanently('panda', 'aB3x9KqLm2Zt');

      const row = reservations.save.mock.calls[0][0] as UsernameReservation;
      expect(row.reason).toBe(UsernameReservationReason.Blocked);
      expect(row.heldUntil).toBeNull();
    });

    it('no-ops for a member who never claimed a handle', async () => {
      await service.holdAfterRelease(null, 'aB3x9KqLm2Zt');
      await service.blockPermanently(null, 'aB3x9KqLm2Zt');

      expect(reservations.save).not.toHaveBeenCalled();
    });
  });

  describe('isDuplicateHandleError', () => {
    it('recognises ER_DUP_ENTRY at either level the driver reports it', () => {
      expect(service.isDuplicateHandleError({ code: 'ER_DUP_ENTRY' })).toBe(true);
      expect(service.isDuplicateHandleError({ driverError: { code: 'ER_DUP_ENTRY' } })).toBe(true);
    });

    it('does NOT swallow an unrelated database error', () => {
      // Reporting "username taken" for a connection failure would hide a real
      // fault behind a message the member would spend minutes trying to satisfy.
      expect(service.isDuplicateHandleError({ code: 'ER_LOCK_DEADLOCK' })).toBe(false);
      expect(service.isDuplicateHandleError(new Error('boom'))).toBe(false);
    });
  });
});
