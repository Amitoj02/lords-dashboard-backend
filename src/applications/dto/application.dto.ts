import { ApiProperty } from '@nestjs/swagger';
import { ApplicantType, ApplicationStatus, HowFound, Platform } from '../../common/enums';
import { Application } from '../entities/application.entity';

/**
 * Client-facing projection of a recruitment application. Deliberately omits
 * internal/PII columns (discordIdentityId, discordDmMessage) — never expose the
 * raw entity.
 */
export class ApplicationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Jane Doe' })
  applicantName: string;

  @ApiProperty({ nullable: true, example: '@janedoe' })
  discordTag: string | null;

  @ApiProperty({ example: 'JaneTheGreat' })
  inGameName: string;

  @ApiProperty({ enum: Platform })
  platform: Platform;

  @ApiProperty({ enum: ApplicantType })
  applicantType: ApplicantType;

  @ApiProperty({ nullable: true, example: 'America/Toronto' })
  timezone: string | null;

  @ApiProperty({ description: 'Free-text "why do you want to join" answer' })
  whyJoin: string;

  @ApiProperty({ enum: HowFound })
  howFound: HowFound;

  @ApiProperty({ nullable: true })
  priorExperience: string | null;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiProperty({ description: 'True when this identity has applied before' })
  isReapplication: boolean;

  @ApiProperty()
  ageConfirmed: boolean;

  @ApiProperty({ example: 0 })
  mutualEventsCount: number;

  @ApiProperty({ nullable: true })
  moderatorNote: string | null;

  @ApiProperty({ nullable: true })
  declineReason: string | null;

  @ApiProperty({ nullable: true, description: 'Member id created on approval' })
  promotedMemberId: string | null;

  @ApiProperty({ nullable: true, description: 'Member id of the staffer who decided' })
  decidedByMemberId: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z', description: 'ISO submit timestamp' })
  submittedAt: string;

  @ApiProperty({ nullable: true, example: '2026-06-22T19:00:00.000Z' })
  decidedAt: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  createdAt: string;

  /** Map an Application entity to its safe client projection. */
  static from(application: Application): ApplicationDto {
    return {
      id: application.id,
      applicantName: application.applicantName,
      discordTag: application.discordTag,
      inGameName: application.inGameName,
      platform: application.platform,
      applicantType: application.applicantType,
      timezone: application.timezone,
      whyJoin: application.whyJoin,
      howFound: application.howFound,
      priorExperience: application.priorExperience,
      status: application.status,
      isReapplication: application.isReapplication,
      ageConfirmed: application.ageConfirmed,
      mutualEventsCount: application.mutualEventsCount,
      moderatorNote: application.moderatorNote,
      declineReason: application.declineReason,
      promotedMemberId: application.promotedMemberId,
      decidedByMemberId: application.decidedByMemberId,
      submittedAt: application.submittedAt.toISOString(),
      decidedAt: application.decidedAt ? application.decidedAt.toISOString() : null,
      createdAt: application.createdAt.toISOString(),
    };
  }
}
