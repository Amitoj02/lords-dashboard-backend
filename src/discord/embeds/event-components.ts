import { RsvpStatus } from '../../common/enums';
import { DiscordActionRow } from '../gateway/discord-gateway';

/**
 * The RSVP buttons under an event announcement, and the codec for their
 * `custom_id` (T-0205).
 *
 * ── THE CUSTOM ID IS THE WHOLE PROTOCOL ─────────────────────────────────────
 * Discord hands a button press back with nothing but the id the button was
 * created with, so that string has to carry everything needed to act: which
 * feature owns the press, what was chosen, and which event it belongs to. There
 * is no server-side registry of live buttons and there must not be one — an
 * announcement outlives every process that has ever run, so a press arriving
 * days after a deploy has to be answerable from the id alone.
 *
 * Namespaced (`event-rsvp:`) because presses are dispatched to accumulated
 * handlers: a handler that cannot parse an id returns null and the gateway
 * offers it to the next one, which is how a future feature's buttons coexist
 * with these.
 */

/** Prefix that claims a press for the event-RSVP handler. */
const PREFIX = 'event-rsvp';

/**
 * The three choices offered on the announcement, with the words the regiment
 * uses for them.
 *
 * `interested` is labelled **Attending**: the enum member is the wire value the
 * SPA has always sent, and renaming it would be a breaking API change for no
 * gain — but "interested" is not what pressing this button means, and the guild
 * reads the label, not the enum.
 *
 * `neutral` is deliberately NOT offered. It is the absence of an answer, which
 * on Discord is expressed by not pressing anything.
 */
export const RSVP_CHOICES = [
  { status: RsvpStatus.Interested, label: 'Attending', emoji: '✅', style: 'success' },
  { status: RsvpStatus.Tentative, label: 'Tentative', emoji: '❔', style: 'secondary' },
  { status: RsvpStatus.Declined, label: 'Declined', emoji: '❌', style: 'danger' },
] as const;

/** The id a given choice's button carries for a given event. */
export function rsvpCustomId(eventId: string, status: RsvpStatus): string {
  return `${PREFIX}:${status}:${eventId}`;
}

/** What a press meant, or null when the id belongs to some other feature. */
export function parseRsvpCustomId(
  customId: string,
): { eventId: string; status: RsvpStatus } | null {
  const [prefix, status, eventId] = customId.split(':');
  if (prefix !== PREFIX || !eventId) return null;
  // Compared as STRINGS, deliberately: `status` came off the wire and is not an
  // RsvpStatus until this lookup says it is. Matching against the offered
  // choices — rather than the whole enum — is also what keeps `neutral` out: it
  // is a real status with no button, and a hand-crafted id must not smuggle
  // one in.
  const choice = RSVP_CHOICES.find((c) => String(c.status) === status);
  return choice ? { eventId, status: choice.status } : null;
}

/**
 * The announcement's button row.
 *
 * ⚠️ `disabled` IS ONLY EVER TRUE FOR AN ENDED EVENT. While the event is still
 * ahead, the buttons stay live even for a member who has already answered —
 * changing your mind is the normal case (plans move, and a "Declined" that
 * cannot be taken back is worse than no RSVP at all), so nothing here reflects
 * the presser's current choice. What they picked is visible in the embed's own
 * roster sections instead.
 */
export function buildEventRsvpButtons(eventId: string, disabled = false): DiscordActionRow[] {
  return [
    {
      buttons: RSVP_CHOICES.map((choice) => ({
        customId: rsvpCustomId(eventId, choice.status),
        label: choice.label,
        style: choice.style,
        emoji: choice.emoji,
        disabled,
      })),
    },
  ];
}
