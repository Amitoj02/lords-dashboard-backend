import { ApiProperty } from '@nestjs/swagger';
import { ApplicantApplicationDto } from './applicant-application.dto';

/**
 * Response for GET /api/applications/mine (T-0054): the caller's current
 * application (their most recent one, or null if they have never applied) plus
 * whether an officer has blocked them from applying (T-0055). The frontend drives
 * the applicant status page + the reapply/apply affordances off these two fields.
 *
 * Wraps the applicant projection, not the staff one — this route is served to
 * the applicant themselves, so it must never carry review-only fields (T-0154).
 */
export class MyApplicationDto {
  @ApiProperty({
    type: ApplicantApplicationDto,
    nullable: true,
    description: 'The caller’s most recent application, or null if they have never applied.',
  })
  application: ApplicantApplicationDto | null;

  @ApiProperty({
    description:
      'True when an officer has permanently blocked this identity from submitting applications.',
  })
  blocked: boolean;
}
