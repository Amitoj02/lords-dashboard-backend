import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { ApplicantType, ApplicationStatus, MemberRole, MemberStatus } from '../common/enums';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { Member } from '../members/entities/member.entity';
import { ServiceRecordEntry } from '../members/entities/service-record-entry.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { Application } from './entities/application.entity';

type MockRepo<T extends object> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const STAFF: AuthenticatedUser = {
  identityId: 'identity-1',
  memberId: 'member-staff',
  discordUserId: 'discord-1',
  role: MemberRole.Admin,
  regimentId: 'regiment-1',
};

const APPLICANT: AuthenticatedUser = {
  identityId: 'identity-applicant',
  memberId: null,
  discordUserId: 'discord-2',
  role: MemberRole.Applicant,
  regimentId: 'regiment-1',
};

const validCreateDto = (): CreateApplicationDto => ({
  applicantName: 'Jane Doe',
  inGameName: 'JaneTheGreat',
  discordTag: '@janedoe',
  currentRegiment: 'None',
  howFound: 'A friend in the Discord invited me.',
  preferredClasses: 'Line Infantry, Rifleman',
  skillsToImprove: 'Melee duelling.',
  interestConfirmed: true,
  representativeNote: undefined,
});

const baseApplication = (overrides: Partial<Application> = {}): Application => ({
  id: 'app-1',
  regimentId: 'regiment-1',
  discordIdentityId: 'identity-applicant',
  promotedMemberId: null,
  decidedByMemberId: null,
  applicantName: 'Jane Doe',
  discordTag: '@janedoe',
  inGameName: 'JaneTheGreat',
  applicantType: ApplicantType.Member,
  currentRegiment: 'None',
  howFound: 'A friend in the Discord invited me.',
  preferredClasses: 'Line Infantry, Rifleman',
  skillsToImprove: 'Melee duelling.',
  interestConfirmed: true,
  representativeNote: null,
  status: ApplicationStatus.Pending,
  isReapplication: false,
  discordInServer: false,
  mutualEventsCount: 0,
  moderatorNote: null,
  discordDmMessage: null,
  declineReason: null,
  isDraft: false,
  submittedAt: new Date('2026-06-22T18:00:00.000Z'),
  decidedAt: null,
  createdAt: new Date('2026-06-22T18:00:00.000Z'),
  updatedAt: new Date('2026-06-22T18:00:00.000Z'),
  ...overrides,
});

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let applications: MockRepo<Application>;
  let settings: MockRepo<RegimentSettings>;
  let identities: MockRepo<DiscordIdentity>;
  let members: MockRepo<Member>;
  let audit: { record: jest.Mock };
  let sessionContext: { invalidate: jest.Mock };
  let discordSync: {
    enqueueApplicationSubmitted: jest.Mock;
    enqueueApplicationDecision: jest.Mock;
  };

  // Per-test transaction manager repositories.
  let txRanks: MockRepo<Rank>;
  let txMembers: MockRepo<Member>;
  let txApplications: MockRepo<Application>;
  let txServiceRecords: MockRepo<ServiceRecordEntry>;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    applications = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x: unknown) => x),
      // Mirror TypeORM stamping the managed @CreateDateColumn/@UpdateDateColumn on
      // a freshly-saved entity (a brand-new application has no createdAt until then).
      // Spread last so an existing fixture date (decline/hold) is preserved.
      save: jest.fn((x: Partial<Application>) =>
        Promise.resolve({
          createdAt: new Date('2026-06-22T18:00:00.000Z'),
          updatedAt: new Date('2026-06-22T18:00:00.000Z'),
          ...x,
        }),
      ),
      createQueryBuilder: jest.fn(),
    };
    settings = { findOne: jest.fn() };
    // Default: the applicant identity exists and is NOT blocked from applying.
    identities = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'identity-applicant', applicationsBlockedAt: null }),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    // The deciding staffer's own roster row, resolved on every decision so the
    // decidedByMember relation is written in step with the FK (T-0155).
    members = {
      findOne: jest.fn().mockResolvedValue({
        id: 'member-staff',
        inGameName: 'Sergeant Steel',
        avatarUrl: 'https://cdn/staff.png',
      }),
    };
    audit = { record: jest.fn() };
    sessionContext = { invalidate: jest.fn() };
    discordSync = {
      enqueueApplicationSubmitted: jest.fn().mockResolvedValue(null),
      enqueueApplicationDecision: jest.fn().mockResolvedValue(null),
    };

    txRanks = { findOneOrFail: jest.fn() };
    txMembers = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: Member) => Promise.resolve({ ...x, id: 'member-new' })),
    };
    txApplications = { save: jest.fn((x: unknown) => Promise.resolve(x)) };
    txServiceRecords = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Rank) return txRanks;
        if (entity === Member) return txMembers;
        if (entity === Application) return txApplications;
        if (entity === ServiceRecordEntry) return txServiceRecords;
        throw new Error('unexpected repository');
      }),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: getRepositoryToken(Application), useValue: applications },
        { provide: getRepositoryToken(RegimentSettings), useValue: settings },
        { provide: getRepositoryToken(DiscordIdentity), useValue: identities },
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
        { provide: SessionContextService, useValue: sessionContext },
        { provide: DiscordSyncService, useValue: discordSync },
      ],
    }).compile();

    service = module.get(ApplicationsService);
  });

  describe('submit', () => {
    it('rejects submission when recruitment is closed', async () => {
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: false });

      await expect(service.submit(APPLICANT, validCreateDto())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(applications.save).not.toHaveBeenCalled();
    });

    it('rejects when an open (pending/held) application already exists', async () => {
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: true });
      applications.find!.mockResolvedValue([
        baseApplication({ status: ApplicationStatus.Pending }),
      ]);

      await expect(service.submit(APPLICANT, validCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('creates a pending application and flags re-application when priors exist', async () => {
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: true });
      applications.find!.mockResolvedValue([
        baseApplication({ id: 'old', status: ApplicationStatus.Declined }),
      ]);

      const result = await service.submit(APPLICANT, validCreateDto());

      const created = applications.create!.mock.calls[0][0] as Partial<Application>;
      expect(created).toMatchObject({
        regimentId: 'regiment-1',
        discordIdentityId: 'identity-applicant',
        status: ApplicationStatus.Pending,
        isReapplication: true,
        isDraft: false,
        currentRegiment: 'None',
        preferredClasses: 'Line Infantry, Rifleman',
        skillsToImprove: 'Melee duelling.',
        interestConfirmed: true,
      });
      expect(created.submittedAt).toBeInstanceOf(Date);
      expect(result.status).toBe(ApplicationStatus.Pending);
      // The applicant self-action is not audited, but is best-effort cross-posted.
      expect(audit.record).not.toHaveBeenCalled();
      expect(discordSync.enqueueApplicationSubmitted).toHaveBeenCalledWith(
        'regiment-1',
        expect.objectContaining({ applicantName: 'Jane Doe', inGameName: 'JaneTheGreat' }),
      );
    });

    it('treats a first-time submission as not a re-application and allows missing settings', async () => {
      settings.findOne!.mockResolvedValue(null);
      applications.find!.mockResolvedValue([]);

      const result = await service.submit(APPLICANT, validCreateDto());

      const created = applications.create!.mock.calls[0][0] as Partial<Application>;
      expect(created.isReapplication).toBe(false);
      expect(result.applicantName).toBe('Jane Doe');
      // Sensitive columns are never projected.
      expect(result).not.toHaveProperty('discordIdentityId');
      expect(result).not.toHaveProperty('discordDmMessage');
    });

    it('rejects submission when the applicant is blocked from applying (T-0055)', async () => {
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        applicationsBlockedAt: new Date(),
      });

      await expect(service.submit(APPLICANT, validCreateDto())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Blocked before recruitment/priors are even checked.
      expect(settings.findOne).not.toHaveBeenCalled();
      expect(applications.save).not.toHaveBeenCalled();
    });

    it('rejects a Mercenary submission when the mercenary track is closed (T-0133)', async () => {
      settings.findOne!.mockResolvedValue({
        regimentId: 'regiment-1',
        openRecruitment: true,
        allowMercenaries: false,
      });
      applications.find!.mockResolvedValue([]);

      await expect(
        service.submit(APPLICANT, { ...validCreateDto(), applicantType: ApplicantType.Mercenary }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(applications.save).not.toHaveBeenCalled();
      // The openRecruitment row is reused — no second settings query (T-0133).
      expect(settings.findOne).toHaveBeenCalledTimes(1);
    });

    it('still accepts Member submissions while the mercenary track is closed (T-0133)', async () => {
      settings.findOne!.mockResolvedValue({
        regimentId: 'regiment-1',
        openRecruitment: true,
        allowMercenaries: false,
      });
      applications.find!.mockResolvedValue([]);

      // Explicitly Member.
      const explicit = await service.submit(APPLICANT, {
        ...validCreateDto(),
        applicantType: ApplicantType.Member,
      });
      expect(explicit.status).toBe(ApplicationStatus.Pending);

      // Omitted entirely → defaults to Member and is equally unaffected.
      const omitted = await service.submit(APPLICANT, validCreateDto());
      expect(omitted.status).toBe(ApplicationStatus.Pending);
      expect((applications.create!.mock.calls[1][0] as Partial<Application>).applicantType).toBe(
        ApplicantType.Member,
      );
    });

    it('accepts a Mercenary submission while the track is open (T-0133)', async () => {
      settings.findOne!.mockResolvedValue({
        regimentId: 'regiment-1',
        openRecruitment: true,
        allowMercenaries: true,
      });
      applications.find!.mockResolvedValue([]);

      await service.submit(APPLICANT, {
        ...validCreateDto(),
        applicantType: ApplicantType.Mercenary,
      });

      const created = applications.create!.mock.calls[0][0] as Partial<Application>;
      expect(created.applicantType).toBe(ApplicantType.Mercenary);
    });

    it('allows a Mercenary submission when there is no settings row (permissive, T-0133)', async () => {
      settings.findOne!.mockResolvedValue(null);
      applications.find!.mockResolvedValue([]);

      await service.submit(APPLICANT, {
        ...validCreateDto(),
        applicantType: ApplicantType.Mercenary,
      });

      const created = applications.create!.mock.calls[0][0] as Partial<Application>;
      expect(created.applicantType).toBe(ApplicantType.Mercenary);
    });

    it('pins the permissive-on-absent-column contract: a settings row without allowMercenaries still accepts a Mercenary submission (T-0133)', async () => {
      // Shape guard. The production check is deliberately `allowMercenaries === false`,
      // not `!allowMercenaries`: the two only disagree when the column is *absent*
      // (undefined) on the loaded row, which happens for real the moment any query
      // narrows its select (e.g. `select: ['openRecruitment']`). Under a truthiness
      // check that would silently 403 every Mercenary submit regiment-wide. Every
      // other stub supplies an explicit boolean or null, so this row — with the
      // column simply missing — is the only input that kills that mutant.
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: true });
      applications.find!.mockResolvedValue([]);

      await service.submit(APPLICANT, {
        ...validCreateDto(),
        applicantType: ApplicantType.Mercenary,
      });

      const created = applications.create!.mock.calls[0][0] as Partial<Application>;
      expect(created.applicantType).toBe(ApplicantType.Mercenary);
    });
  });

  describe('getMine', () => {
    it("returns the caller's latest application (scoped to their identity) + not blocked", async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Declined, declineReason: 'Too few hours' }),
      );

      const result = await service.getMine(APPLICANT);

      expect(applications.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            regimentId: 'regiment-1',
            discordIdentityId: 'identity-applicant',
            isDraft: false,
          }),
          order: { submittedAt: 'DESC' },
        }),
      );
      expect(result.application?.id).toBe('app-1');
      expect(result.blocked).toBe(false);
    });

    it('never hands the applicant the staff-only decision fields (T-0154)', async () => {
      // The decline reason is an internal/audit datum: the only decision text an
      // applicant may read is the message the officer wrote to them. This route
      // is served TO the applicant, so a staff field appearing here is a leak —
      // it used to return the full staff projection.
      applications.findOne!.mockResolvedValue(
        baseApplication({
          status: ApplicationStatus.Declined,
          declineReason: 'Too few hours',
          moderatorNote: 'Smurfing on an alt, do not enlist',
          discordDmMessage: 'Thanks for applying - try again after 50 more hours.',
        }),
      );

      const result = await service.getMine(APPLICANT);

      expect(result.application).not.toHaveProperty('declineReason');
      expect(result.application).not.toHaveProperty('moderatorNote');
      expect(result.application?.userMessage).toBe(
        'Thanks for applying - try again after 50 more hours.',
      );
    });

    it('returns a null application and blocked=true when never applied but blocked', async () => {
      applications.findOne!.mockResolvedValue(null);
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        applicationsBlockedAt: new Date(),
      });

      const result = await service.getMine(APPLICANT);
      expect(result.application).toBeNull();
      expect(result.blocked).toBe(true);
    });
  });

  describe('updateMine', () => {
    it('throws NotFound when the caller has no application', async () => {
      applications.findOne!.mockResolvedValue(null);
      await expect(service.updateMine(APPLICANT, { inGameName: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws Conflict when the application is not pending', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Declined }),
      );
      await expect(service.updateMine(APPLICANT, { inGameName: 'X' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses to edit when the applicant is blocked (cannot re-bump the queue)', async () => {
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        applicationsBlockedAt: new Date(),
      });
      await expect(service.updateMine(APPLICANT, { inGameName: 'X' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(applications.save).not.toHaveBeenCalled();
    });

    it('updates only provided fields, re-bumps submittedAt, and returns the projection', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Pending }),
      );

      const result = await service.updateMine(APPLICANT, {
        inGameName: 'NewName',
        preferredClasses: 'Sapper',
      });

      const saved = applications.save!.mock.calls[0][0] as Application;
      expect(saved.inGameName).toBe('NewName');
      expect(saved.preferredClasses).toBe('Sapper');
      // A field not in the patch is preserved.
      expect(saved.currentRegiment).toBe('None');
      // Re-bumped to the top of the officer queue.
      expect(saved.submittedAt.getTime()).toBeGreaterThan(
        new Date('2026-06-22T18:00:00.000Z').getTime(),
      );
      expect(result.inGameName).toBe('NewName');
    });

    it('refuses a post-submit flip onto a closed mercenary track (T-0133)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Pending }),
      );
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', allowMercenaries: false });

      await expect(
        service.updateMine(APPLICANT, { applicantType: ApplicantType.Mercenary }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(applications.save).not.toHaveBeenCalled();
    });

    it('allows a flip back to Member without consulting settings (T-0133)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({
          status: ApplicationStatus.Pending,
          applicantType: ApplicantType.Mercenary,
        }),
      );
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', allowMercenaries: false });

      const result = await service.updateMine(APPLICANT, {
        applicantType: ApplicantType.Member,
      });

      expect(result.applicantType).toBe(ApplicantType.Member);
      // A Member edit must not pay for the mercenary settings lookup.
      expect(settings.findOne).not.toHaveBeenCalled();
    });

    it('allows a flip to Mercenary when there is no settings row (permissive, T-0133)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Pending }),
      );
      settings.findOne!.mockResolvedValue(null);

      const result = await service.updateMine(APPLICANT, {
        applicantType: ApplicantType.Mercenary,
      });
      expect(result.applicantType).toBe(ApplicantType.Mercenary);
    });

    it('pins the permissive-on-absent-column contract: a settings row without allowMercenaries still allows a flip to Mercenary (T-0133)', async () => {
      // See the matching submit() case: `=== false` must not be "simplified" to a
      // truthiness check, or a narrowed select would refuse every edit onto the track.
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Pending }),
      );
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: true });

      const result = await service.updateMine(APPLICANT, {
        applicantType: ApplicantType.Mercenary,
      });
      expect(result.applicantType).toBe(ApplicantType.Mercenary);
    });
  });

  describe('blockApplicant', () => {
    /** Chainable stub for the bulk "decline open applications" query builder. */
    const declineQb = () => {
      const qb: Record<string, jest.Mock> = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    };

    it('sets the block, declines the open application, and audits it', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        applicationsBlockedAt: null,
      });
      const qb = declineQb();
      applications.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.blockApplicant(STAFF, 'app-1', { reason: 'spam' }, '2.2.2.2');

      const savedIdentity = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(savedIdentity.applicationsBlockedAt).toBeInstanceOf(Date);
      expect(savedIdentity.applicationsBlockedByMemberId).toBe('member-staff');
      expect(savedIdentity.applicationsBlockedReason).toBe('spam');
      // Open applications by this identity are declined so they leave the queue.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: ApplicationStatus.Declined }),
      );
      expect(qb.execute).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'application.block' }),
      );
      expect(result.id).toBe('app-1');
    });

    it('throws BadRequest when the application has no linked identity to block', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ discordIdentityId: null }));
      await expect(service.blockApplicant(STAFF, 'app-1', {}, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('unblockApplicant', () => {
    it('clears the block on the applicant identity and audits it', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        applicationsBlockedAt: new Date(),
      });

      await service.unblockApplicant(STAFF, 'app-1', null);

      const savedIdentity = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(savedIdentity.applicationsBlockedAt).toBeNull();
      expect(savedIdentity.applicationsBlockedByMemberId).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'application.unblock' }),
      );
    });
  });

  describe('findOne', () => {
    it('throws NotFound when the application is missing / wrong regiment', async () => {
      applications.findOne!.mockResolvedValue(null);
      await expect(service.findOne(STAFF, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the projection for a found application', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      const result = await service.findOne(STAFF, 'app-1');
      expect(result.id).toBe('app-1');
      expect(result.submittedAt).toBe('2026-06-22T18:00:00.000Z');
      // No identity loaded → not blocked.
      expect(result.blocked).toBe(false);
    });

    it('derives the blocked flag from the loaded identity relation (T-0128)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({
          discordIdentity: {
            id: 'identity-applicant',
            applicationsBlockedAt: new Date('2026-06-23T00:00:00.000Z'),
          } as DiscordIdentity,
        }),
      );
      // loadOrFail must eager-load the identity relation for the flag to resolve.
      const result = await service.findOne(STAFF, 'app-1');
      expect(applications.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: { discordIdentity: true, promotedMember: true, decidedByMember: true },
        }),
      );
      expect(result.blocked).toBe(true);
    });

    it('attributes the decision to the deciding staffer (T-0155)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({
          status: ApplicationStatus.Declined,
          decidedByMemberId: 'member-staff',
          decidedByMember: {
            id: 'member-staff',
            inGameName: 'Sergeant Steel',
            avatarUrl: 'https://cdn/staff.png',
          } as Member,
        }),
      );

      const result = await service.findOne(STAFF, 'app-1');

      expect(result.decidedByName).toBe('Sergeant Steel');
      expect(result.decidedByAvatarUrl).toBe('https://cdn/staff.png');
    });

    it('degrades to null attribution when the decider has left the roster (T-0155)', async () => {
      // decided_by_member_id is ON DELETE SET NULL, and a decider can also simply
      // be deleted — a queue read of their old decisions must still answer 200.
      applications.findOne!.mockResolvedValue(
        baseApplication({
          status: ApplicationStatus.Declined,
          decidedByMemberId: null,
          decidedByMember: null,
        }),
      );

      const result = await service.findOne(STAFF, 'app-1');

      expect(result.decidedByName).toBeNull();
      expect(result.decidedByAvatarUrl).toBeNull();
    });

    it('reports no decider for a pending application (T-0155)', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.findOne(STAFF, 'app-1');

      expect(result.decidedByMemberId).toBeNull();
      expect(result.decidedByName).toBeNull();
      expect(result.decidedByAvatarUrl).toBeNull();
    });

    it('resolves live identity from the promoted member, else the Discord identity (T-0129)', async () => {
      // Promoted member present → its in-game name + avatar win over the identity.
      applications.findOne!.mockResolvedValue(
        baseApplication({
          promotedMember: {
            inGameName: 'RenamedRecruit',
            avatarUrl: 'https://cdn/member.png',
          } as Member,
          discordIdentity: {
            id: 'identity-applicant',
            globalName: 'OldDiscordName',
            avatarUrl: 'https://cdn/discord.png',
            applicationsBlockedAt: null,
          } as DiscordIdentity,
        }),
      );
      const withMember = await service.findOne(STAFF, 'app-1');
      expect(withMember.currentDisplayName).toBe('RenamedRecruit');
      expect(withMember.currentAvatarUrl).toBe('https://cdn/member.png');

      // No promoted member → fall back to the linked Discord identity.
      applications.findOne!.mockResolvedValue(
        baseApplication({
          promotedMember: null,
          discordIdentity: {
            id: 'identity-applicant',
            globalName: 'OldDiscordName',
            avatarUrl: 'https://cdn/discord.png',
            applicationsBlockedAt: null,
          } as DiscordIdentity,
        }),
      );
      const identityOnly = await service.findOne(STAFF, 'app-1');
      expect(identityOnly.currentDisplayName).toBe('OldDiscordName');
      expect(identityOnly.currentAvatarUrl).toBe('https://cdn/discord.png');

      // Neither member nor identity avatar → null (not an error).
      applications.findOne!.mockResolvedValue(baseApplication({ discordIdentity: null }));
      const neither = await service.findOne(STAFF, 'app-1');
      expect(neither.currentDisplayName).toBeNull();
      expect(neither.currentAvatarUrl).toBeNull();
    });
  });

  describe('approve', () => {
    it('throws Conflict when the application is already decided', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Approved }),
      );
      await expect(service.approve(STAFF, 'app-1', {}, null)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates a Member at the Recruit rank for an Applicant and audits the approval', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      const result = await service.approve(STAFF, 'app-1', {}, '9.9.9.9');

      expect(txRanks.findOneOrFail).toHaveBeenCalledWith({
        where: { regimentId: 'regiment-1', name: 'Recruit' },
      });
      const createdMember = txMembers.create!.mock.calls[0][0] as Partial<Member>;
      expect(createdMember).toMatchObject({
        regimentId: 'regiment-1',
        rankId: 'rank-recruit',
        // A default (Member) applicant enlists as a Member (T-0095).
        role: MemberRole.Member,
        status: MemberStatus.Active,
        inGameName: 'JaneTheGreat',
        discordLinked: true,
      });
      // The created member no longer carries a display `name` — only inGameName (T-0106).
      expect(createdMember).not.toHaveProperty('name');
      // Promotion drops the applicant's cached Applicant context (T-0046).
      expect(sessionContext.invalidate).toHaveBeenCalledWith('identity-applicant');
      expect(result.status).toBe(ApplicationStatus.Approved);
      expect(result.promotedMemberId).toBe('member-new');
      expect(result.decidedByMemberId).toBe('member-staff');
      expect(result.decidedAt).not.toBeNull();

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          regimentId: 'regiment-1',
          action: 'application.approve',
          target: expect.objectContaining({
            type: 'application',
            id: 'app-1',
            memberId: 'member-new',
          }),
        }),
      );
    });

    it('persists the promoted member on BOTH the FK and the relation', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      await service.approve(STAFF, 'app-1', {}, null);

      // `loadOrFail` hydrates `promotedMember` (null pre-approval, T-0129) and TypeORM
      // lets a loaded relation win over the raw FK on save — so persisting only
      // `promotedMemberId` would write promoted_member_id = NULL and lose the promotion.
      const saved = txApplications.save!.mock.calls[0][0] as Application;
      expect(saved.promotedMemberId).toBe('member-new');
      expect(saved.promotedMember).toMatchObject({ id: 'member-new' });
    });

    it('enlists a Mercenary applicant as a Mercenary (T-0095)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ applicantType: ApplicantType.Mercenary }),
      );
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      await service.approve(STAFF, 'app-1', {}, null);

      const createdMember = txMembers.create!.mock.calls[0][0] as Partial<Member>;
      // Still enlists at the entry rank, but on the Mercenary track.
      expect(createdMember).toMatchObject({
        rankId: 'rank-recruit',
        role: MemberRole.Mercenary,
      });
    });

    it('refuses to enlist a Mercenary applicant once the track is closed (T-0133)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ applicantType: ApplicantType.Mercenary }),
      );
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', allowMercenaries: false });

      await expect(service.approve(STAFF, 'app-1', {}, null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Refused before the enlistment transaction opens — no member is created.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('approves a Member applicant regardless of the mercenary toggle (T-0133)', async () => {
      // Regression guard: the new settings lookup must never reach Member approvals.
      applications.findOne!.mockResolvedValue(baseApplication());
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', allowMercenaries: false });
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      const result = await service.approve(STAFF, 'app-1', {}, null);

      expect(result.status).toBe(ApplicationStatus.Approved);
      expect(txMembers.create!.mock.calls[0][0]).toMatchObject({ role: MemberRole.Member });
      expect(settings.findOne).not.toHaveBeenCalled();
    });

    it('approves a Mercenary applicant when there is no settings row (permissive, T-0133)', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ applicantType: ApplicantType.Mercenary }),
      );
      settings.findOne!.mockResolvedValue(null);
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      await service.approve(STAFF, 'app-1', {}, null);

      expect(txMembers.create!.mock.calls[0][0]).toMatchObject({ role: MemberRole.Mercenary });
    });

    it('pins the permissive-on-absent-column contract: a settings row without allowMercenaries still approves a Mercenary applicant (T-0133)', async () => {
      // See the matching submit() case: `=== false` must not be "simplified" to a
      // truthiness check, or a narrowed select would refuse every Mercenary approval.
      applications.findOne!.mockResolvedValue(
        baseApplication({ applicantType: ApplicantType.Mercenary }),
      );
      settings.findOne!.mockResolvedValue({ regimentId: 'regiment-1', openRecruitment: true });
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      await service.approve(STAFF, 'app-1', {}, null);

      expect(txMembers.create!.mock.calls[0][0]).toMatchObject({ role: MemberRole.Mercenary });
    });

    it('approves an application that was on hold', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ status: ApplicationStatus.Held }));
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      const result = await service.approve(STAFF, 'app-1', {}, null);
      expect(result.status).toBe(ApplicationStatus.Approved);
    });
  });

  describe('decline', () => {
    it('throws Conflict when not pending/held', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Declined }),
      );
      await expect(service.decline(STAFF, 'app-1', {}, null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('sets declined state, reason, decider and audits', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.decline(STAFF, 'app-1', { reason: 'Too few hours' }, '1.1.1.1');

      expect(result.status).toBe(ApplicationStatus.Declined);
      expect(result.declineReason).toBe('Too few hours');
      expect(result.decidedByMemberId).toBe('member-staff');
      expect(result.decidedAt).not.toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'application.decline' }),
      );
    });

    it('defaults declineReason to null when omitted', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      const result = await service.decline(STAFF, 'app-1', {}, null);
      expect(result.declineReason).toBeNull();
    });

    it('accepts the staff-only note the console sends on a decline (T-0248)', async () => {
      // The console shares one note box across hold and decline; without this
      // field forbidNonWhitelisted would 400 the entire decline.
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.decline(
        STAFF,
        'app-1',
        { note: 'Alt account of a banned member' },
        null,
      );

      expect(result.moderatorNote).toBe('Alt account of a banned member');
      // With no separate reason, the note is what the audit trail records.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'Alt account of a banned member' }),
      );
    });
  });

  describe('hold', () => {
    it('throws Conflict when the application is already decided', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Approved }),
      );
      await expect(service.hold(STAFF, 'app-1', {}, null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('sets held state and note, records the staffer but NOT decidedAt, and audits', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.hold(STAFF, 'app-1', { note: 'Need a reference' }, null);

      expect(result.status).toBe(ApplicationStatus.Held);
      expect(result.moderatorNote).toBe('Need a reference');
      expect(result.decidedByMemberId).toBe('member-staff');
      // A hold is not a final decision.
      expect(result.decidedAt).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'application.hold' }),
      );
    });

    it('preserves the existing moderator note when none is provided', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ moderatorNote: 'prior note' }));
      const result = await service.hold(STAFF, 'app-1', {}, null);
      expect(result.moderatorNote).toBe('prior note');
    });
  });

  describe('decision text persistence (T-0153)', () => {
    it('stores the trimmed officer-written message on approve, decline and hold', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });
      const approved = await service.approve(
        STAFF,
        'app-1',
        { discordDmMessage: '  Welcome aboard!  ' },
        null,
      );
      expect(approved.userMessage).toBe('Welcome aboard!');

      applications.findOne!.mockResolvedValue(baseApplication());
      const declined = await service.decline(
        STAFF,
        'app-1',
        { discordDmMessage: 'Not this time.' },
        null,
      );
      expect(declined.userMessage).toBe('Not this time.');

      applications.findOne!.mockResolvedValue(baseApplication());
      const held = await service.hold(
        STAFF,
        'app-1',
        { discordDmMessage: 'We need a reference first.' },
        null,
      );
      expect(held.userMessage).toBe('We need a reference first.');
    });

    it('stores nothing when the officer wrote nothing — the default template is not persisted', async () => {
      // The applicant still receives a DM (rendered from the default template),
      // but the column records only text an officer actually chose to write, so
      // "what were they told?" never answers with a machine-generated sentence.
      applications.findOne!.mockResolvedValue(baseApplication());
      identities.findOne!.mockResolvedValue({
        id: 'identity-applicant',
        discordUserId: 'discord-2',
        applicationsBlockedAt: null,
      });
      settings.findOne!.mockResolvedValue({ regiment: { name: 'The Lords' } });

      const result = await service.hold(STAFF, 'app-1', { discordDmMessage: '' }, null);

      expect(discordSync.enqueueApplicationDecision).toHaveBeenCalledWith(
        'regiment-1',
        expect.objectContaining({ content: expect.stringContaining('The Lords') }),
      );
      expect(result.userMessage).toBeNull();
    });

    it('a decision with no message must not wipe the stored one', async () => {
      // The staff console posts `discordDmMessage: ''` on every decision, and
      // @IsOptional() does not strip an empty string — so a hold that explained
      // itself must survive the decline that follows it with an empty box.
      applications.findOne!.mockResolvedValue(
        baseApplication({
          status: ApplicationStatus.Held,
          discordDmMessage: 'On hold - we need a reference.',
        }),
      );

      const result = await service.decline(STAFF, 'app-1', { discordDmMessage: '   ' }, null);

      expect(result.userMessage).toBe('On hold - we need a reference.');
    });

    it('a blank note must not wipe the stored moderator note', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ moderatorNote: 'prior note' }));
      const held = await service.hold(STAFF, 'app-1', { note: '' }, null);
      expect(held.moderatorNote).toBe('prior note');

      applications.findOne!.mockResolvedValue(baseApplication({ moderatorNote: 'prior note' }));
      const declined = await service.decline(STAFF, 'app-1', { note: '   ' }, null);
      expect(declined.moderatorNote).toBe('prior note');
    });

    it('a blank reason is stored as null, never as an empty string', async () => {
      // '' would read as "a reason was given" everywhere downstream (the console
      // shows the reason block whenever the field is truthy in either direction).
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.decline(STAFF, 'app-1', { reason: '  ' }, null);

      expect(result.declineReason).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ detail: null }));
    });
  });

  describe('decision attribution (T-0155)', () => {
    it('writes the decider despite the hydrated (null) decidedByMember relation', async () => {
      // Regression guard, mirroring the promotedMember trap in approve(): TypeORM
      // lets a LOADED relation outrank the raw FK on save, so now that loadOrFail
      // hydrates decidedByMember, setting only the FK would write
      // decided_by_member_id = NULL and lose the attribution outright.
      applications.findOne!.mockResolvedValue(baseApplication({ decidedByMember: null }));

      await service.decline(STAFF, 'app-1', {}, null);

      const saved = applications.save!.mock.calls[0][0] as Application;
      expect(saved.decidedByMemberId).toBe('member-staff');
      expect(saved.decidedByMember).toMatchObject({ id: 'member-staff' });
    });

    it('still records the decider FK when their member row cannot be read', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ decidedByMember: null }));
      members.findOne!.mockResolvedValue(null);

      await service.hold(STAFF, 'app-1', {}, null);

      const saved = applications.save!.mock.calls[0][0] as Application;
      expect(saved.decidedByMemberId).toBe('member-staff');
      // undefined, not null: TypeORM skips an undefined relation, so the FK stands.
      expect(saved.decidedByMember).toBeUndefined();
    });

    it('carries the decider onto the staff projection of the decision response', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());

      const result = await service.decline(STAFF, 'app-1', { reason: 'Too few hours' }, null);

      expect(result.decidedByName).toBe('Sergeant Steel');
      expect(result.decidedByAvatarUrl).toBe('https://cdn/staff.png');
    });
  });

  describe('findAll', () => {
    /** Chainable query-builder stub mirroring the findAll fluent chain. */
    const findAllQb = (rows: Application[], total = rows.length) => {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
      };
      return qb;
    };

    it('builds a regiment-scoped, non-draft, status-filtered, paginated query', async () => {
      const qb = findAllQb([baseApplication()], 1);
      applications.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.findAll(STAFF, {
        page: 1,
        limit: 20,
        skip: 0,
        status: ApplicationStatus.Pending,
      });

      // The block flag is loaded via a single join before any filtering (T-0128);
      // the promoted member is joined for the applicant's live identity (T-0129).
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('a.discordIdentity', 'identity');
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('a.promotedMember', 'promotedMember');
      // The decider is joined too, so attributing a page of decisions costs no
      // per-row member lookup (T-0155).
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('a.decidedByMember', 'decidedByMember');
      expect(qb.where).toHaveBeenCalledWith('a.regimentId = :regimentId', {
        regimentId: 'regiment-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('a.isDraft = :isDraft', { isDraft: false });
      expect(qb.andWhere).toHaveBeenCalledWith('a.status = :status', {
        status: ApplicationStatus.Pending,
      });
      expect(qb.orderBy).toHaveBeenCalledWith('a.submittedAt', 'DESC');
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('maps blocked from the joined discordIdentity relation (T-0128)', async () => {
      const blockedRow = baseApplication({
        id: 'app-blocked',
        discordIdentity: {
          id: 'identity-applicant',
          applicationsBlockedAt: new Date('2026-06-23T00:00:00.000Z'),
        } as DiscordIdentity,
      });
      // A row whose identity is present but never blocked, and one with no identity at all.
      const clearedRow = baseApplication({
        id: 'app-cleared',
        discordIdentity: { id: 'identity-other', applicationsBlockedAt: null } as DiscordIdentity,
      });
      const orphanRow = baseApplication({ id: 'app-orphan', discordIdentity: null });
      const qb = findAllQb([blockedRow, clearedRow, orphanRow], 3);
      applications.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.findAll(STAFF, { page: 1, limit: 20, skip: 0 });

      expect(result.data.map((a) => a.blocked)).toEqual([true, false, false]);
    });

    it('attributes decisions from the joined decider, with no per-row lookup (T-0155)', async () => {
      const decided = baseApplication({
        id: 'app-decided',
        status: ApplicationStatus.Approved,
        decidedByMemberId: 'member-staff',
        decidedByMember: {
          id: 'member-staff',
          inGameName: 'Sergeant Steel',
          avatarUrl: null,
        } as Member,
      });
      const pending = baseApplication({ id: 'app-pending' });
      const qb = findAllQb([decided, pending], 2);
      applications.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.findAll(STAFF, { page: 1, limit: 20, skip: 0 });

      expect(result.data.map((a) => a.decidedByName)).toEqual(['Sergeant Steel', null]);
      // The whole page is attributed by the join — a member lookup per row is an N+1.
      expect(members.findOne).not.toHaveBeenCalled();
    });
  });
});
