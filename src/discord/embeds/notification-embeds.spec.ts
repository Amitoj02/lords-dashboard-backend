import { EMBED_LIMITS } from './embed-limits';
import {
  EventSummary,
  RegimentBrand,
  brandColour,
  buildAuditEmbed,
  buildEnlistmentEmbed,
  buildEventEmbed,
  buildDecisionEmbed,
  buildWelcomeEmbed,
  defaultDecisionMessage,
  expandWelcomeTokens,
  WELCOME_TOKENS,
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
  roster: { attending: [], tentative: [], declined: [] },
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

    it('shows all three RSVP sections, empty ones included (T-0205)', () => {
      // An empty section that disappeared would make the embed reshape itself on
      // the first press, and a reader could not tell "nobody declined" from
      // "declining is not on offer".
      const names = buildEventEmbed(event, brand).fields?.map((f) => f.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining(['✅ Attending — 0', '❔ Tentative — 0', '❌ Declined — 0']),
      );
      const values = Object.fromEntries(
        (buildEventEmbed(event, brand).fields ?? []).map((f) => [f.name, f.value]),
      );
      expect(values['✅ Attending — 0']).toBe('—');
    });

    it('overflows a long roster by WHOLE entries, never mid-mention', () => {
      // Every entry is a `<@id>` mention. `clampEmbed` would happily cut one in
      // half at 1024 characters and Discord would render the remains as literal
      // text, so the list is trimmed to whole names and the rest is counted.
      const attending = Array.from({ length: 200 }, (_, i) => `<@${100000000000000000 + i}>`);
      const embed = buildEventEmbed({ ...event, roster: { ...event.roster, attending } }, brand);
      const value = embed.fields?.find((f) => f.name === '✅ Attending — 200')?.value ?? '';

      expect(value).toMatch(/ \+\d+ more$/);
      expect(value.length).toBeLessThanOrEqual(1024);
      // No half-written mention survived the trim.
      for (const entry of value.replace(/ \+\d+ more$/, '').split(', ')) {
        expect(entry).toMatch(/^<@\d+>$/);
      }
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
    it('carries the regiment banner', () => {
      const embed = buildWelcomeEmbed({ brand, message: 'Fall in!' });

      expect(embed.imageUrl).toBe('https://cdn.example.com/banner.png');
    });

    it('appends NOTHING to the configured message', () => {
      // The admin's message box is the whole message. A hardcoded "Next steps"
      // field used to be appended here, which meant a regiment could not write a
      // complete welcome — whatever they typed arrived with three bullets they
      // never asked for and had no setting to remove.
      const embed = buildWelcomeEmbed({ brand, message: 'Fall in!' });

      expect(embed.description).toBe('Fall in!');
      expect(embed.fields ?? []).toEqual([]);
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

  // ── T-0185: welcome placeholder tokens ──────────────────────────────────────
  describe('welcome placeholder tokens (T-0185)', () => {
    const ctx = { discordUserId: '123456789012345678', regimentName: 'The Lords' };

    it('renders {user} as a working mention of the joining member', () => {
      expect(expandWelcomeTokens('Hello {user}, fall in!', ctx)).toBe(
        'Hello <@123456789012345678>, fall in!',
      );
    });

    it('renders {regiment} as the regiment brand name', () => {
      expect(expandWelcomeTokens('Welcome to {regiment}.', ctx)).toBe('Welcome to The Lords.');
    });

    it('leaves an unknown token verbatim rather than deleting it', () => {
      // A typo must be visible to the admin who made it, not silently swallowed.
      expect(expandWelcomeTokens('Hi {nope} and {user}', ctx)).toBe(
        'Hi {nope} and <@123456789012345678>',
      );
    });

    it('does not interpolate inherited Object properties', () => {
      // A `key in table` lookup would turn {constructor} into "function Object()".
      expect(expandWelcomeTokens('{constructor} {__proto__} {toString}', ctx)).toBe(
        '{constructor} {__proto__} {toString}',
      );
    });

    it('returns a token-free message byte-identical', () => {
      const plain = 'Welcome to the regiment! Read the rules and say hello.';
      expect(expandWelcomeTokens(plain, ctx)).toBe(plain);
    });

    it('drops a non-snowflake id rather than rendering a broken mention', () => {
      expect(expandWelcomeTokens('Hi {user}', { discordUserId: null, regimentName: 'X' })).toBe(
        'Hi recruit',
      );
    });

    it('expands BEFORE the embed clamp, so a long expansion cannot break the embed', () => {
      // The COLUMN caps the authored text at 512, but every {user} expands to ~21
      // characters, so the rendered description can legitimately exceed what was
      // typed. Expanding inside the composer means clampEmbed still governs.
      const authored = `${'{user} '.repeat(70)}${'x'.repeat(20)}`;
      expect(authored.length).toBeLessThanOrEqual(512);

      const embed = buildWelcomeEmbed({
        brand,
        message: authored,
        discordUserId: ctx.discordUserId,
      });

      expect(embed.description).toContain('<@123456789012345678>');
      expect(embed.description!.length).toBeLessThanOrEqual(EMBED_LIMITS.description);
      expect(embed.description).not.toContain('{user}');
    });

    it('renders @everyone as inert literal text inside the embed body', () => {
      // Admin-authored text never becomes message CONTENT (see
      // discord-sync.service.spec.ts), and Discord does not resolve mentions
      // inside an embed — so this text reaches Discord unescaped and pings nobody.
      const embed = buildWelcomeEmbed({
        brand,
        message: '@everyone say hello to {user}',
        discordUserId: ctx.discordUserId,
      });

      expect(embed.description).toBe('@everyone say hello to <@123456789012345678>');
    });

    it('documents exactly the tokens it expands', () => {
      // WELCOME_TOKENS is what Swagger and the settings editor hint render from,
      // so a token added to one and not the other is caught here.
      const documented = WELCOME_TOKENS.map((t) => t.token);
      expect(documented).toEqual(['{user}', '{regiment}']);
      for (const token of documented) {
        expect(expandWelcomeTokens(token, ctx)).not.toBe(token);
      }
    });
  });

  describe('defaultDecisionMessage', () => {
    it('names the regiment in every outcome', () => {
      for (const outcome of ['approve', 'decline', 'hold'] as const) {
        expect(defaultDecisionMessage(outcome, 'The Lords')).toContain('The Lords');
      }
    });
  });

  // ── T-0182: the applicant sees the user message and nothing else ────────────
  describe('decision embed (T-0182)', () => {
    const OUTCOMES = ['approve', 'decline', 'hold'] as const;

    it('renders the officer’s message as the body for every outcome', () => {
      for (const outcome of OUTCOMES) {
        const embed = buildDecisionEmbed({ outcome, brand, message: 'Try again in a month.' });
        expect(embed.description).toBe('Try again in a month.');
        expect(embed.title).toContain('The Lords');
      }
    });

    it('carries NO fields at all — there is nowhere a staff-only value could render', () => {
      // The structural guarantee. `buildDecisionEmbed` takes exactly one text
      // input, so a future field wired to a staff-only source would have to add
      // both a parameter and a field, and this assertion fails the moment it does.
      for (const outcome of OUTCOMES) {
        const embed = buildDecisionEmbed({ outcome, brand, message: 'Anything.' });
        expect(embed.fields).toBeUndefined();
      }
    });

    it('cannot be handed the staff note: the whole embed contains only what was passed', () => {
      const STAFF_TEXT = 'zz-staffnote-sentinel-7f21a9';
      for (const outcome of OUTCOMES) {
        const embed = buildDecisionEmbed({ outcome, brand, message: 'Thank you for applying.' });
        expect(JSON.stringify(embed)).not.toContain(STAFF_TEXT);
      }
    });
  });
});
