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

  /**
   * T-0204 — the same read, asked to SAY WHY it came back empty. The enlistment
   * path is right to shrug a failure off; an admin pressing "Derive data from
   * Discord" needs to know whether they are looking at a member with no roles or
   * at an integration that is not working.
   */
  describe('readGuildState (the reasons)', () => {
    const read = (discordUserId: string | null = '900900900900900901', floor = ENTRY_PRECEDENCE) =>
      service.readGuildState('regiment-1', discordUserId, floor);

    it('reports a member with no linked Discord account', async () => {
      expect(await read(null)).toEqual({ ok: false, reason: 'not-linked' });
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('reports a switched-off bot instead of an empty hand', async () => {
      settings.findOne!.mockResolvedValue({ botEnabled: false });

      expect(await read()).toEqual({ ok: false, reason: 'bot-disabled' });
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('reports a member the gateway cannot see in the guild', async () => {
      gateway.fetchMember.mockResolvedValue(null);

      expect(await read()).toEqual({ ok: false, reason: 'not-in-guild' });
    });

    it('reports an unreachable gateway rather than a member who earned nothing', async () => {
      gateway.fetchMember.mockRejectedValue(new Error('Discord API 503'));

      expect(await read()).toEqual({ ok: false, reason: 'unreachable' });
    });

    /**
     * The one case that is a SUCCESS with nothing in it. "In the guild wearing no
     * roles" is a real, complete answer — and it is answered without touching the
     * rank or medal catalogues, because nothing they contain could change it.
     */
    it('reports a role-less guild member as a successful read of nothing', async () => {
      wearing();

      expect(await read()).toEqual({ ok: true, state: { rank: null, medals: [] } });
      expect(ranks.find).not.toHaveBeenCalled();
      expect(medals.find).not.toHaveBeenCalled();
    });

    it('hands back the same state the lenient wrapper flattens', async () => {
      wearing('role-sergeant', 'role-valour');

      const strict = await read();
      expect(strict.ok).toBe(true);
      expect(strict.ok && strict.state.rank).toMatchObject({ id: 'rank-sergeant' });
      expect(strict.ok && strict.state.medals.map((m) => m.id)).toEqual(['medal-valour']);
    });

    /**
     * The floor is the caller's to choose, and for an existing member it is the
     * rank they hold — which is what makes a derive promotion-only. Infinity is
     * the "no rank at all" case: everything qualifies.
     */
    it('treats the floor as strict, and Infinity as no floor at all', async () => {
      wearing('role-sergeant');

      // Sergeant (6) is not STRICTLY above a floor of 6 — the rank a member
      // already holds is never re-adopted as if it were news.
      expect(await read('900900900900900901', 6)).toMatchObject({ state: { rank: null } });
      // One rung below it, the same role is a promotion.
      expect(await read('900900900900900901', 7)).toMatchObject({
        state: { rank: { id: 'rank-sergeant' } },
      });
      // And with no floor at all (a member holding no rank), so is anything.
      expect(await read('900900900900900901', Number.POSITIVE_INFINITY)).toMatchObject({
        state: { rank: { id: 'rank-sergeant' } },
      });
    });
  });
});
