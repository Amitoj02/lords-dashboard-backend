import { ApiProperty } from '@nestjs/swagger';
import { ApplicantType, ApplicationStatus } from '../../common/enums';
import { Application } from '../entities/application.entity';

/**
 * The applicant's view of their OWN application (T-0154). Deliberately a
 * separate class from {@link ApplicationDto} rather than a subset of it: the
 * staff projection grows over time (moderator notes, decline reasons, decider
 * attribution, review metrics), and anything added there would otherwise reach
 * the applicant by default. Here, a new staff field is invisible until someone
 * writes it into this mapper on purpose.
 *
 * The only decision text an applicant ever sees is {@link userMessage} — the
 * message the deciding officer actually wrote to them. `moderatorNote` and
 * `declineReason` are internal/audit-only and never appear here.
 */
export class ApplicantApplicationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Jane Doe' })
  applicantName: string;

  @ApiProperty({ nullable: true, example: '@janedoe' })
  discordTag: string | null;

  @ApiProperty({ example: 'JaneTheGreat' })
  inGameName: string;

  @ApiProperty({ enum: ApplicantType, description: 'Enlistment track (Member or Mercenary)' })
  applicantType: ApplicantType;

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

  @ApiProperty({
    nullable: true,
    description:
      'Why do you want to join the Lords Regiment? (null on applications predating T-0213)',
  })
  representativeNote: string | null;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiProperty({ description: 'True when this identity has applied before' })
  isReapplication: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'The message the deciding officer wrote to the applicant (also DM’d on Discord). ' +
      'Null when the decision used the default template or no decision has been taken.',
  })
  userMessage: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z', description: 'ISO submit timestamp' })
  submittedAt: string;

  @ApiProperty({ nullable: true, example: '2026-06-22T19:00:00.000Z' })
  decidedAt: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  createdAt: string;

  /**
   * Map an Application entity to the applicant-safe projection. Reads only
   * columns on the row itself, so it is safe to call on an application loaded
   * without any relations (which is how the self-service queries load them).
   */
  static from(application: Application): ApplicantApplicationDto {
    return {
      id: application.id,
      applicantName: application.applicantName,
      discordTag: application.discordTag,
      inGameName: application.inGameName,
      applicantType: application.applicantType,
      currentRegiment: application.currentRegiment,
      howFound: application.howFound,
      preferredClasses: application.preferredClasses,
      skillsToImprove: application.skillsToImprove,
      interestConfirmed: application.interestConfirmed,
      representativeNote: application.representativeNote,
      status: application.status,
      isReapplication: application.isReapplication,
      userMessage: application.discordDmMessage,
      submittedAt: application.submittedAt.toISOString(),
      decidedAt: application.decidedAt ? application.decidedAt.toISOString() : null,
      createdAt: application.createdAt.toISOString(),
    };
  }
}
