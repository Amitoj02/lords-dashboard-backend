import { EventSummary } from '../discord/discord-sync.service';
import { RegimentEvent } from './entities/event.entity';

/** `One-off` / `Recurring (weekly)` / `Recurring occurrence` — the embed's Type field. */
function eventTypeLabel(event: RegimentEvent): string {
  if (event.recurrenceTemplateId) return 'Recurring occurrence';
  if (event.isRecurring && event.recurrenceCadence) return `Recurring (${event.recurrenceCadence})`;
  if (event.isRecurring) return 'Recurring';
  return 'One-off';
}

/**
 * Project an event row onto the shape a Discord notification needs (T-0174).
 *
 * ⚠️ SECURITY: `serverPassword` is NOT projected, and {@link EventSummary} has
 * no field that could carry it. An event-announcement channel is readable by the
 * entire guild, while the password is deliberately gated behind an RSVP in the
 * app — so the announcement must not be the thing that hands it out. Keeping the
 * omission structural (rather than "remember not to add it") is what makes that
 * guarantee hold as this projection grows.
 *
 * The event's OWN timezone travels with the summary so the composer can render a
 * wall clock the attendees recognise; nothing here reads the process locale.
 */
export function toEventSummary(event: RegimentEvent, rsvpCount: number): EventSummary {
  return {
    title: event.title,
    description: event.description,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    timezone: event.timezone,
    bannerUrl: event.bannerUrl,
    eventType: eventTypeLabel(event),
    rsvpCount,
  };
}
