import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditLogEntryDto } from './dto/audit-log-entry.dto';

@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequireCapability(Capability.ViewAuditLog)
  @ApiOperation({ summary: 'Read the audit log (Owner + Admin only)' })
  @ApiOkResponse({ description: 'Paginated audit entries, most recent first.' })
  find(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogEntryDto>> {
    return this.auditService.findEntries(user.regimentId, query);
  }
}
