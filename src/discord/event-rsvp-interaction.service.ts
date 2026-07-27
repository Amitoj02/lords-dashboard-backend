import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { AuthzService } from '../authz/authz.service';
import { Capability, EventStatus, RsvpStatus } from '../common/enums';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { DiscordSyncService } from './discord-sync.service';
import { parseRsvpCustomId } from './embeds/event-components';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import {
  DiscordButtonPress,
  DiscordGateway,
  DiscordInteractionReply,
} from './gateway/discord-gateway';

/** What the presser is told, per choice. */
const CONFIRMATIONS: Record<string, string> = {
  [RsvpStatus.Interested]: '✅ You are down as **Attending**',
  [RsvpStatus.Tentative]: '❔ You are down as **Tentative**',
  [RsvpStatus.Declined]: '❌ You are down as **Declined**',
};

/**
 * Turns a press of an announcement's RSVP button into a real RSVP (T-0205).
 *
 * ── THIS IS THE BOT'S FIRST INBOUND WRITE PATH ──────────────────────────────
 * Everything the Lord Adjutant did before this was outbound: it posted what the
 * app had already decided. A button press is the other direction — a Discord
 * account changing roster state — so this handler carries the same
 * authorisation the HTTP route does, and reaches it through the SAME code:
 *
 *  - {@link SessionContextService.resolve} is the app's single authorization
 *    choke point. It is what turns an identity into a live member + role, and
 *    what returns null for a banned or suspended one. Re-implementing "is this
 *    person allowed to act" here would be a second answer to that question,
 *    which is exactly how a ban gets defeated by a side door.
 *  - {@link Capability.RsvpToEvents} is then checked against that live role,
 *    because the permission matrix is the thing the regiment actually edits;
 *    a button that ignored it would silently out-rank the settings screen.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not create a member. A Discord account with no roster row is a
 * visitor, and pressing a button in a public channel must never be a way onto
 * the roster — that is what the enlistment flow is for. They are told to apply.
 *
 * The reply is always EPHEMERAL (the gateway enforces that): the channel learns
 * the outcome from the re-rendered announcement, so forty RSVPs must not also
 * produce forty confirmation messages.
 */
@Injectable()
export class EventRsvpInteractionService implements OnModuleInit {
  private readonly logger = new Logger(EventRsvpInteractionService.name);

  constructor(
    private readonly gateway: DiscordGateway,
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    private readonly sessions: SessionContextService,
    private readonly authz: AuthzService,
    private readonly sync: DiscordSyncService,
  ) {}

  onModuleInit(): void {
    this.gateway.registerInteractionHandler((press) => this.handle(press));
  }

  /**
   * Answer one press. Returns null when the id is not ours — the gateway then
   * offers it to the next handler — and a message in every other case, including
   * refusals: a press that silently does nothing is indistinguishable from a
   * broken bot.
   */
  async handle(press: DiscordButtonPress): Promise<DiscordInteractionReply | null> {
    const parsed = parseRsvpCustomId(press.customId);
    if (!parsed) return null;

    const event = await this.events.findOne({
      where: { id: parsed.eventId, isDraft: false, isArchived: false },
    });
    if (!event) return { content: 'That event no longer exists.' };

    // The master switch, re-checked at PRESS time exactly as the ban-role job
    // re-checks it at drain time: an announcement outlives the setting that
    // produced it, and a regiment that switched the bot off has switched off its
    // ability to write roster state from Discord.
    const settings = await this.settings.findOne({ where: { regimentId: event.regimentId } });
    if (!settings?.botEnabled) return null;

    if (event.status === EventStatus.Previous) {
      return { content: 'That event has already finished — RSVPs are closed.' };
    }

    const identity = await this.identities.findOne({
      where: { discordUserId: press.discordUserId },
    });
    if (!identity) {
      return { content: SIGN_IN_HINT };
    }
    const context = await this.sessions.resolve(identity.id);
    // Null means the identity is gone, banned or suspended. The three are not
    // distinguished on purpose: a suspended member does not need this channel to
    // tell them why, and telling them here would announce it to nobody useful.
    if (!context || !context.memberId) {
      return { content: SIGN_IN_HINT };
    }
    if (context.regimentId !== event.regimentId) {
      return { content: 'That event belongs to a different regiment.' };
    }
    if (!(await this.authz.can(context.regimentId, context.role, Capability.RsvpToEvents))) {
      return { content: 'Your role is not permitted to RSVP to events.' };
    }

    await this.upsert(event.id, context.memberId, parsed.status);

    // Best-effort by contract — the enqueue never throws — so a queue problem
    // costs a stale embed, not a lost RSVP. The RSVP is already committed.
    await this.sync.enqueueEventAnnouncementRefresh(event.regimentId, event.id);
    this.logger.log(`RSVP ${parsed.status} on event ${event.id} via Discord button`);

    return { content: `${CONFIRMATIONS[parsed.status]} for **${event.title}**.` };
  }

  /**
   * Write the choice, keeping the member's own reminder lead time.
   *
   * ⚠️ `reminderOffsetMinutes` IS PRESERVED, not overwritten with null. It is a
   * preference the member set on the website, and a button press means "I am
   * coming", not "forget what I asked for" — the same reason the buttons never
   * disable after a press. A brand-new RSVP has none to preserve.
   */
  private async upsert(eventId: string, memberId: string, status: RsvpStatus): Promise<void> {
    const existing = await this.rsvps.findOne({ where: { eventId, memberId } });
    if (existing) {
      existing.status = status;
      existing.respondedAt = new Date();
      await this.rsvps.save(existing);
      return;
    }
    await this.rsvps.save(
      this.rsvps.create({
        eventId,
        memberId,
        status,
        reminderOffsetMinutes: null,
        respondedAt: new Date(),
      }),
    );
  }
}

/**
 * The one refusal a visitor can act on. Every "you are not a member here" case
 * collapses into it, because from the presser's side they are the same problem
 * and the fix is the same: go to the dashboard.
 */
const SIGN_IN_HINT =
  'Only enrolled members can RSVP. Sign in to the regiment dashboard with this Discord ' +
  'account — and apply if you have not yet — then try again.';
