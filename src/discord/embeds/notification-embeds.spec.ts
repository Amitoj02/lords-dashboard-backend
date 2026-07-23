import { EMBED_LIMITS } from './embed-limits';
import {
  EventSummary,
  RegimentBrand,
  brandColour,
  buildAuditEmbed,
  buildEnlistmentEmbed,
  buildEventEmbed,
  buildWelcomeEmbed,
  defaultDecisionMessage,
} from './notification-embeds';

const brand: RegimentBrand = {
  name: 'The Lords',
  accentTone: 'royal',
  bannerUrl: 'https://cdn.example.com/banner.png',
  crestUrl: 'https://cdn.example.com/crest.png',
};

const enlistment = {
  applicantName: 'Jane',
  inGameName: 'JaneG',
  currentRegiment: 'None',
  howFound: 'Discord',
  preferredClasses: 'Line',
  skillsToImprove: 'Melee',
  representativeNote: null,
};

const event: EventSummary = {
  title: 'Line Battle',
  description: 'Bring your muskets.',
  // 19:00Z is 15:00 in America/Toronto (EDT) on this date.
  startsAt: '2026-08-01T19:00:00.000Z',
  endsAt: '2026-08-01T21:30:00.000Z',
  timezone: 'America/Toronto',
  bannerUrl: 'https://cdn.example.com/event.png',
  eventType: 'One-off',
  rsvpCount: 7,
};

describe('notification embeds (T-0173 / T-0174 / T-0175)', () => {
  describe('brandColour', () => {
    it('maps the regiment accent tone, and falls back to brass for anything else', () => {
      expect(brandColour(brand)).toBe(0x3b5bdb);
      expect(brandColour({ ...brand, accentTone: 'not-a-tone' })).toBe(0xbf9447);
      expect(brandColour({ ...brand, accentTone: null })).toBe(0xbf9447);
    });
  });

  describe('enlistment', () => {
    it('truncates a very long free-text answer per FIELD without breaking the embed', () => {
      const embed = buildEnlistmentEmbed(
        { ...enlistment, skillsToImprove: 'x'.repeat(4000) },
        brand,
      );

      const value = embed.fields?.find((f) => f.name === 'Wants to improve')?.value ?? '';
      expect(value).toHaveLength(EMBED_LIMITS.fieldValue);
      expect(value.endsWith('…')).toBe(true);
      // The rest of the post survives intact — one long answer is not fatal.
      expect(embed.fields?.map((f) => f.name)).toContain('In-game name');
    });

    it('drops a non-http avatar rather than sending it', () => {
      const embed = buildEnlistmentEmbed(
        { ...enlistment, avatarUrl: 'javascript:alert(1)' },
        brand,
      );
      expect(embed.thumbnailUrl).toBeUndefined();
    });
  });

  describe('event', () => {
    it('renders the wall clock in the EVENT timezone, not the process locale', () => {
      const starts = buildEventEmbed(event, brand).fields?.find((f) => f.name === 'Starts')?.value;

      expect(starts).toContain('<t:1785610800:R>');
      expect(starts).toContain('15:00');
      expect(starts).toContain('Saturday 1 August 2026');
    });

    it('degrades an unknown IANA zone to UTC instead of throwing', () => {
      const starts = buildEventEmbed({ ...event, timezone: 'Mars/Olympus' }, brand).fields?.find(
        (f) => f.name === 'Starts',
      )?.value;

      expect(starts).toContain('19:00');
    });

    it('reports an open-ended event as such', () => {
      const embed = buildEventEmbed({ ...event, endsAt: null }, brand);
      expect(embed.fields?.find((f) => f.name === 'Duration')?.value).toBe('Open-ended');
    });

    it('computes the duration in hours and minutes', () => {
      const embed = buildEventEmbed(event, brand);
      expect(embed.fields?.find((f) => f.name === 'Duration')?.value).toBe('2h 30m');
    });

    it('frames a reminder explicitly, with its own colour and lead-time wording', () => {
      const announce = buildEventEmbed(event, brand);
      const day = buildEventEmbed(event, brand, { minutesBefore: 1440 });
      const quarter = buildEventEmbed(event, brand, { minutesBefore: 15 });

      expect(day.title).toBe('⏰ Reminder — Line Battle starts in 1 day');
      expect(quarter.title).toBe('⏰ Reminder — Line Battle starts in 15 minutes');
      expect(day.color).not.toBe(announce.color);
    });
  });

  describe('audit mirror', () => {
    it('stays compact: no thumbnail, no image, at most three fields', () => {
      const embed = buildAuditEmbed({
        action: 'member.ban',
        actorLabel: null,
        detail: null,
        severity: 'err',
        targetLabel: null,
      });

      expect(embed.thumbnailUrl).toBeUndefined();
      expect(embed.imageUrl).toBeUndefined();
      expect(embed.fields?.length).toBeLessThanOrEqual(3);
      // A missing actor label reads as "system", never as an empty field value.
      expect(embed.fields?.[0]).toEqual({ name: 'Actor', value: 'system', inline: true });
      expect(embed.color).toBe(0x8b2c2c);
    });
  });

  describe('welcome', () => {
    it('carries the regiment banner and a next-steps section', () => {
      const embed = buildWelcomeEmbed({ brand, message: 'Fall in!' });

      expect(embed.imageUrl).toBe('https://cdn.example.com/banner.png');
      expect(embed.fields?.[0].name).toBe('Next steps');
    });

    it('renders without a banner or crest when the regiment has neither', () => {
      const embed = buildWelcomeEmbed({
        brand: { ...brand, bannerUrl: null, crestUrl: null },
        message: 'Fall in!',
      });

      expect(embed.imageUrl).toBeUndefined();
      expect(embed.thumbnailUrl).toBeUndefined();
      expect(embed.title).toBe('Welcome to The Lords');
    });
  });

  describe('defaultDecisionMessage', () => {
    it('names the regiment in every outcome', () => {
      for (const outcome of ['approve', 'decline', 'hold'] as const) {
        expect(defaultDecisionMessage(outcome, 'The Lords')).toContain('The Lords');
      }
    });
  });
});
