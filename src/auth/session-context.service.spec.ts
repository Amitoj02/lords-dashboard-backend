import { Repository } from 'typeorm';
import { MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { SessionContextService } from './session-context.service';

describe('SessionContextService', () => {
  let service: SessionContextService;
  const identities = { findOne: jest.fn(), update: jest.fn() };
  const members = { findOne: jest.fn(), update: jest.fn() };
  const regiments = { findOne: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    // The last_seen_at bump issues a targeted members.update — default it to a
    // resolved no-op so the fire-and-forget write never rejects unexpectedly.
    members.update.mockReset().mockResolvedValue(undefined);
    service = new SessionContextService(
      identities as unknown as Repository<DiscordIdentity>,
      members as unknown as Repository<Member>,
      regiments as unknown as Repository<Regiment>,
    );
  });

  it('resolves a member context fresh from the DB (role/regiment/member live)', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({ id: 'm-1', role: MemberRole.Owner, regimentId: 'r-1' });

    const ctx = await service.resolve('id-1');

    expect(ctx).toEqual({
      identityId: 'id-1',
      discordUserId: 'd-1',
      memberId: 'm-1',
      role: MemberRole.Owner,
      regimentId: 'r-1',
      sessionsValidFromSec: 0,
    });
  });

  it('resolves an identity-only session as Applicant against the default regiment', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue(null);
    regiments.findOne.mockResolvedValue({ id: 'default-r' });

    const ctx = await service.resolve('id-1');

    expect(ctx).toMatchObject({
      memberId: null,
      role: MemberRole.Applicant,
      regimentId: 'default-r',
    });
  });

  it('returns null when the identity no longer exists (token should be rejected)', async () => {
    identities.findOne.mockResolvedValue(null);
    expect(await service.resolve('gone')).toBeNull();
  });

  it('DENIES a banned member so a ban cannot be defeated by re-authenticating', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({
      id: 'm-1',
      role: MemberRole.Member,
      regimentId: 'r-1',
      bannedAt: new Date(),
    });
    expect(await service.resolve('id-1')).toBeNull();
  });

  it('DENIES a member under an active suspension', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({
      id: 'm-1',
      role: MemberRole.Member,
      regimentId: 'r-1',
      suspendedUntil: new Date(Date.now() + 60_000),
    });
    expect(await service.resolve('id-1')).toBeNull();
  });

  it('ALLOWS a member whose suspension has already lapsed', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({
      id: 'm-1',
      role: MemberRole.Member,
      regimentId: 'r-1',
      bannedAt: null,
      suspendedUntil: new Date(Date.now() - 60_000),
    });
    const ctx = await service.resolve('id-1');
    expect(ctx?.memberId).toBe('m-1');
  });

  it('caches the resolved context (no second DB read within TTL)', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({ id: 'm-1', role: MemberRole.Member, regimentId: 'r-1' });

    await service.resolve('id-1');
    await service.resolve('id-1');

    expect(identities.findOne).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a fresh read on the next resolve', async () => {
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: null,
    });
    members.findOne.mockResolvedValue({ id: 'm-1', role: MemberRole.Member, regimentId: 'r-1' });

    await service.resolve('id-1');
    service.invalidate('id-1');
    await service.resolve('id-1');

    expect(identities.findOne).toHaveBeenCalledTimes(2);
  });

  it('computes sessionsValidFromSec (whole seconds) from the identity cutoff', async () => {
    const cutoff = new Date('2026-01-01T00:00:00.000Z');
    identities.findOne.mockResolvedValue({
      id: 'id-1',
      discordUserId: 'd-1',
      sessionsValidFrom: cutoff,
    });
    members.findOne.mockResolvedValue({ id: 'm-1', role: MemberRole.Member, regimentId: 'r-1' });

    const ctx = await service.resolve('id-1');

    expect(ctx?.sessionsValidFromSec).toBe(Math.floor(cutoff.getTime() / 1000));
  });

  it('invalidateSessions() bumps the identity cutoff and drops the cache', async () => {
    identities.update.mockResolvedValue(undefined);
    await service.invalidateSessions('id-1');
    expect(identities.update).toHaveBeenCalledWith(
      { id: 'id-1' },
      expect.objectContaining({ sessionsValidFrom: expect.any(Date) }),
    );
  });

  it('invalidateSessions() no-ops for a null identity id', async () => {
    await service.invalidateSessions(null);
    expect(identities.update).not.toHaveBeenCalled();
  });

  // ── last_seen_at bump on authenticated request (T-0108 / T-0109) ────────────
  describe('last_seen_at bump', () => {
    const memberIdentity = { id: 'id-1', discordUserId: 'd-1', sessionsValidFrom: null };
    const member = { id: 'm-1', role: MemberRole.Member, regimentId: 'r-1' };

    afterEach(() => {
      jest.useRealTimers();
    });

    it('advances last_seen_at (targeted column update) on the first authenticated request', async () => {
      identities.findOne.mockResolvedValue(memberIdentity);
      members.findOne.mockResolvedValue(member);

      await service.resolve('id-1');

      expect(members.update).toHaveBeenCalledTimes(1);
      expect(members.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      );
    });

    it('does NOT write again on a second request inside the throttle window', async () => {
      jest.useFakeTimers();
      identities.findOne.mockResolvedValue(memberIdentity);
      members.findOne.mockResolvedValue(member);

      await service.resolve('id-1');
      // A cache hit a second later still routes through the throttle → no write.
      jest.advanceTimersByTime(1_000);
      await service.resolve('id-1');

      expect(members.update).toHaveBeenCalledTimes(1);
    });

    it('writes a fresh last_seen_at after the throttle window elapses', async () => {
      jest.useFakeTimers();
      identities.findOne.mockResolvedValue(memberIdentity);
      members.findOne.mockResolvedValue(member);

      await service.resolve('id-1');
      jest.advanceTimersByTime(5 * 60_000 + 1);
      await service.resolve('id-1');

      expect(members.update).toHaveBeenCalledTimes(2);
    });

    it('does not attempt a write for an identity-only / Applicant session', async () => {
      identities.findOne.mockResolvedValue(memberIdentity);
      members.findOne.mockResolvedValue(null);
      regiments.findOne.mockResolvedValue({ id: 'default-r' });

      const ctx = await service.resolve('id-1');

      expect(ctx?.memberId).toBeNull();
      expect(members.update).not.toHaveBeenCalled();
    });

    it('tolerates a DB error on the bump — the request still resolves', async () => {
      identities.findOne.mockResolvedValue(memberIdentity);
      members.findOne.mockResolvedValue(member);
      members.update.mockRejectedValue(new Error('db down'));

      const ctx = await service.resolve('id-1');
      // Let the fire-and-forget rejection settle through its .catch handler.
      await Promise.resolve();

      expect(ctx?.memberId).toBe('m-1');
      expect(members.update).toHaveBeenCalledTimes(1);
    });
  });
});
