import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RegimentSettings } from '../../regiments/entities/regiment-settings.entity';

/** Upper bound on the darkening scrim over a background image, in percent. */
export const OVERLAY_DENSITY_MAX = 100;
/** Length caps — these MUST match the column widths on `regiment_settings`. */
export const QUOTE_MAX_LENGTH = 500;
export const QUOTE_ATTRIBUTION_MAX_LENGTH = 120;
export const BANNER_URL_MAX_LENGTH = 512;

/**
 * The regiment's public presentation (T-0147): the landing and sign-in page
 * backgrounds, their pull-quotes, and the scrim density over each image.
 *
 * Every field is nullable, and null means "unset — render the shipped copy".
 * The SPA owns those defaults, which is what keeps a never-configured install
 * (and an install whose API call fails) from rendering a blank hero.
 */
export class PresentationDto {
  @ApiProperty({ nullable: true, description: 'Landing hero background image URL' })
  heroBannerUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Sign-in page background image URL' })
  loginBannerUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Landing charter pull-quote' })
  charterQuote: string | null;

  @ApiProperty({ nullable: true })
  charterQuoteAttribution: string | null;

  @ApiProperty({ nullable: true, description: 'Sign-in page pull-quote' })
  loginQuote: string | null;

  @ApiProperty({ nullable: true })
  loginQuoteAttribution: string | null;

  @ApiProperty({ nullable: true, description: 'Hero scrim opacity, 0-100 (percent)' })
  heroOverlayDensity: number | null;

  @ApiProperty({ nullable: true, description: 'Sign-in scrim opacity, 0-100 (percent)' })
  loginOverlayDensity: number | null;

  /**
   * Project the presentation slice of a settings row. A missing row (a regiment
   * provisioned before this feature, or mid-first-run) projects as all-null,
   * which the client reads as "shipped defaults" — never as an error.
   */
  static from(settings: RegimentSettings | null): PresentationDto {
    const dto = new PresentationDto();
    dto.heroBannerUrl = settings?.heroBannerUrl ?? null;
    dto.loginBannerUrl = settings?.loginBannerUrl ?? null;
    dto.charterQuote = settings?.charterQuote ?? null;
    dto.charterQuoteAttribution = settings?.charterQuoteAttribution ?? null;
    dto.loginQuote = settings?.loginQuote ?? null;
    dto.loginQuoteAttribution = settings?.loginQuoteAttribution ?? null;
    dto.heroOverlayDensity = settings?.heroOverlayDensity ?? null;
    dto.loginOverlayDensity = settings?.loginOverlayDensity ?? null;
    return dto;
  }
}

/**
 * Body for PATCH /api/settings/presentation. Every field is optional and only
 * the provided keys are applied. Passing `null` explicitly CLEARS a field back
 * to the shipped default — that is a deliberate, reachable state, so the
 * validators all allow null rather than only undefined.
 *
 * Banners are submitted as a storage KEY, never a URL, matching every other
 * upload in the app (member avatar, event banner, rank/medal icon). The service
 * runs the key through `StorageService.resolveKeyToPublicUrl`, which re-checks
 * that it really lives in this target's namespace — so a caller cannot pass, say,
 * a gallery key or another regiment's key and have it published as the hero.
 */
export class UpdatePresentationDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Storage key from a `regiment-hero-banner` presign; null clears the banner.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(BANNER_URL_MAX_LENGTH)
  heroBannerKey?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Storage key from a `regiment-login-banner` presign; null clears the banner.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(BANNER_URL_MAX_LENGTH)
  loginBannerKey?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: QUOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(QUOTE_MAX_LENGTH)
  charterQuote?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: QUOTE_ATTRIBUTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(QUOTE_ATTRIBUTION_MAX_LENGTH)
  charterQuoteAttribution?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: QUOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(QUOTE_MAX_LENGTH)
  loginQuote?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: QUOTE_ATTRIBUTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(QUOTE_ATTRIBUTION_MAX_LENGTH)
  loginQuoteAttribution?: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: OVERLAY_DENSITY_MAX })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OVERLAY_DENSITY_MAX)
  heroOverlayDensity?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: OVERLAY_DENSITY_MAX })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OVERLAY_DENSITY_MAX)
  loginOverlayDensity?: number | null;
}
