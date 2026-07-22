import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RegimentDocumentSlug } from '../../common/enums';
import { RegimentDocument } from '../../regiments/entities/regiment-document.entity';

/**
 * Body cap for a legal document. Generous enough for a real privacy policy,
 * bounded so a single row cannot be used to fill the database. Well under the
 * MEDIUMTEXT column's 16MB ceiling.
 */
export const DOCUMENT_MAX_LENGTH = 60_000;

/**
 * One admin-authored legal document (T-0149). `body` is Markdown; it is never
 * HTML, and the SPA renders it through an escape-first renderer, so nothing an
 * author types can execute on the public page.
 *
 * `body: null` means "never edited" — the client renders its shipped fallback
 * copy. That is a normal state, not an error: production is legally required to
 * serve a privacy policy, so an empty document must still render a real page.
 */
export class RegimentDocumentDto {
  @ApiProperty({ enum: RegimentDocumentSlug })
  slug: RegimentDocumentSlug;

  @ApiProperty({ nullable: true, description: 'Markdown source; null when never edited' })
  body: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp of the last edit' })
  updatedAt: string | null;

  static from(slug: RegimentDocumentSlug, doc: RegimentDocument | null): RegimentDocumentDto {
    const dto = new RegimentDocumentDto();
    dto.slug = slug;
    // Treat whitespace-only as unset so a cleared editor falls back to the
    // shipped copy instead of publishing a blank legal page.
    dto.body = doc?.body && doc.body.trim().length > 0 ? doc.body : null;
    dto.updatedAt = dto.body !== null && doc?.updatedAt ? doc.updatedAt.toISOString() : null;
    return dto;
  }
}

/**
 * The staff view of a document — the public projection plus who last saved it.
 * The author's name is deliberately absent from the anonymous projection.
 */
export class AdminRegimentDocumentDto extends RegimentDocumentDto {
  @ApiProperty({ nullable: true, description: 'Display name of the last editor' })
  updatedByName: string | null;

  static fromAdmin(
    slug: RegimentDocumentSlug,
    doc: RegimentDocument | null,
  ): AdminRegimentDocumentDto {
    const dto = Object.assign(new AdminRegimentDocumentDto(), RegimentDocumentDto.from(slug, doc));
    // Degrades to null rather than 500ing when the author's member row was
    // removed (the FK is ON DELETE SET NULL).
    dto.updatedByName = doc?.updatedByMember?.inGameName ?? null;
    return dto;
  }
}

/** Body for PUT /api/settings/documents/:slug. */
export class UpdateRegimentDocumentDto {
  @ApiProperty({
    nullable: true,
    maxLength: DOCUMENT_MAX_LENGTH,
    description:
      'Markdown source. Null or blank clears the document back to the shipped fallback copy.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(DOCUMENT_MAX_LENGTH)
  body?: string | null;
}
