import { ApiProperty } from '@nestjs/swagger';
import { RoleRelinkBatchState } from '../../common/enums';
import { RoleRelinkSubject } from '../discord-sync.service';

/**
 * Why a run's failures happened, split by the CLASS of Discord error, so a role
 * hierarchy problem is diagnosable from the progress poll alone.
 */
export class RoleRelinkFailuresDto {
  @ApiProperty({
    description:
      'Failed on the first attempt with a permanent Discord error (deleted role, bot below the target role, missing access) — retrying cannot fix these.',
  })
  permanent: number;

  @ApiProperty({ description: 'Failed after burning every retry attempt.' })
  exhausted: number;

  @ApiProperty({ description: 'Failed at least once and is still in retry backoff.' })
  retrying: number;

  @ApiProperty({
    type: [String],
    description: 'A few distinct error messages, enough to identify the cause.',
  })
  samples: string[];
}

/**
 * Live progress (or the terminal summary) of one bulk re-link batch. Every count
 * is derived from the job rows grouped by `batchId`, never from in-process
 * state, so an API restart mid-run does not lose the run — and so every open
 * admin tab polling this endpoint sees the same numbers.
 */
export class RoleRelinkProgressDto {
  @ApiProperty() batchId: string;
  @ApiProperty({ enum: RoleRelinkBatchState }) state: RoleRelinkBatchState;
  @ApiProperty({ enum: ['rank', 'medal'] }) subject: RoleRelinkSubject;
  @ApiProperty({ nullable: true }) subjectLabel: string | null;
  @ApiProperty({ nullable: true, description: 'The role being stripped from holders.' })
  outgoingRoleId: string | null;
  @ApiProperty({ nullable: true, description: 'The role being applied to holders.' })
  incomingRoleId: string | null;

  @ApiProperty({ description: 'More pages of members are still being fanned out.' })
  expanding: boolean;

  @ApiProperty({ description: 'Per-member jobs created so far (grows while expanding).' })
  total: number;
  @ApiProperty() applied: number;
  @ApiProperty() pending: number;
  @ApiProperty() failed: number;
  @ApiProperty({ description: 'Per-member jobs dropped by a cancel (never applied).' })
  cancelled: number;

  @ApiProperty({ type: RoleRelinkFailuresDto }) failures: RoleRelinkFailuresDto;

  @ApiProperty() startedAt: string;
  @ApiProperty({ nullable: true, description: 'Set once the run reached a terminal state.' })
  finishedAt: string | null;
}
