import { DiscordEmbed, DiscordEmbedField } from '../gateway/discord-gateway';

/**
 * Discord's REAL embed limits (T-0172). These are NOT the 2000-character
 * message-content cap the pre-embed composers used — an embed is validated
 * per-part, and a single over-long field value fails the whole message with
 * `50035 Invalid Form Body`.
 *
 * @see https://discord.com/developers/docs/resources/message#embed-object-embed-limits
 */
export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footerText: 2048,
  authorName: 256,
  /** Sum of title + description + every field name/value + footer + author. */
  total: 6000,
} as const;

/** Appended wherever text was cut, so a reader can SEE something was dropped. */
const ELLIPSIS = '…';

/**
 * Cut `value` to `max` characters, ending in an ellipsis when anything was
 * removed. The ellipsis is inside the budget, never added on top of it — that
 * is the bug that makes "truncate to the limit" helpers still fail validation.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, max);
  return `${value.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** The characters Discord counts towards the 6000-character whole-embed budget. */
function totalLength(embed: DiscordEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

/**
 * TRUNCATE AT COMPOSE TIME (T-0172). An outbox job is retried five times and
 * then fails permanently; an embed that is too big is rejected by Discord on
 * every single attempt, so the message is simply lost and an admin gets a
 * resolvable operation they can do nothing about. Clamping here turns "fails
 * forever" into "delivers, visibly shortened", which is always the better
 * outcome for a notification.
 *
 * The order of the passes matters and is chosen so the most identifying parts
 * survive:
 *   1. every part is clamped to its own limit;
 *   2. fields beyond the 25th are collapsed into ONE visible marker field, so
 *      the reader knows content was dropped rather than silently seeing 25;
 *   3. if the whole embed still exceeds 6000, the description is shaved first
 *      (it is the most compressible part), then trailing FIELDS are dropped —
 *      the title, author and footer, which say what the message IS, are never
 *      sacrificed for a field.
 *
 * Pure and total: it never throws and never mutates its input.
 */
export function clampEmbed(embed: DiscordEmbed): DiscordEmbed {
  const clamped: DiscordEmbed = { ...embed };

  if (clamped.title !== undefined) clamped.title = truncate(clamped.title, EMBED_LIMITS.title);
  if (clamped.description !== undefined) {
    clamped.description = truncate(clamped.description, EMBED_LIMITS.description);
  }
  if (clamped.footer) {
    clamped.footer = {
      ...clamped.footer,
      text: truncate(clamped.footer.text, EMBED_LIMITS.footerText),
    };
  }
  if (clamped.author) {
    clamped.author = {
      ...clamped.author,
      name: truncate(clamped.author.name, EMBED_LIMITS.authorName),
    };
  }

  if (clamped.fields) {
    let fields: DiscordEmbedField[] = clamped.fields.map((f) => ({
      ...f,
      name: truncate(f.name, EMBED_LIMITS.fieldName),
      value: truncate(f.value, EMBED_LIMITS.fieldValue),
    }));
    if (fields.length > EMBED_LIMITS.fields) {
      const dropped = fields.length - (EMBED_LIMITS.fields - 1);
      fields = [
        ...fields.slice(0, EMBED_LIMITS.fields - 1),
        { name: ELLIPSIS, value: `${dropped} more field${dropped === 1 ? '' : 's'} omitted` },
      ];
    }
    clamped.fields = fields;
  }

  // Whole-embed budget. Shave the description first, then drop trailing fields.
  let over = totalLength(clamped) - EMBED_LIMITS.total;
  if (over > 0 && clamped.description) {
    const keep = Math.max(0, clamped.description.length - over);
    clamped.description = keep === 0 ? undefined : truncate(clamped.description, keep);
    over = totalLength(clamped) - EMBED_LIMITS.total;
  }
  while (over > 0 && clamped.fields && clamped.fields.length > 0) {
    clamped.fields = clamped.fields.slice(0, -1);
    over = totalLength(clamped) - EMBED_LIMITS.total;
  }
  if (clamped.fields?.length === 0) delete clamped.fields;

  return clamped;
}
