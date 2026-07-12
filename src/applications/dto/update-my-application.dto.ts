import { PartialType } from '@nestjs/swagger';
import { CreateApplicationDto } from './create-application.dto';

/**
 * Body for PATCH /api/applications/mine — an applicant editing their own PENDING
 * application (T-0054). Every enlistment field is optional; only the provided
 * ones are updated. Same validation rules as intake (inherited from
 * CreateApplicationDto), so e.g. `interestConfirmed`, if sent, must still be
 * true.
 */
export class UpdateMyApplicationDto extends PartialType(CreateApplicationDto) {}
