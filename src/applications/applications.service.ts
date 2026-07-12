import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { ApplicationStatus, MemberRole, MemberStatus } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { ServiceRecordEntry } from '../members/entities/service-record-entry.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { ApplicationDto } from './dto/application.dto';
import { ApplicationQueryDto } from './dto/application-query.dto';
import { BlockApplicantDto } from './dto/block-applicant.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { DeclineApplicationDto } from './dto/decline-application.dto';
import { HoldApplicationDto } from './dto/hold-application.dto';
import { MyApplicationDto } from './dto/my-application.dto';
import { UpdateMyApplicationDto } from './dto/update-my-application.dto';
import { Application } from './entities/application.entity';

/**
 * Every approved applicant enlists as a Member at the entry rank. The old
 * Applicant/Mercenary split was retired with the enlistment-form reshape
 * (T-0039); the form no longer collects an applicant type.
 */
const ENTRY_RANK_NAME = 'Recruit';
const ENTRY_ROLE = MemberRole.Member;

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
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    // Drops the applicant's cached authorization context on approval so they
    // gain Member capabilities on their very next request (T-0046).
    private readonly sessionContext: SessionContextService,
    // Best-effort: cross-post new enlistments to the enlistments channel (T-0042).
    // Never fails intake — a disabled bot or enqueue error silently no-ops.
    private readonly discordSync: DiscordSyncService,
  ) {}

  /**
   * Submit an application. The submitter is the authenticated Discord identity
   * (Applicant role). Honors the regiment's openRecruitment toggle, blocks a
   * second concurrent application, and flags re-applications.
   */
  async submit(user: AuthenticatedUser, dto: CreateApplicationDto): Promise<ApplicationDto> {
    // An officer can permanently bar an identity from applying (T-0055); reject
    // before anything else so a blocked user can never create a new application.
    const identity = await this.identities.findOne({ where: { id: user.identityId } });
    if (identity?.applicationsBlockedAt) {
      throw new ForbiddenException('You are no longer permitted to submit an application');
    }

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
      discordTag: dto.discordTag ?? null,
      currentRegiment: dto.currentRegiment,
      howFound: dto.howFound,
      preferredClasses: dto.preferredClasses,
      skillsToImprove: dto.skillsToImprove,
      interestConfirmed: dto.interestConfirmed,
      representativeNote: dto.representativeNote ?? null,
      status: ApplicationStatus.Pending,
      isReapplication: priors.length > 0,
      isDraft: false,
      submittedAt: now,
    });
    const saved = await this.applications.save(application);

    // Best-effort cross-post to the enlistments channel (never throws / no-ops
    // when the bot is disabled or no enlistments channel is configured).
    await this.discordSync.enqueueApplicationSubmitted(user.regimentId, {
      applicantName: saved.applicantName,
      inGameName: saved.inGameName,
      currentRegiment: saved.currentRegiment,
      howFound: saved.howFound,
      preferredClasses: saved.preferredClasses,
      skillsToImprove: saved.skillsToImprove,
      representativeNote: saved.representativeNote,
    });

    // TODO(audit): no `application.submit` action code exists in the seed; the
    // submit is an applicant self-action, so it is intentionally not audited.
    return ApplicationDto.from(saved);
  }

  /**
   * The caller's own application view (T-0054): their most recent application
   * (or null if they have never applied) plus whether an officer has blocked
   * them from applying (T-0055). Scoped to the caller's Discord identity.
   */
  async getMine(user: AuthenticatedUser): Promise<MyApplicationDto> {
    const application = await this.applications.findOne({
      where: { regimentId: user.regimentId, discordIdentityId: user.identityId, isDraft: false },
      order: { submittedAt: 'DESC' },
    });
    const identity = await this.identities.findOne({ where: { id: user.identityId } });
    return {
      application: application ? ApplicationDto.from(application) : null,
      blocked: !!identity?.applicationsBlockedAt,
    };
  }

  /**
   * Edit the caller's own PENDING application (T-0054/T-0031). Only a pending
   * application can be changed; a decided one (approved/declined) or a held one
   * is immutable to the applicant. Editing re-bumps it to the top of the officer
   * queue (which is ordered by submittedAt) — the "within 48 hours" copy is
   * informational only, so this is safe.
   */
  async updateMine(user: AuthenticatedUser, dto: UpdateMyApplicationDto): Promise<ApplicationDto> {
    const application = await this.applications.findOne({
      where: { regimentId: user.regimentId, discordIdentityId: user.identityId, isDraft: false },
      order: { submittedAt: 'DESC' },
    });
    if (!application) {
      throw new NotFoundException('You have no application to edit');
    }
    if (application.status !== ApplicationStatus.Pending) {
      throw new ConflictException('Only a pending application can be edited');
    }

    if (dto.applicantName !== undefined) application.applicantName = dto.applicantName;
    if (dto.inGameName !== undefined) application.inGameName = dto.inGameName;
    if (dto.discordTag !== undefined) application.discordTag = dto.discordTag ?? null;
    if (dto.currentRegiment !== undefined) application.currentRegiment = dto.currentRegiment;
    if (dto.howFound !== undefined) application.howFound = dto.howFound;
    if (dto.preferredClasses !== undefined) application.preferredClasses = dto.preferredClasses;
    if (dto.skillsToImprove !== undefined) application.skillsToImprove = dto.skillsToImprove;
    if (dto.interestConfirmed !== undefined) application.interestConfirmed = dto.interestConfirmed;
    if (dto.representativeNote !== undefined) {
      application.representativeNote = dto.representativeNote ?? null;
    }
    application.submittedAt = new Date();

    const saved = await this.applications.save(application);
    return ApplicationDto.from(saved);
  }

  /**
   * Permanently block the applicant behind an application from submitting any
   * further applications (T-0055). The block lives on their Discord identity, so
   * it survives across applications. Audited.
   */
  async blockApplicant(
    user: AuthenticatedUser,
    id: string,
    dto: BlockApplicantDto,
    ip: string | null,
  ): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    if (!application.discordIdentityId) {
      throw new BadRequestException('This application has no linked Discord identity to block');
    }
    const identity = await this.identities.findOne({
      where: { id: application.discordIdentityId },
    });
    if (!identity) {
      throw new NotFoundException('Applicant identity not found');
    }

    identity.applicationsBlockedAt = new Date();
    identity.applicationsBlockedByMemberId = user.memberId;
    identity.applicationsBlockedReason = dto.reason ?? null;
    await this.identities.save(identity);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'application.block',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'application', id: application.id, label: application.applicantName },
      detail: dto.reason ?? null,
    });

    return ApplicationDto.from(application);
  }

  /** Re-enable a previously blocked applicant (T-0055). Audited. */
  async unblockApplicant(
    user: AuthenticatedUser,
    id: string,
    ip: string | null,
  ): Promise<ApplicationDto> {
    const application = await this.loadOrFail(user, id);
    if (application.discordIdentityId) {
      const identity = await this.identities.findOne({
        where: { id: application.discordIdentityId },
      });
      if (identity?.applicationsBlockedAt) {
        identity.applicationsBlockedAt = null;
        identity.applicationsBlockedByMemberId = null;
        identity.applicationsBlockedReason = null;
        await this.identities.save(identity);
      }
    }

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'application.unblock',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'application', id: application.id, label: application.applicantName },
      detail: null,
    });

    return ApplicationDto.from(application);
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

      const rankName = ENTRY_RANK_NAME;
      const role = ENTRY_ROLE;
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
      detail: `Approved application; promoted to ${member.role} (${ENTRY_RANK_NAME}).`,
    });

    // The applicant is now a member: drop their cached (Applicant) context so
    // the promotion is reflected on their next request with the same token.
    this.sessionContext.invalidate(application.discordIdentityId);

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
