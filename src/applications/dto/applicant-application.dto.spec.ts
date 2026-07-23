import { ApplicantType, ApplicationStatus } from '../../common/enums';
import { Application } from '../entities/application.entity';
import { ApplicantApplicationDto } from './applicant-application.dto';

/**
 * A fully-populated application, including every staff-only column, so the
 * projection is exercised against a row that HAS something to leak.
 */
const decidedApplication = (): Application => ({
  id: 'app-1',
  regimentId: 'regiment-1',
  discordIdentityId: 'identity-applicant',
  promotedMemberId: 'member-new',
  decidedByMemberId: 'member-staff',
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
  status: ApplicationStatus.Declined,
  isReapplication: false,
  discordInServer: true,
  mutualEventsCount: 4,
  moderatorNote: 'Smurfing on an alt, do not enlist',
  discordDmMessage: 'Thanks for applying - try again after 50 more hours.',
  declineReason: 'Too few hours',
  isDraft: false,
  submittedAt: new Date('2026-06-22T18:00:00.000Z'),
  decidedAt: new Date('2026-06-22T19:00:00.000Z'),
  createdAt: new Date('2026-06-22T18:00:00.000Z'),
  updatedAt: new Date('2026-06-22T19:00:00.000Z'),
});

describe('ApplicantApplicationDto', () => {
  it('exposes exactly this field list — a new column must never leak by default', () => {
    // The field-list pin (T-0154). This projection is the applicant's view of
    // their own application, so an unreviewed addition here is a disclosure, not
    // a cosmetic change. Adding a key means deciding, in review, that applicants
    // may read it — hence the exact-match assertion rather than a spot check.
    expect(Object.keys(ApplicantApplicationDto.from(decidedApplication())).sort()).toEqual([
      'applicantName',
      'applicantType',
      'createdAt',
      'currentRegiment',
      'decidedAt',
      'discordTag',
      'howFound',
      'id',
      'inGameName',
      'interestConfirmed',
      'isReapplication',
      'preferredClasses',
      'representativeNote',
      'skillsToImprove',
      'status',
      'submittedAt',
      'userMessage',
    ]);
  });

  it('withholds the review-only fields even on a fully decided application', () => {
    const dto = ApplicantApplicationDto.from(decidedApplication());

    // Named individually so a regression points straight at what was disclosed.
    expect(dto).not.toHaveProperty('moderatorNote');
    expect(dto).not.toHaveProperty('declineReason');
    expect(dto).not.toHaveProperty('decidedByMemberId');
    expect(dto).not.toHaveProperty('decidedByName');
    expect(dto).not.toHaveProperty('mutualEventsCount');
    expect(dto).not.toHaveProperty('discordIdentityId');
    // The wire name for the persisted message: the raw column name stays hidden.
    expect(dto).not.toHaveProperty('discordDmMessage');
  });

  it('surfaces the persisted decision message as the applicant-facing userMessage', () => {
    // The only decision text an applicant ever reads (T-0154).
    const dto = ApplicantApplicationDto.from(decidedApplication());
    expect(dto.userMessage).toBe('Thanks for applying - try again after 50 more hours.');
  });
});
