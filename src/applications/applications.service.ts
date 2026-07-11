import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { ApplicantType, ApplicationStatus, MemberRole, MemberStatus } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { ServiceRecordEntry } from '../members/entities/service-record-entry.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { ApplicationDto } from './dto/application.dto';
import { ApplicationQueryDto } from './dto/application-query.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { DeclineApplicationDto } from './dto/decline-application.dto';
import { HoldApplicationDto } from './dto/hold-application.dto';
import { Application } from './entities/application.entity';

/** The rank name new members are placed at, keyed by applicant type. */
const ENTRY_RANK_NAME: Record<ApplicantType, string> = {
  [ApplicantType.Mercenary]: 'Mercenary',
  [ApplicantType.Applicant]: 'Recruit',
};

/** The member role assigned on approval, keyed by applicant type. */
const ENTRY_ROLE: Record<ApplicantType, MemberRole> = {
  [ApplicantType.Mercenary]: MemberRole.Mercenary,
  [ApplicantType.Applicant]: MemberRole.Member,
};

/**
 * Recruitment applications: applicant self-submit + the staff review queue
 * (approve/decline/hold). Every query is scoped to the caller's regiment; the
 * single mutation that touches two tables (approve) runs in a transaction.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    @InjectRepository(Application)
    private readonly applications: Repository<Application>,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Submit an application. The submitter is the authenticated Discord identity
   * (Applicant role). Honors the regiment's openRecruitment toggle, blocks a
   * second concurrent application, and flags re-applications.
   */
  async submit(user: AuthenticatedUser, dto: CreateApplicationDto): Promise<ApplicationDto> {
    // honor the settings visibility toggle.
    const settings = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    if (settings && settings.openRecruitment === false) {
      throw new ForbiddenException('Recruitment is currently closed');
    }

    const priors = await this.applications.find({
      where: { regimentId: user.regimentId, discordIdentityId: user.identityId },
    });

    const hasOpen = priors.some(
      (a) => a.status === ApplicationStatus.Pending || a.status === ApplicationStatus.Held,
    );
    if (hasOpen) {
      throw new ConflictException('You already have an application under review');
    }

    const now = new Date();
    const application = this.applications.create({
      regimentId: user.regimentId,
      discordIdentityId: user.identityId,
      applicantName: dto.applicantName,
      inGameName: dto.inGameName,
      platform: dto.platform,
      applicantType: dto.applicantType ?? ApplicantType.Applicant,
      discordTag: dto.discordTag ?? null,
      timezone: dto.timezone ?? null,
      whyJoin: dto.whyJoin,
      howFound: dto.howFound,
      priorExperience: dto.priorExperience ?? null,
      ageConfirmed: dto.ageConfirmed,
      ageConfirmedAt: now,
      status: ApplicationStatus.Pending,
      isReapplication: priors.length > 0,
      isDraft: false,
      submittedAt: now,
    });
    const saved = await this.applications.save(application);

    // TODO(audit): no `application.submit` action code exists in the seed; the
    // submit is an applicant self-action, so it is intentionally not audited.
    return ApplicationDto.from(saved);
  }

  /** Admin queue: paginated, optionally status-filtered, drafts excluded. */
  async findAll(
    user: AuthenticatedUser,
    query: ApplicationQueryDto,
  ): Promise<PaginatedResponseDto<ApplicationDto>> {
    const qb = this.applications
      .createQueryBuilder('a')
      .where('a.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('a.isDraft = :isDraft', { isDraft: false });

    if (query.status) {
      qb.andWhere('a.status = :status', { status: query.status });
    }

    const [rows, total] = await qb
      .orderBy('a.submittedAt', 'DESC')
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    return new PaginatedResponseDto(
      rows.map((row) => ApplicationDto.from(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Admin view of a single application (regiment-scoped). */
  async findOne(user: AuthenticatedUser, id: string): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    return ApplicationDto.from(application);
  }

  /**
   * Approve an application: create the roster Member at the entry rank and mark
   * the application approved, atomically. Audited on commit.
   */
  async approve(user: AuthenticatedUser, id: string, ip: string | null): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    this.assertDecidable(application);

    const { savedApplication, member } = await this.dataSource.transaction(async (manager) => {
      const rankRepo = manager.getRepository(Rank);
      const memberRepo = manager.getRepository(Member);
      const applicationRepo = manager.getRepository(Application);

      const rankName = ENTRY_RANK_NAME[application.applicantType];
      const role = ENTRY_ROLE[application.applicantType];
      const rank = await rankRepo.findOneOrFail({
        where: { regimentId: user.regimentId, name: rankName },
      });

      const now = new Date();
      const created = memberRepo.create({
        regimentId: user.regimentId,
        discordIdentityId: application.discordIdentityId,
        rankId: rank.id,
        name: application.applicantName,
        inGameName: application.inGameName,
        role,
        status: MemberStatus.Active,
        platform: application.platform,
        timezone: application.timezone,
        discordLinked: !!application.discordIdentityId,
        joinedAt: now,
        lastSeenAt: now,
      });
      const member = await memberRepo.save(created);

      // Open the member's service record with their enlistment (same transaction).
      const serviceRepo = manager.getRepository(ServiceRecordEntry);
      await serviceRepo.save(
        serviceRepo.create({
          memberId: member.id,
          regimentId: user.regimentId,
          occurredAt: now,
          type: 'enlistment',
          event: `Enlisted as ${role} at rank ${rankName}`,
          note: null,
        }),
      );

      application.status = ApplicationStatus.Approved;
      application.promotedMemberId = member.id;
      application.decidedByMemberId = user.memberId;
      application.decidedAt = now;
      const savedApplication = await applicationRepo.save(application);

      return { savedApplication, member };
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'application.approve',
      actor: AuditService.actorFromUser(user, ip),
      target: {
        type: 'application',
        id: savedApplication.id,
        memberId: member.id,
        label: savedApplication.applicantName,
      },
      detail: `Approved application; promoted to ${member.role} (${ENTRY_RANK_NAME[application.applicantType]}).`,
    });

    return ApplicationDto.from(savedApplication);
  }

  /** Decline an open (Pending/Held) application. Audited. */
  async decline(
    user: AuthenticatedUser,
    id: string,
    dto: DeclineApplicationDto,
    ip: string | null,
  ): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    this.assertDecidable(application);

    application.status = ApplicationStatus.Declined;
    application.declineReason = dto.reason ?? null;
    application.decidedByMemberId = user.memberId;
    application.decidedAt = new Date();
    const saved = await this.applications.save(application);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'application.decline',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'application', id: saved.id, label: saved.applicantName },
      detail: dto.reason ?? null,
    });

    return ApplicationDto.from(saved);
  }

  /**
   * Place a Pending (or already Held) application on hold. Records the staffer
   * who held it but does NOT set decidedAt — a hold is not a final decision.
   */
  async hold(
    user: AuthenticatedUser,
    id: string,
    dto: HoldApplicationDto,
    ip: string | null,
  ): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    if (
      application.status !== ApplicationStatus.Pending &&
      application.status !== ApplicationStatus.Held
    ) {
      throw new ConflictException('Application already decided');
    }

    application.status = ApplicationStatus.Held;
    application.moderatorNote = dto.note ?? application.moderatorNote;
    application.decidedByMemberId = user.memberId;
    const saved = await this.applications.save(application);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'application.hold',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'application', id: saved.id, label: saved.applicantName },
      detail: dto.note ?? null,
    });

    return ApplicationDto.from(saved);
  }

  /** Load a regiment-scoped application or throw 404. */
  private async loadOrFail(user: AuthenticatedUser, id: string): Promise<Application> {
    const application = await this.applications.findOne({
      where: { id, regimentId: user.regimentId },
    });
    if (!application) {
      throw new NotFoundException('Application not found');
    }
    return application;
  }

  /** Guard a final decision: the application must still be Pending or Held. */
  private assertDecidable(application: Application): void {
    if (
      application.status !== ApplicationStatus.Pending &&
      application.status !== ApplicationStatus.Held
    ) {
      throw new ConflictException('Application already decided');
    }
  }
}
