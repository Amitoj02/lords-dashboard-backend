import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Medal } from '../medals/entities/medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { DiscordRoleAdoptionService } from './discord-role-adoption.service';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordGateway } from './gateway/discord-gateway';

type MockRepo<T extends object> = Partial<Record<keyof Repository<T>, jest.Mock>>;

/** The default ladder, precedence 1 = highest. Only some rungs carry a role link. */
const LADDER = [
  { id: 'rank-colonel', name: 'Colonel', precedence: 2, discordRoleId: 'role-colonel' },
  { id: 'rank-sergeant', name: 'Sergeant', precedence: 6, discordRoleId: 'role-sergeant' },
  { id: 'rank-private', name: 'Private', precedence: 9, discordRoleId: null },
  { id: 'rank-recruit', name: 'Recruit', precedence: 10, discordRoleId: 'role-recruit' },
  { id: 'rank-merc', name: 'Mercenary', precedence: 11, discordRoleId: 'role-merc' },
  { id: 'rank-applicant', name: 'Applicant', precedence: 12, discordRoleId: 'role-applicant' },
] as Rank[];

const MEDALS = [
  { id: 'medal-valour', title: 'Medal of Valour', discordRoleId: 'role-valour' },
  { id: 'medal-service', title: 'Long Service', discordRoleId: 'role-service' },
  { id: 'medal-unlinked', title: 'Unlinked Medal', discordRoleId: null },
] as Medal[];

/** The precedence of the rank an approval would otherwise enlist someone at. */
const ENTRY_PRECEDENCE = 10;

describe('DiscordRoleAdoptionService', () => {
  let service: DiscordRoleAdoptionService;
  let gateway: { fetchMember: jest.Mock };
  let ranks: MockRepo<Rank>;
  let medals: MockRepo<Medal>;
  let settings: MockRepo<DiscordBotSettings>;

  /** Say which role snowflakes the guild member currently wears. */
  const wearing = (...roles: string[]) =>
    gateway.fetchMember.mockResolvedValue({ id: '900900900900900901', roles, joinedAt: null });

  beforeEach(async () => {
    gateway = { fetchMember: jest.fn().mockResolvedValue(null) };
    ranks = { find: jest.fn().mockResolvedValue(LADDER) };
    medals = { find: jest.fn().mockResolvedValue(MEDALS) };
    settings = { findOne: jest.fn().mockResolvedValue({ botEnabled: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordRoleAdoptionService,
        { provide: DiscordGateway, useValue: gateway },
        { provide: getRepositoryToken(Rank), useValue: ranks },
        { provide: getRepositoryToken(Medal), useValue: medals },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settings },
      ],
    }).compile();

    service = module.get(DiscordRoleAdoptionService);
  });

  const resolve = (discordUserId: string | null = '900900900900900901') =>
    service.resolveFromGuild('regiment-1', discordUserId, ENTRY_PRECEDENCE);

  describe('what it carries over', () => {
    it('adopts the rank and every medal the member already wears', async () => {
      wearing('role-sergeant', 'role-valour', 'role-service', 'role-unrelated');

      const adopted = await resolve();

      expect(adopted.rank).toMatchObject({ id: 'rank-sergeant' });
      expect(adopted.medals.map((m) => m.id)).toEqual(['medal-valour', 'medal-service']);
    });

    it('adopts the HIGHEST rank when the member wears several rank roles', async () => {
      // A promoted member often keeps the roles of the rungs they climbed.
      wearing('role-sergeant', 'role-colonel');

      expect((await resolve()).rank).toMatchObject({ id: 'rank-colonel' });
    });

    it('carries over medals even when there is no rank to carry over', async () => {
      // The two halves are independent — a decorated recruit is a normal thing.
      wearing('role-valour');

      const adopted = await resolve();

      expect(adopted.rank).toBeNull();
      expect(adopted.medals.map((m) => m.id)).toEqual(['medal-valour']);
    });

    it('ignores guild roles nothing in the dashboard is linked to', async () => {
      // These are exactly the roles the reconcile also leaves alone.
      wearing('role-booster', 'role-colour-pink');

      expect(await resolve()).toEqual({ rank: null, medals: [] });
    });
  });

  describe('what it refuses to carry over', () => {
    it('never adopts a rank at or below the rank they would enlist at', async () => {
      // Recruit IS the floor; adopting it would be a no-op dressed up as a decision.
      wearing('role-recruit');

      expect((await resolve()).rank).toBeNull();
    });

    it('never adopts the Mercenary rank — the approved track decides that', async () => {
      // Even with the floor lifted so precedence alone would allow it.
      wearing('role-merc');

      expect((await service.resolveFromGuild('regiment-1', 'u1', 99)).rank).toBeNull();
    });

    it('never adopts the Applicant rank, which is the role the applicant is wearing', async () => {
      wearing('role-applicant');

      expect((await service.resolveFromGuild('regiment-1', 'u1', 99)).rank).toBeNull();
    });

    it('never adopts a rank whose role link is unset', async () => {
      // `Private` has no linked role; a member wearing nothing cannot claim it.
      wearing('role-valour');

      expect((await resolve()).rank).toBeNull();
    });
  });

  describe('when it cannot know', () => {
    it('carries nothing over for an applicant with no linked Discord account', async () => {
      expect(await resolve(null)).toEqual({ rank: null, medals: [] });
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('carries nothing over while the bot is switched off', async () => {
      // With the bot off nothing reconciles either, so there is no strip to pre-empt.
      settings.findOne!.mockResolvedValue({ botEnabled: false });
      wearing('role-colonel', 'role-valour');

      expect(await resolve()).toEqual({ rank: null, medals: [] });
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('carries nothing over when the member is not in the guild', async () => {
      gateway.fetchMember.mockResolvedValue(null);

      expect(await resolve()).toEqual({ rank: null, medals: [] });
    });

    it('swallows a gateway failure rather than costing the regiment an approval', async () => {
      gateway.fetchMember.mockRejectedValue(new Error('Discord API 503'));

      expect(await resolve()).toEqual({ rank: null, medals: [] });
    });
  });
});
