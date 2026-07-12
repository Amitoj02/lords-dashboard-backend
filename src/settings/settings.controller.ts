import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { Capability } from '../common/enums';
import { PermissionsMatrixDto } from './dto/permissions-matrix.dto';
import { SettingsDto } from './dto/settings.dto';
import { DissolveDto, TransferDiscordDto, TransferOwnershipDto } from './dto/settings-actions.dto';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

/**
 * Regiment control panel. Every route requires ManageSettings except ownership
 * transfer and dissolution, which are gated on the stronger TransferOwnership
 * capability. All routes are auth-guarded globally and scoped to the caller's
 * regiment; the service audits every mutation.
 */
@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Get the regiment profile + settings panel' })
  @ApiOkResponse({ type: SettingsDto })
  get(@CurrentUser() user: AuthenticatedUser): Promise<SettingsDto> {
    return this.settingsService.get(user);
  }

  @Patch()
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Update the regiment profile and/or settings (partial)' })
  @ApiOkResponse({ type: SettingsDto })
  update(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<SettingsDto> {
    return this.settingsService.update(user, dto, req.ip ?? null);
  }

  @Post('complete-setup')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Mark first-run setup complete (stops first-run routing)' })
  @ApiOkResponse({ type: SettingsDto })
  completeSetup(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<SettingsDto> {
    return this.settingsService.completeSetup(user, req.ip ?? null);
  }

  @Get('permissions')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Get the authorization matrix (capability × role)' })
  @ApiOkResponse({ type: PermissionsMatrixDto })
  getPermissions(@CurrentUser() user: AuthenticatedUser): Promise<PermissionsMatrixDto> {
    return this.settingsService.getPermissions(user);
  }

  @Patch('permissions')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Edit the authorization matrix (governance floor enforced)' })
  @ApiOkResponse({ type: PermissionsMatrixDto })
  updatePermissions(
    @Body() dto: UpdatePermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<PermissionsMatrixDto> {
    return this.settingsService.updatePermissions(user, dto, req.ip ?? null);
  }

  @Post('transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.TransferOwnership)
  @ApiOperation({ summary: 'Transfer regiment ownership to another member' })
  @ApiOkResponse({ description: 'The new owner member id' })
  transferOwnership(
    @Body() dto: TransferOwnershipDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ ownerMemberId: string }> {
    return this.settingsService.transferOwnership(user, dto, req.ip ?? null);
  }

  @Post('transfer-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: "Rebind the regiment's Discord guild" })
  @ApiOkResponse({ description: 'The updated Discord binding' })
  transferDiscord(
    @Body() dto: TransferDiscordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ discordServerId: string | null; discordServerName: string | null }> {
    return this.settingsService.transferDiscord(user, dto, req.ip ?? null);
  }

  @Post('dissolve')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.TransferOwnership)
  @ApiOperation({ summary: 'Dissolve (soft-delete) the regiment — destructive' })
  @ApiOkResponse({ description: 'Confirmation the regiment was dissolved' })
  dissolve(
    @Body() dto: DissolveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ dissolved: true }> {
    return this.settingsService.dissolve(user, dto.confirmName, req.ip ?? null);
  }
}
