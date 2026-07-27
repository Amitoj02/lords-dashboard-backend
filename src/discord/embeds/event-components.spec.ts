import { RsvpStatus } from '../../common/enums';
import { buildEventRsvpButtons, parseRsvpCustomId, rsvpCustomId } from './event-components';

const EVENT = 'evt000000001';

describe('event RSVP components (T-0205)', () => {
  describe('the custom-id codec', () => {
    it('round-trips every offered choice', () => {
      for (const status of [RsvpStatus.Interested, RsvpStatus.Tentative, RsvpStatus.Declined]) {
        expect(parseRsvpCustomId(rsvpCustomId(EVENT, status))).toEqual({ eventId: EVENT, status });
      }
    });

    it('returns null for an id it does not own, so another handler can claim it', () => {
      // Presses are dispatched to accumulated handlers. "Not mine" has to be
      // distinguishable from "mine and malformed", or a future feature's buttons
      // would be swallowed by this one.
      expect(parseRsvpCustomId('gallery-approve:123')).toBeNull();
      expect(parseRsvpCustomId('')).toBeNull();
      expect(parseRsvpCustomId(`event-rsvp:${EVENT}`)).toBeNull();
    });

    it('rejects a status that is not one of the three buttons', () => {
      // `neutral` is a real RsvpStatus but is deliberately NOT offered: it is the
      // absence of an answer, which on Discord means not pressing anything.
      expect(parseRsvpCustomId(`event-rsvp:neutral:${EVENT}`)).toBeNull();
      expect(parseRsvpCustomId(`event-rsvp:attending:${EVENT}`)).toBeNull();
    });

    it('stays inside the 100-character custom_id limit Discord enforces', () => {
      expect(rsvpCustomId(EVENT, RsvpStatus.Interested).length).toBeLessThanOrEqual(100);
    });
  });

  describe('the button row', () => {
    it('offers Attending / Tentative / Declined, in that order', () => {
      const [row] = buildEventRsvpButtons(EVENT);
      expect(row.buttons.map((b) => b.label)).toEqual(['Attending', 'Tentative', 'Declined']);
    });

    it('leaves the buttons LIVE while the event is ahead', () => {
      // Changing your mind is the normal case; a "Declined" that cannot be taken
      // back is worse than no RSVP at all.
      const [row] = buildEventRsvpButtons(EVENT);
      expect(row.buttons.every((b) => b.disabled === false)).toBe(true);
    });

    it('disables every button once the event has ended', () => {
      const [row] = buildEventRsvpButtons(EVENT, true);
      expect(row.buttons.every((b) => b.disabled === true)).toBe(true);
      // The ids survive the retirement — the message stays the historical record.
      expect(row.buttons[0].customId).toBe(rsvpCustomId(EVENT, RsvpStatus.Interested));
    });

    it('fits in one action row (Discord allows five buttons per row)', () => {
      const rows = buildEventRsvpButtons(EVENT);
      expect(rows).toHaveLength(1);
      expect(rows[0].buttons.length).toBeLessThanOrEqual(5);
    });
  });
});
