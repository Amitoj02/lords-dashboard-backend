import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import {
  ApplicantType,
  ApplicationStatus,
  HowFound,
  MemberRole,
  MemberStatus,
  Platform,
} from '../common/enums';
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
  platform: Platform.Steam,
  applicantType: ApplicantType.Applicant,
  discordTag: '@janedoe',
  timezone: 'America/Toronto',
  whyJoin: 'I love line battles.',
  howFound: HowFound.Discord,
  priorExperience: 'A bit.',
  ageConfirmed: true,
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
  platform: Platform.Steam,
  applicantType: ApplicantType.Applicant,
  timezone: 'America/Toronto',
  whyJoin: 'I love line battles.',
  howFound: HowFound.Discord,
  priorExperience: 'A bit.',
  ageConfirmed: true,
  ageConfirmedAt: new Date('2026-06-22T18:00:00.000Z'),
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
  let audit: { record: jest.Mock };

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
    audit = { record: jest.fn() };

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
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
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
        applicantType: ApplicantType.Applicant,
      });
      expect(created.submittedAt).toBeInstanceOf(Date);
      expect(created.ageConfirmedAt).toBeInstanceOf(Date);
      expect(result.status).toBe(ApplicationStatus.Pending);
      // The applicant self-action is not audited.
      expect(audit.record).not.toHaveBeenCalled();
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
    });
  });

  describe('approve', () => {
    it('throws Conflict when the application is already decided', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ status: ApplicationStatus.Approved }),
      );
      await expect(service.approve(STAFF, 'app-1', null)).rejects.toBeInstanceOf(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates a Member at the Recruit rank for an Applicant and audits the approval', async () => {
      applications.findOne!.mockResolvedValue(baseApplication());
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      const result = await service.approve(STAFF, 'app-1', '9.9.9.9');

      expect(txRanks.findOneOrFail).toHaveBeenCalledWith({
        where: { regimentId: 'regiment-1', name: 'Recruit' },
      });
      const createdMember = txMembers.create!.mock.calls[0][0] as Partial<Member>;
      expect(createdMember).toMatchObject({
        regimentId: 'regiment-1',
        rankId: 'rank-recruit',
        role: MemberRole.Member,
        status: MemberStatus.Active,
        name: 'Jane Doe',
        inGameName: 'JaneTheGreat',
        platform: Platform.Steam,
        discordLinked: true,
      });
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

    it('uses the Mercenary rank and role for a Mercenary applicant', async () => {
      applications.findOne!.mockResolvedValue(
        baseApplication({ applicantType: ApplicantType.Mercenary }),
      );
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-merc', name: 'Mercenary' });

      await service.approve(STAFF, 'app-1', null);

      expect(txRanks.findOneOrFail).toHaveBeenCalledWith({
        where: { regimentId: 'regiment-1', name: 'Mercenary' },
      });
      const createdMember = txMembers.create!.mock.calls[0][0] as Partial<Member>;
      expect(createdMember.role).toBe(MemberRole.Mercenary);
      expect(createdMember.rankId).toBe('rank-merc');
    });

    it('approves an application that was on hold', async () => {
      applications.findOne!.mockResolvedValue(baseApplication({ status: ApplicationStatus.Held }));
      txRanks.findOneOrFail!.mockResolvedValue({ id: 'rank-recruit', name: 'Recruit' });

      const result = await service.approve(STAFF, 'app-1', null);
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

  describe('findAll', () => {
    it('builds a regiment-scoped, non-draft, status-filtered, paginated query', async () => {
      const qb: Record<string, jest.Mock> = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[baseApplication()], 1]),
      };
      applications.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.findAll(STAFF, {
        page: 1,
        limit: 20,
        skip: 0,
        status: ApplicationStatus.Pending,
      });

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
  });
});
