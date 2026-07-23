import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PresignedUploadDto } from './dto/presigned-upload.dto';
import { RequestUploadDto } from './dto/request-upload.dto';
import { StoragePolicyDto } from './dto/storage-policy.dto';
import { StorageService } from './storage.service';

/**
 * Presigned upload API (T-0066). A single authenticated endpoint issues a
 * presigned PUT URL for a validated + authorized upload; the per-target
 * capability check lives in the service (targets require different capabilities,
 * so a single @RequireCapability would not fit). The bytes are PUT directly to
 * object storage by the client, never through the API.
 */
@ApiTags('storage')
@ApiBearerAuth('access-token')
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('uploads')
  // Presign minting is cheap to abuse (each ticket authorises a large PUT); cap it
  // well below the global bucket (LDA-H3/M12).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a presigned upload URL for a validated, authorized target' })
  @ApiCreatedResponse({ type: PresignedUploadDto })
  requestUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestUploadDto,
  ): Promise<PresignedUploadDto> {
    return this.storage.createUploadTicket(user, dto);
  }

  @Get('policy')
  @ApiOperation({
    summary: 'Get the per-target upload policy (size caps + accepted types) for client hints',
  })
  @ApiOkResponse({ type: StoragePolicyDto })
  getPolicy(): StoragePolicyDto {
    return this.storage.getPolicy();
  }
}
