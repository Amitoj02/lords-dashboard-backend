import { Injectable, Logger } from '@nestjs/common';
import {
  DiscordChannel,
  DiscordGateway,
  DiscordGuildMemberRef,
  DiscordGatewayStatus,
  DiscordRole,
  MemberJoinHandler,
} from './discord-gateway';

/** A canned role set so listRoles()/status look realistic in the wizard. */
const MOCK_ROLES: DiscordRole[] = [
  { id: '900000000000000001', name: 'Guest', position: 1 },
  { id: '900000000000000002', name: 'Member', position: 2 },
  { id: '900000000000000003', name: 'Sergeant', position: 5 },
  { id: '900000000000000004', name: 'Officer', position: 8 },
  { id: '900000000000000006', name: 'Banned', position: 3 },
  { id: '900000000000000005', name: 'Quartermaster (bot)', position: 20 },
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
  private joinHandler: MemberJoinHandler | null = null;

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

  sendChannelMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    this.logger.log(`[mock] #${channelId} <- ${content.slice(0, 80)}`);
    return Promise.resolve({ messageId: `mock-msg-${Date.now()}` });
  }

  sendDirectMessage(discordUserId: string, content: string): Promise<void> {
    this.logger.log(`[mock] DM ${discordUserId} <- ${content.slice(0, 80)}`);
    return Promise.resolve();
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
    this.joinHandler = handler;
  }

  /** Test/dev helper: simulate a GuildMemberAdd so onboarding can be exercised. */
  async simulateMemberJoin(discordUserId: string): Promise<void> {
    this.members.set(discordUserId, new Set());
    await this.joinHandler?.(discordUserId);
  }
}
