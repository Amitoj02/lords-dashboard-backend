import { DiscordEmbed } from '../gateway/discord-gateway';
import { EMBED_LIMITS, clampEmbed, truncate } from './embed-limits';

describe('embed limits (T-0172)', () => {
  describe('truncate', () => {
    it('leaves a value at exactly the limit untouched', () => {
      const value = 'x'.repeat(10);
      expect(truncate(value, 10)).toBe(value);
    });

    it('keeps the ellipsis INSIDE the budget, never on top of it', () => {
      // The classic bug: `slice(0, max) + '…'` is max + 1 characters and still
      // fails Discord's validation.
      const out = truncate('x'.repeat(50), 10);
      expect(out).toHaveLength(10);
      expect(out.endsWith('…')).toBe(true);
    });

    it('degrades rather than throwing at an absurdly small budget', () => {
      expect(truncate('hello', 1)).toBe('…');
      expect(truncate('hello', 0)).toBe('');
    });
  });

  describe('clampEmbed', () => {
    // Each part is exercised on its own so the per-part pass is not confused
    // with the whole-embed 6000-character pass (which runs after it).
    it.each([
      ['title', { title: 'T'.repeat(400) }, (e: DiscordEmbed) => e.title, EMBED_LIMITS.title],
      [
        'description',
        { description: 'D'.repeat(5000) },
        (e: DiscordEmbed) => e.description,
        EMBED_LIMITS.description,
      ],
      [
        'footer',
        { footer: { text: 'F'.repeat(3000) } },
        (e: DiscordEmbed) => e.footer?.text,
        EMBED_LIMITS.footerText,
      ],
      [
        'author',
        { author: { name: 'A'.repeat(400) } },
        (e: DiscordEmbed) => e.author?.name,
        EMBED_LIMITS.authorName,
      ],
      [
        'field name',
        { fields: [{ name: 'N'.repeat(400), value: 'v' }] },
        (e: DiscordEmbed) => e.fields?.[0].name,
        EMBED_LIMITS.fieldName,
      ],
      [
        'field value',
        { fields: [{ name: 'n', value: 'V'.repeat(2000) }] },
        (e: DiscordEmbed) => e.fields?.[0].value,
        EMBED_LIMITS.fieldValue,
      ],
    ])('clamps %s to its own Discord limit', (_label, input, read, limit) => {
      expect(read(clampEmbed(input as DiscordEmbed))).toHaveLength(limit);
    });

    it('collapses fields past the 25th into ONE visible marker', () => {
      const fields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: 'v' }));

      const clamped = clampEmbed({ fields });

      expect(clamped.fields).toHaveLength(EMBED_LIMITS.fields);
      expect(clamped.fields?.[EMBED_LIMITS.fields - 1]).toEqual({
        name: '…',
        value: '16 more fields omitted',
      });
    });

    it('never mutates its input', () => {
      const input: DiscordEmbed = { title: 'T'.repeat(400), fields: [{ name: 'n', value: 'v' }] };

      clampEmbed(input);

      expect(input.title).toHaveLength(400);
      expect(input.fields).toHaveLength(1);
    });

    it('shaves the description before it sacrifices a field', () => {
      const clamped = clampEmbed({
        title: 'Title',
        description: 'D'.repeat(4096),
        fields: Array.from({ length: 3 }, (_, i) => ({ name: `n${i}`, value: 'V'.repeat(1024) })),
      });

      expect(clamped.fields).toHaveLength(3);
      expect((clamped.description ?? '').length).toBeLessThan(4096);
      expect(total(clamped)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    });

    it('drops trailing fields once the description cannot absorb the overflow', () => {
      const clamped = clampEmbed({
        title: 'Title',
        fields: Array.from({ length: 25 }, (_, i) => ({
          name: `n${i}`,
          value: 'V'.repeat(1024),
        })),
      });

      expect(total(clamped)).toBeLessThanOrEqual(EMBED_LIMITS.total);
      expect((clamped.fields ?? []).length).toBeLessThan(25);
      // The identifying part is preserved — a field is what gets sacrificed.
      expect(clamped.title).toBe('Title');
    });

    it('passes an already-legal embed through unchanged', () => {
      const embed: DiscordEmbed = {
        title: 'Fine',
        description: 'Short',
        fields: [{ name: 'a', value: 'b', inline: true }],
        footer: { text: 'f' },
      };

      expect(clampEmbed(embed)).toEqual(embed);
    });
  });
});

/** The same sum Discord applies to the 6000-character whole-embed budget. */
function total(embed: DiscordEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}
