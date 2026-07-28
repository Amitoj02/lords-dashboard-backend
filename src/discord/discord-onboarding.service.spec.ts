import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordGateway } from './gateway/discord-gateway';

const REGIMENT = 'regiment-1';
const SNOWFLAKE = '900900900900900901';

/**
 * T-0191/T-0193 — what happens when someone walks into the guild.
 *
 * Two rules are being defended, and they pull in opposite directions:
 *  - a STRANGER gets nothing. The retired join-role grant handed the regiment's
 *    role to every account that appeared, which is exactly why that role could
 *    not be used as a permission anchor.
 *  - a RETURNING MEMBER gets everything back. Leaving a guild strips every role
 *    Discord holds for you and rejoining restores none of them, so a veteran
 *    reappeared with the rank and medals the dashboard still credited them with
 *    and no role to show for any of it.
 */
describe('DiscordOnboardingService', () => {
  let service: DiscordOnboardingService;

  const gateway = { registerMemberJoinHandler: jest.fn() };
  const sync = {
    enqueueWelcome: jest.fn().mockResolvedValue(null),
    enqueueRoleGrant: jest.fn().mockResolvedValue(null),
    enqueueMemberBanRole: jest.fn().mockResolvedValue(null),
  };
  const regiments = { find: jest.fn() };
  const members = { findOne: jest.fn() };

  const rosterMember = (overrides: Record<string, unknown> = {}) => ({
    id: 'member-1',
    regimentId: REGIMENT,
    bannedAt: null,
    suspendedUntil: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    regiments.find.mockResolvedValue([{ id: REGIMENT }]);
    members.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordOnboardingService,
        { provide: DiscordGateway, useValue: gateway },
        { provide: DiscordSyncService, useValue: sync },
        { provide: getRepositoryToken(Regiment), useValue: regiments },
        { provide: getRepositoryToken(Member), useValue: members },
      ],
    }).compile();

    service = module.get(DiscordOnboardingService);
  });

  it('welcomes everyone who joins', async () => {
    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueWelcome).toHaveBeenCalledWith(REGIMENT, SNOWFLAKE);
  });

  it('gives a STRANGER no roles at all', async () => {
    // The whole point of retiring the join role. Someone who has never applied
    // must not leave this handler holding anything.
    members.findOne.mockResolvedValue(null);

    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueRoleGrant).not.toHaveBeenCalled();
    expect(sync.enqueueMemberBanRole).not.toHaveBeenCalled();
  });

  it('restores a returning member’s roles from roster state', async () => {
    members.findOne.mockResolvedValue(rosterMember());

    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueRoleGrant).toHaveBeenCalledWith(REGIMENT, 'member-1', SNOWFLAKE);
  });

  it('gives a BANNED member the Ban role, never their rank and medals back', async () => {
    // Checked BEFORE the reconcile because a banned member is still a roster
    // row — a reconcile would hand their whole managed role set straight back.
    members.findOne.mockResolvedValue(rosterMember({ bannedAt: new Date() }));

    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueMemberBanRole).toHaveBeenCalledWith(REGIMENT, SNOWFLAKE, expect.any(String));
    expect(sync.enqueueRoleGrant).not.toHaveBeenCalled();
  });

  it('restores NOTHING to an actively suspended member', async () => {
    // Handing the roles back at the door would quietly end the suspension early.
    members.findOne.mockResolvedValue(
      rosterMember({ suspendedUntil: new Date(Date.now() + 60_000) }),
    );

    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueRoleGrant).not.toHaveBeenCalled();
    expect(sync.enqueueMemberBanRole).not.toHaveBeenCalled();
  });

  it('restores roles once a suspension has EXPIRED', async () => {
    members.findOne.mockResolvedValue(
      rosterMember({ suspendedUntil: new Date(Date.now() - 60_000) }),
    );

    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueRoleGrant).toHaveBeenCalledWith(REGIMENT, 'member-1', SNOWFLAKE);
  });

  it('suppresses a repeat join inside the dedupe window', async () => {
    members.findOne.mockResolvedValue(rosterMember());

    await service.onMemberJoin(SNOWFLAKE);
    await service.onMemberJoin(SNOWFLAKE);

    expect(sync.enqueueWelcome).toHaveBeenCalledTimes(1);
    expect(sync.enqueueRoleGrant).toHaveBeenCalledTimes(1);
  });

  it('never throws — a failing lookup must not reject into the gateway emitter', async () => {
    members.findOne.mockRejectedValue(new Error('db down'));

    await expect(service.onMemberJoin(SNOWFLAKE)).resolves.toBeUndefined();
  });
});
