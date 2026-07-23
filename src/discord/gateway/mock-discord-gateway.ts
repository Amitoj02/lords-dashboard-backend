import { Injectable, Logger } from '@nestjs/common';
import {
  DiscordChannel,
  DiscordEmbed,
  DiscordGateway,
  DiscordGuildMemberRef,
  DiscordGatewayStatus,
  DiscordRole,
  MemberJoinHandler,
  MemberLeaveHandler,
} from './discord-gateway';

/**
 * One message the mock "delivered" (T-0172). The mock used to log
 * `content.slice(0, 80)` and keep nothing, which made embed SHAPE unassertable:
 * under DISCORD_BOT_MOCK the only observable was a log line. Recording the whole
 * message is what lets a test prove an enlistment post actually went out as an
 * embed with the right fields, rather than merely that a job reached `succeeded`.
 */
export interface RecordedMessage {
  kind: 'channel' | 'dm';
  /** Channel snowflake for a channel post; the Discord user id for a DM. */
  target: string;
  content: string;
  embeds: DiscordEmbed[];
  messageId: string;
}

/** A canned role set so listRoles()/status look realistic in the wizard. */
const MOCK_ROLES: DiscordRole[] = [
  { id: '900000000000000001', name: 'Guest', position: 1 },
  { id: '900000000000000002', name: 'Member', position: 2 },
  { id: '900000000000000003', name: 'Sergeant', position: 5 },
  { id: '900000000000000004', name: 'Officer', position: 8 },
  { id: '900000000000000006', name: 'Banned', position: 3 },
  { id: '900000000000000005', name: 'Lord Adjutant (bot)', position: 20 },
];

/** A canned text-channel set so the channel picker looks realistic in the wizard. */
const MOCK_CHANNELS: DiscordChannel[] = [
  { id: '910000000000000001', name: 'announcements' },
  { id: '910000000000000002', name: 'new-enlistments' },
  { id: '910000000000000003', name: 'audit-logs' },
  { id: '910000000000000004', name: 'event-announcements' },
  { id: '910000000000000005', name: 'general' },
];

/**
 * Discord snowflakes the mock treats as already in the guild at boot, so a
 * sign-in via the mock OAuth `owner` persona resolves guildMember=true without a
 * prior assignRole/simulateMemberJoin (T-0052 parity for bot-based membership).
 * This is the seeded dev-owner snowflake, matching MockDiscordOAuthService's
 * `owner` persona and seed.util's OWNER_DISCORD_USER_ID. Any other persona (e.g.
 * `recruit`) is deliberately absent → fetchMember=null → guildMember=false.
 */
const PRE_JOINED_MEMBER_IDS = ['100000000000000001'];

/**
 * A one-line log summary of a message. An embed-only send has EMPTY content, so
 * the old `content.slice(0, 80)` would have logged an empty string and made the
 * dev log silently useless for exactly the messages T-0173..T-0175 added.
 */
function describe(content: string, embeds?: DiscordEmbed[]): string {
  if (content) return content.slice(0, 80);
  const title = embeds?.[0]?.title;
  return embeds?.length ? `[embed] ${title ?? '(untitled)'}` : '(empty)';
}

/**
 * Drop-in {@link DiscordGateway} that performs NO network I/O. It keeps an
 * in-memory guild (roles + members) so role assign/remove/kick and message sends
 * are observable and deterministic, and logs each operation. Wired in place of
 * the real gateway when `discord.botMock` is true (see DiscordModule). To go
 * live: set DISCORD_BOT_MOCK=false with a real DISCORD_BOT_TOKEN — nothing else
 * changes. Because it never throws or connects, it can never crash the API.
 */
@Injectable()
export class MockDiscordGateway extends DiscordGateway {
  private readonly logger = new Logger(MockDiscordGateway.name);
  /** discordUserId → the roles the mock believes they hold. */
  private readonly members = new Map<string, Set<string>>();
  private readonly joinHandlers: MemberJoinHandler[] = [];
  private readonly leaveHandlers: MemberLeaveHandler[] = [];
  /** Everything "delivered", so tests can assert message + embed shape. */
  private readonly sent: RecordedMessage[] = [];
  /** Monotonic, so two messages sent in the same millisecond get distinct ids. */
  private messageCounter = 0;

  constructor() {
    super();
    // Seed the well-known guild members so bot-based membership resolves the same
    // way the real gateway would (the owner is already in the guild).
    for (const id of PRE_JOINED_MEMBER_IDS) {
      this.members.set(id, new Set());
    }
    this.logger.warn(
      'Discord bot is MOCKED (DISCORD_BOT_MOCK). No real gateway/Client is created — ' +
        'set DISCORD_BOT_MOCK=false with a real DISCORD_BOT_TOKEN to go live.',
    );
  }

  getStatus(): Promise<DiscordGatewayStatus> {
    return Promise.resolve({
      connected: true,
      botVersion: 'mock-1.0.0',
      totalRoles: MOCK_ROLES.length,
      botRolePosition: 20,
      membersVisible: this.members.size,
      // Canned runtime metrics (T-0076) so mock-mode keeps type parity and the
      // bot-status widget renders realistic values with no real gateway.
      wsPing: 42,
      uptimeMs: 3_600_000,
      memoryBytes: 128 * 1024 * 1024,
      cpu: 2.5,
      readyAt: '2026-01-01T00:00:00.000Z',
    });
  }

  listRoles(): Promise<DiscordRole[]> {
    return Promise.resolve([...MOCK_ROLES]);
  }

  listChannels(): Promise<DiscordChannel[]> {
    return Promise.resolve([...MOCK_CHANNELS]);
  }

  assignRole(discordUserId: string, roleId: string): Promise<void> {
    const roles = this.members.get(discordUserId) ?? new Set<string>();
    roles.add(roleId);
    this.members.set(discordUserId, roles);
    this.logger.log(`[mock] assigned role ${roleId} to ${discordUserId}`);
    return Promise.resolve();
  }

  removeRole(discordUserId: string, roleId: string): Promise<void> {
    this.members.get(discordUserId)?.delete(roleId);
    this.logger.log(`[mock] removed role ${roleId} from ${discordUserId}`);
    return Promise.resolve();
  }

  sendChannelMessage(
    channelId: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<{ messageId: string }> {
    const messageId = this.record('channel', channelId, content, embeds);
    this.logger.log(`[mock] #${channelId} <- ${describe(content, embeds)}`);
    return Promise.resolve({ messageId });
  }

  sendDirectMessage(
    discordUserId: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<{ messageId: string }> {
    const messageId = this.record('dm', discordUserId, content, embeds);
    this.logger.log(`[mock] DM ${discordUserId} <- ${describe(content, embeds)}`);
    return Promise.resolve({ messageId });
  }

  /** Everything sent since construction (or the last {@link resetSentMessages}). */
  get sentMessages(): readonly RecordedMessage[] {
    return this.sent;
  }

  /**
   * Drop the recorded buffer. Required, not a convenience: the mock is a
   * long-lived singleton inside a booted app, so an e2e suite that asserts "this
   * action sent exactly one embed" must be able to start from empty. It also
   * stops the buffer growing without bound in a dev session.
   */
  resetSentMessages(): void {
    this.sent.length = 0;
  }

  /** Append to the buffer and mint the id the caller gets back. */
  private record(
    kind: RecordedMessage['kind'],
    target: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): string {
    const messageId = `mock-msg-${++this.messageCounter}`;
    this.sent.push({ kind, target, content, embeds: embeds ? [...embeds] : [], messageId });
    return messageId;
  }

  fetchMember(discordUserId: string): Promise<DiscordGuildMemberRef | null> {
    const roles = this.members.get(discordUserId);
    if (!roles) return Promise.resolve(null);
    return Promise.resolve({
      id: discordUserId,
      roles: [...roles],
      joinedAt: new Date(0).toISOString(),
    });
  }

  registerMemberJoinHandler(handler: MemberJoinHandler): void {
    this.joinHandlers.push(handler);
  }

  registerMemberLeaveHandler(handler: MemberLeaveHandler): void {
    this.leaveHandlers.push(handler);
  }

  /** Test/dev helper: simulate a GuildMemberAdd so onboarding can be exercised. */
  async simulateMemberJoin(discordUserId: string): Promise<void> {
    this.members.set(discordUserId, new Set());
    for (const handler of this.joinHandlers) {
      await handler(discordUserId);
    }
  }

  /**
   * Test/dev helper: simulate a GuildMemberRemove (T-0169). The in-memory guild
   * forgets the member FIRST, so a fetchMember that races the handlers agrees
   * with the event — the mock must not report someone as present after the
   * departure it just announced.
   */
  async simulateMemberLeave(discordUserId: string): Promise<void> {
    this.members.delete(discordUserId);
    for (const handler of this.leaveHandlers) {
      await handler(discordUserId);
    }
  }
}
