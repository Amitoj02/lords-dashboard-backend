import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventStatus, MemberRole, MemberStatus, RegimentDocumentSlug } from '../common/enums';
import { RegimentEvent } from '../events/entities/event.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentDocument } from './entities/regiment-document.entity';
import { RegimentSettings } from './entities/regiment-settings.entity';
import { Regiment } from './entities/regiment.entity';
import { RegimentsService } from './regiments.service';

const REGIMENT_ID = 'regiment-1';

const buildRegiment = (overrides: Partial<Regiment> = {}): Regiment =>
  ({
    id: REGIMENT_ID,
    name: 'Lords Regiment',
    missionStatement: 'Discipline, honour, and the line.',
    accentTone: 'brass',
    crestUrl: 'https://cdn/crest.png',
    bannerUrl: null,
    establishedYear: 2021,
    establishedAt: '2021-01-01',
    discordInviteUrl: 'https://discord.gg/lords',
    discordServerId: '999888777',
    discordServerName: 'Lords HQ',
    setupComplete: true,
    ownerMemberId: 'owner-1',
    createdAt: new Date('2021-01-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as Regiment;

describe('RegimentsService', () => {
  let service: RegimentsService;

  const regimentRepo = { find: jest.fn() };
  const settingsRepo = { findOne: jest.fn() };

  // Member repository: count + grouped role QueryBuilder.
  let memberQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  const memberRepo = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const eventRepo = { count: jest.fn() };
  const documentRepo = { find: jest.fn().mockResolvedValue([]) };

  beforeEach(async () => {
    jest.clearAllMocks();

    memberQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    memberRepo.createQueryBuilder.mockReturnValue(memberQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegimentsService,
        { provide: getRepositoryToken(Regiment), useValue: regimentRepo },
        { provide: getRepositoryToken(RegimentSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: getRepositoryToken(RegimentEvent), useValue: eventRepo },
        { provide: getRepositoryToken(RegimentDocument), useValue: documentRepo },
      ],
    }).compile();

    service = module.get(RegimentsService);
  });

  describe('getProfile', () => {
    it('resolves the single regiment and returns the public profile with memberCount', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(42);

      const dto = await service.getProfile();

      // Oldest non-dissolved regiment resolution.
      expect(regimentRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' }, take: 1 });
      // Member count scoped to the regiment.
      expect(memberRepo.count).toHaveBeenCalledWith({ where: { regimentId: REGIMENT_ID } });

      expect(dto.id).toBe(REGIMENT_ID);
      expect(dto.name).toBe('Lords Regiment');
      expect(dto.establishedAt).toBe('2021-01-01');
      expect(dto.memberCount).toBe(42);
      // shortTag was dropped from the identity — never projected.
      expect(dto).not.toHaveProperty('shortTag');
      // Sensitive/internal fields are never projected.
      expect(dto).not.toHaveProperty('discordServerId');
      expect(dto).not.toHaveProperty('ownerMemberId');
    });

    it('throws NotFound when no regiment exists', async () => {
      regimentRepo.find.mockResolvedValue([]);
      await expect(service.getProfile()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('surfaces the mercenary-track toggle to the public apply form (T-0137)', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(1);

      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT_ID, allowMercenaries: true });
      expect((await service.getProfile()).allowMercenaries).toBe(true);

      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT_ID, allowMercenaries: false });
      expect((await service.getProfile()).allowMercenaries).toBe(false);

      expect(settingsRepo.findOne).toHaveBeenCalledWith({ where: { regimentId: REGIMENT_ID } });
    });

    it('defaults allowMercenaries to true when there is no settings row (T-0137)', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(1);
      settingsRepo.findOne.mockResolvedValue(null);

      // Permissive default, matching the allow_mercenaries column default and the
      // service-layer guard in ApplicationsService (T-0133).
      expect((await service.getProfile()).allowMercenaries).toBe(true);
    });

    it('pins the permissive-on-absent-column contract: a settings row without allowMercenaries reports true (T-0137)', async () => {
      // Shape guard. The production expression is deliberately `allowMercenaries !== false`,
      // not `!!allowMercenaries`: the two only disagree when the column is *absent*
      // (undefined) on the loaded row, which happens for real the moment any query
      // narrows its select. Under a truthiness check the public apply form would stop
      // offering the mercenary track even though the service layer still accepts it.
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(1);
      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT_ID, publicStats: true });

      expect((await service.getProfile()).allowMercenaries).toBe(true);
    });

    // T-0147. The landing AND sign-in pages are both anonymous, so the
    // presentation slice has to ride on this endpoint — there is no
    // authenticated call a logged-out visitor could make instead.
    it('carries the presentation slice on the ANONYMOUS profile (T-0147)', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(1);
      settingsRepo.findOne.mockResolvedValue({
        regimentId: REGIMENT_ID,
        allowMercenaries: true,
        heroBannerUrl: 'https://cdn/hero.jpg',
        charterQuote: 'Hold the line.',
        charterQuoteAttribution: 'The Charter',
        heroOverlayDensity: 0,
      });

      const dto = await service.getProfile();

      expect(dto.presentation.heroBannerUrl).toBe('https://cdn/hero.jpg');
      expect(dto.presentation.charterQuote).toBe('Hold the line.');
      expect(dto.presentation.charterQuoteAttribution).toBe('The Charter');
      // 0 is a MEANINGFUL density (fully transparent scrim), not "unset". A
      // `??`/truthiness projection would silently turn it into null and the
      // client would re-apply the stylesheet default instead.
      expect(dto.presentation.heroOverlayDensity).toBe(0);
    });

    it('projects presentation as all-null when there is no settings row', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      memberRepo.count.mockResolvedValue(1);
      settingsRepo.findOne.mockResolvedValue(null);

      // Null means "unset — render the shipped copy". A regiment mid-first-run
      // must still serve a complete landing page, never a 500.
      const { presentation } = await service.getProfile();
      expect(presentation.heroBannerUrl).toBeNull();
      expect(presentation.loginQuote).toBeNull();
      expect(presentation.loginOverlayDensity).toBeNull();
    });
  });

  describe('getDocuments', () => {
    // T-0149. These back /terms, /privacy and /guidelines — pages a visitor
    // reaches before signing in, and the privacy policy is a Discord Developer
    // ToS obligation, so this endpoint must never be the reason one is blank.
    it('returns one entry per slug even when nothing has been written', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      documentRepo.find.mockResolvedValue([]);

      const docs = await service.getDocuments();

      expect(docs.map((doc) => doc.slug)).toEqual(['terms', 'privacy', 'guidelines']);
      expect(docs.every((doc) => doc.body === null)).toBe(true);
    });

    it('returns the stored body for an edited document', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      documentRepo.find.mockResolvedValue([
        {
          regimentId: REGIMENT_ID,
          slug: 'privacy',
          body: '# Privacy',
          updatedAt: new Date('2026-07-22T00:00:00.000Z'),
        },
      ]);

      const privacy = (await service.getDocuments()).find(
        (doc) => doc.slug === RegimentDocumentSlug.Privacy,
      );
      expect(privacy?.body).toBe('# Privacy');
      expect(privacy?.updatedAt).toBe('2026-07-22T00:00:00.000Z');
    });

    it('treats a whitespace-only body as unset so the client falls back', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      documentRepo.find.mockResolvedValue([
        { regimentId: REGIMENT_ID, slug: 'terms', body: '   \n  ', updatedAt: new Date() },
      ]);

      // An admin who clears the editor must restore the shipped copy, not
      // publish an empty legal page.
      const terms = (await service.getDocuments()).find(
        (doc) => doc.slug === RegimentDocumentSlug.Terms,
      );
      expect(terms?.body).toBeNull();
    });

    it('does NOT leak the author on the anonymous projection', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      documentRepo.find.mockResolvedValue([
        { regimentId: REGIMENT_ID, slug: 'terms', body: 'x', updatedAt: new Date() },
      ]);

      const [terms] = await service.getDocuments();
      expect(terms).not.toHaveProperty('updatedByName');
      expect(terms).not.toHaveProperty('updatedByMemberId');
    });
  });

  describe('getStats', () => {
    it('throws Forbidden when publicStats is disabled', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT_ID, publicStats: false });

      await expect(service.getStats()).rejects.toBeInstanceOf(ForbiddenException);
      // Short-circuits before doing any aggregation.
      expect(memberRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(eventRepo.count).not.toHaveBeenCalled();
    });

    it('aggregates member/event counters when stats are public', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT_ID, publicStats: true });

      memberQb.getRawMany.mockResolvedValue([
        { role: MemberRole.Owner, count: '1' },
        { role: MemberRole.Admin, count: '2' },
        { role: MemberRole.Member, count: '20' },
        { role: MemberRole.Mercenary, count: '3' },
        { role: MemberRole.Applicant, count: '4' },
      ]);
      // activeMembers count.
      memberRepo.count.mockResolvedValue(18);
      // Event counts keyed by the requested status (order-independent).
      eventRepo.count.mockImplementation(({ where }: { where: { status?: EventStatus } }) => {
        if (where.status === EventStatus.Upcoming) return Promise.resolve(3);
        if (where.status === EventStatus.Previous) return Promise.resolve(5);
        return Promise.resolve(12); // totalEvents (no status filter)
      });

      const stats = await service.getStats();

      // totalMembers excludes Applicants (1 + 2 + 20 + 3 = 26).
      expect(stats.totalMembers).toBe(26);
      // enrolledExcludingMercenaries drops Mercenaries too (1 + 2 + 20 = 23).
      expect(stats.enrolledExcludingMercenaries).toBe(23);
      expect(stats.activeMembers).toBe(18);
      // Full per-role breakdown with every role key present.
      expect(stats.membersByRole).toEqual({
        [MemberRole.Owner]: 1,
        [MemberRole.Admin]: 2,
        [MemberRole.Moderator]: 0,
        [MemberRole.Member]: 20,
        [MemberRole.Mercenary]: 3,
        [MemberRole.Applicant]: 4,
      });
      expect(stats.totalEvents).toBe(12);
      expect(stats.upcomingEvents).toBe(3);
      expect(stats.previousEvents).toBe(5);
      expect(stats.establishedYear).toBe(2021);
      expect(stats.establishedAt).toBe('2021-01-01');

      // activeMembers filtered by Active status.
      expect(memberRepo.count).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT_ID, status: MemberStatus.Active },
      });
      // upcomingEvents excludes archived.
      expect(eventRepo.count).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT_ID, status: EventStatus.Upcoming, isArchived: false },
      });
    });

    it('treats a regiment with no settings row as public', async () => {
      regimentRepo.find.mockResolvedValue([buildRegiment()]);
      settingsRepo.findOne.mockResolvedValue(null);
      memberRepo.count.mockResolvedValue(0);
      eventRepo.count.mockResolvedValue(0);

      const stats = await service.getStats();
      expect(stats.totalMembers).toBe(0);
      expect(stats.enrolledExcludingMercenaries).toBe(0);
      expect(stats.establishedYear).toBe(2021);
      expect(stats.establishedAt).toBe('2021-01-01');
    });
  });
});
