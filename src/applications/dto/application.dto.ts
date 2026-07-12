import { ApiProperty } from '@nestjs/swagger';
import { ApplicationStatus } from '../../common/enums';
import { Application } from '../entities/application.entity';

/**
 * Client-facing projection of a recruitment application (T-0039 enlistment
 * fields). Deliberately omits internal/PII columns (discordIdentityId,
 * discordDmMessage) — never expose the raw entity.
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

  @ApiProperty({ example: 'None' })
  currentRegiment: string;

  @ApiProperty({ description: 'Free-text "how did you hear about us?" answer' })
  howFound: string;

  @ApiProperty({ example: 'Line Infantry, Rifleman' })
  preferredClasses: string;

  @ApiProperty({ description: 'What the applicant wants to improve at' })
  skillsToImprove: string;

  @ApiProperty({ description: 'Confirms interest + willingness to enlist in-game' })
  interestConfirmed: boolean;

  @ApiProperty({ nullable: true, description: 'Optional representative/guest note' })
  representativeNote: string | null;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiProperty({ description: 'True when this identity has applied before' })
  isReapplication: boolean;

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
      currentRegiment: application.currentRegiment,
      howFound: application.howFound,
      preferredClasses: application.preferredClasses,
      skillsToImprove: application.skillsToImprove,
      interestConfirmed: application.interestConfirmed,
      representativeNote: application.representativeNote,
      status: application.status,
      isReapplication: application.isReapplication,
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
