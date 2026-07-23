import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { Capability, MemberRole, RegimentDocumentSlug } from '../common/enums';
import { PermissionsMatrixDto } from './dto/permissions-matrix.dto';
import { PresentationDto, UpdatePresentationDto } from './dto/presentation.dto';
import { AdminRegimentDocumentDto, UpdateRegimentDocumentDto } from './dto/regiment-document.dto';
import { SettingsDto } from './dto/settings.dto';
import { DissolveDto } from './dto/settings-actions.dto';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

/**
 * Regiment control panel. Most routes require ManageSettings; dissolution is
 * gated on the Owner ROLE rather than a capability (T-0170), and the
 * public-presentation + legal-document routes on ManageRegimentDetails (T-0145)
 * so publishing rights can be delegated without handing over the regiment. All
 * routes are auth-guarded globally and scoped to the caller's regiment; the
 * service audits every mutation.
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

  // ── Public presentation + legal documents (T-0147 / T-0149) ────────────────
  // Gated on ManageRegimentDetails rather than ManageSettings. The split is the
  // point of the feature: whoever writes the public copy needs neither the
  // permission matrix nor the Discord binding, and a ManageSettings holder does
  // not implicitly gain the right to rewrite the privacy policy.

  @Get('presentation')
  @RequireCapability(Capability.ManageRegimentDetails)
  @ApiOperation({ summary: 'Get the landing/login presentation settings' })
  @ApiOkResponse({ type: PresentationDto })
  getPresentation(@CurrentUser() user: AuthenticatedUser): Promise<PresentationDto> {
    return this.settingsService.getPresentation(user);
  }

  @Patch('presentation')
  @RequireCapability(Capability.ManageRegimentDetails)
  @ApiOperation({ summary: 'Update the landing/login presentation settings (partial)' })
  @ApiOkResponse({ type: PresentationDto })
  updatePresentation(
    @Body() dto: UpdatePresentationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<PresentationDto> {
    return this.settingsService.updatePresentation(user, dto, req.ip ?? null);
  }

  @Get('documents')
  @RequireCapability(Capability.ManageRegimentDetails)
  @ApiOperation({ summary: 'Get the editable legal documents, with edit attribution' })
  @ApiOkResponse({ type: [AdminRegimentDocumentDto] })
  getDocuments(@CurrentUser() user: AuthenticatedUser): Promise<AdminRegimentDocumentDto[]> {
    return this.settingsService.getDocuments(user);
  }

  @Put('documents/:slug')
  @RequireCapability(Capability.ManageRegimentDetails)
  @ApiOperation({ summary: 'Replace one legal document (Markdown)' })
  @ApiParam({ name: 'slug', enum: RegimentDocumentSlug })
  @ApiOkResponse({ type: AdminRegimentDocumentDto })
  updateDocument(
    @Param('slug', new ParseEnumPipe(RegimentDocumentSlug)) slug: RegimentDocumentSlug,
    @Body() dto: UpdateRegimentDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<AdminRegimentDocumentDto> {
    return this.settingsService.updateDocument(user, slug, dto, req.ip ?? null);
  }

  // Dissolution is the single most destructive action in the app, and it is
  // deliberately NOT capability-gated (T-0170): every capability — including
  // manage_settings — is delegable from the permission matrix, so a capability
  // gate could be handed to anyone. Tying it to the Owner ROLE keeps it with
  // the one seat that cannot be granted through the matrix.
  @Post('dissolve')
  @HttpCode(HttpStatus.OK)
  @RequireRole(MemberRole.Owner)
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
