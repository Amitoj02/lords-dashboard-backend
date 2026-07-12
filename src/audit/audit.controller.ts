import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
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

  // Literal `export` route declared before `:id` so it is not captured as an id.
  @Get('export')
  @RequireCapability(Capability.ViewAuditLog)
  @ApiOperation({ summary: 'Export the filtered audit log as a CSV attachment' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV attachment of the filtered audit entries.' })
  async exportCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(await this.auditService.exportCsv(user.regimentId, query));
  }

  @Get(':id')
  @RequireCapability(Capability.ViewAuditLog)
  @ApiOperation({ summary: 'Get a single audit entry by id' })
  @ApiOkResponse({ description: 'The audit entry.', type: AuditLogEntryDto })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuditLogEntryDto> {
    return this.auditService.findOne(user.regimentId, id);
  }
}
