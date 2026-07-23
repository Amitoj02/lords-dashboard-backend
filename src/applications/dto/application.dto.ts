import { ApiProperty } from '@nestjs/swagger';
import { ApplicantType, ApplicationStatus } from '../../common/enums';
import { Application } from '../entities/application.entity';

/**
 * STAFF-facing projection of a recruitment application (T-0039 enlistment
 * fields). Deliberately omits internal/PII columns (discordIdentityId) — never
 * expose the raw entity. Carries the review-only fields (moderatorNote,
 * declineReason, decider attribution); what the APPLICANT may see is the
 * separate {@link ApplicantApplicationDto} (T-0154).
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

  @ApiProperty({
    nullable: true,
    description:
      'The message the deciding officer wrote to the applicant (also DM’d on Discord). ' +
      'Null when the decision used the default template or no decision has been taken.',
  })
  userMessage: string | null;

  @ApiProperty({ nullable: true, description: 'Member id created on approval' })
  promotedMemberId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "The applicant's current display name — the promoted member's in-game name once approved, " +
      'else the linked Discord global name; null when neither is known. Reflects post-approval renames.',
  })
  currentDisplayName: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "The applicant's current avatar URL — the promoted member's avatar once approved, else the " +
      'linked Discord avatar; null when neither is set. Reflects post-approval avatar changes.',
  })
  currentAvatarUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Member id of the staffer who decided' })
  decidedByMemberId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'In-game name of the staffer who decided; null while pending and when their member row is gone.',
  })
  decidedByName: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Avatar URL of the staffer who decided — their uploaded avatar, else their linked ' +
      'Discord avatar; null when unknown or neither is set.',
  })
  decidedByAvatarUrl: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z', description: 'ISO submit timestamp' })
  submittedAt: string;

  @ApiProperty({ nullable: true, example: '2026-06-22T19:00:00.000Z' })
  decidedAt: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  createdAt: string;

  @ApiProperty({
    description: 'Whether the applicant’s Discord identity is blocked from applying',
  })
  blocked: boolean;

  /**
   * Map an Application entity to its safe client projection. `blocked` reflects
   * whether the applicant's Discord identity is barred from applying (T-0128):
   * when omitted it is derived from the loaded `discordIdentity` relation, so the
   * admin queue/detail must load that relation; callers that mutate the block
   * state (unblock) pass it explicitly to avoid a stale read.
   *
   * `currentDisplayName`/`currentAvatarUrl` carry the applicant's LIVE identity
   * (T-0129): the promoted member's in-game name + avatar once approved (so
   * post-approval profile edits are reflected), falling back to the linked
   * Discord identity's global name + avatar, else null. Resolving the member
   * needs the `promotedMember` relation loaded; the queue/detail queries eager-
   * load it. Callers that don't load it (self-service views) get the Discord
   * fallback (or null), which is fine — those views don't surface live identity.
   *
   * `decidedByName`/`decidedByAvatarUrl` need the `decidedByMember` relation
   * loaded (T-0155). The FK is ON DELETE SET NULL and a decider can also be
   * deleted from the roster, so a missing relation degrades to null attribution
   * rather than failing the read. The avatar falls back to the decider's LINKED
   * DISCORD avatar (T-0186), matching {@link MemberDto} and the applicant's own
   * `currentAvatarUrl` above: `members.avatar_url` only holds an UPLOADED
   * avatar, so reading it alone left almost every officer's chip showing bare
   * initials while the same person's face rendered everywhere else. That needs
   * the nested `decidedByMember.discordIdentity` relation loaded too.
   */
  static from(application: Application, blocked?: boolean): ApplicationDto {
    const member = application.promotedMember;
    const identity = application.discordIdentity;
    const decidedBy = application.decidedByMember;
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
      mutualEventsCount: application.mutualEventsCount,
      moderatorNote: application.moderatorNote,
      declineReason: application.declineReason,
      userMessage: application.discordDmMessage,
      promotedMemberId: application.promotedMemberId,
      currentDisplayName: member?.inGameName ?? identity?.globalName ?? null,
      currentAvatarUrl: member?.avatarUrl ?? identity?.avatarUrl ?? null,
      decidedByMemberId: application.decidedByMemberId,
      decidedByName: decidedBy?.inGameName ?? null,
      decidedByAvatarUrl: decidedBy?.avatarUrl ?? decidedBy?.discordIdentity?.avatarUrl ?? null,
      submittedAt: application.submittedAt.toISOString(),
      decidedAt: application.decidedAt ? application.decidedAt.toISOString() : null,
      createdAt: application.createdAt.toISOString(),
      blocked: blocked ?? !!application.discordIdentity?.applicationsBlockedAt,
    };
  }
}
