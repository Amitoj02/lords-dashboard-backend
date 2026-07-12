/** A Discord role as the bot sees it. */
export interface DiscordRole {
  id: string;
  name: string;
  position: number;
}

/** A Discord text channel the bot can post to (surfaced to the channel picker). */
export interface DiscordChannel {
  id: string;
  name: string;
}

/** A guild member as the bot sees it (role snowflakes it currently holds). */
export interface DiscordGuildMemberRef {
  id: string;
  roles: string[];
  joinedAt: string | null;
}

/** Live connection/authority snapshot the wizard + bot-status screen read. */
export interface DiscordGatewayStatus {
  connected: boolean;
  botVersion: string | null;
  totalRoles: number | null;
  botRolePosition: number | null;
  membersVisible: number | null;
}

/** Handler invoked when a member joins the guild (drives onboarding). */
export type MemberJoinHandler = (discordUserId: string) => void | Promise<void>;

/**
 * The bot's Discord side, abstracted so the whole sync pipeline can run against
 * an in-process {@link MockDiscordGateway} with no real bot. The concrete
 * implementation is chosen by a factory in DiscordModule based on
 * `config.discord.botMock` — mirroring the OAuth mock/real seam. Every method is
 * expected to be called ONLY by the outbox worker (which isolates failures), so
 * implementations may throw on transient errors; the worker retries/records them.
 */
export abstract class DiscordGateway {
  abstract getStatus(): Promise<DiscordGatewayStatus>;
  abstract listRoles(): Promise<DiscordRole[]>;
  abstract listChannels(): Promise<DiscordChannel[]>;
  abstract assignRole(discordUserId: string, roleId: string): Promise<void>;
  abstract removeRole(discordUserId: string, roleId: string): Promise<void>;
  abstract sendChannelMessage(channelId: string, content: string): Promise<{ messageId: string }>;
  abstract sendDirectMessage(discordUserId: string, content: string): Promise<void>;
  abstract fetchMember(discordUserId: string): Promise<DiscordGuildMemberRef | null>;

  /** Register the onboarding handler fired on GuildMemberAdd (best-effort). */
  abstract registerMemberJoinHandler(handler: MemberJoinHandler): void;
}
