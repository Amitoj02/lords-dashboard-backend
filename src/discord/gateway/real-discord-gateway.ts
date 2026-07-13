import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType, Client, Events, GatewayIntentBits, Guild } from 'discord.js';
import { AppConfig } from '../../config/configuration';
import {
  DiscordChannel,
  DiscordGateway,
  DiscordGuildMemberRef,
  DiscordGatewayStatus,
  DiscordRole,
  MemberJoinHandler,
} from './discord-gateway';

/**
 * The production {@link DiscordGateway} backed by a discord.js Client, held in
 * the web process. It is only instantiated when `discord.botMock` is false (a
 * real DISCORD_BOT_TOKEN is set) — otherwise MockDiscordGateway is used and this
 * class is never constructed. Lifecycle is defensive by design (regression risk
 * T-0020#0): login/reconnect/shutdown are wrapped so a bot failure can NEVER
 * crash the API — a failed login just leaves the gateway "not connected" and the
 * outbox worker surfaces the resulting job failures as resolvable operations.
 *
 * The bot has NO slash commands (owner decision): it only manages roles and
 * posts messages. It requires the GUILD_MEMBERS privileged intent and must sit
 * above every role it manages.
 */
@Injectable()
export class RealDiscordGateway
  extends DiscordGateway
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RealDiscordGateway.name);
  private client: Client | null = null;
  private ready = false;
  private joinHandler: MemberJoinHandler | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const discord = this.config.get('discord', { infer: true });
    if (!discord.botToken) {
      this.logger.warn('No DISCORD_BOT_TOKEN — real gateway will stay disconnected.');
      return;
    }
    try {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      });
      this.client.once(Events.ClientReady, (c) => {
        this.ready = true;
        this.logger.log(`Discord bot connected as ${c.user.tag}`);
      });
      this.client.on(Events.GuildMemberAdd, (member) => {
        void this.joinHandler?.(member.id);
      });
      this.client.on(Events.Error, (err) => this.logger.error(`Gateway error: ${err.message}`));
      await this.client.login(discord.botToken);
    } catch (error) {
      // Never rethrow: a bot that fails to connect must not take down the API.
      this.ready = false;
      this.logger.error(`Discord bot failed to connect: ${(error as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client?.destroy();
    } catch (error) {
      this.logger.error(`Discord bot shutdown error: ${(error as Error).message}`);
    } finally {
      this.ready = false;
      this.client = null;
    }
  }

  registerMemberJoinHandler(handler: MemberJoinHandler): void {
    this.joinHandler = handler;
  }

  async getStatus(): Promise<DiscordGatewayStatus> {
    const disconnected: DiscordGatewayStatus = {
      connected: false,
      botVersion: null,
      totalRoles: null,
      botRolePosition: null,
      membersVisible: null,
      wsPing: null,
      uptimeMs: null,
      memoryBytes: null,
      cpu: null,
      readyAt: null,
    };
    if (!this.ready || !this.client) {
      return disconnected;
    }
    try {
      const guild = await this.resolveGuild();
      const botPosition = guild.members.me?.roles.highest.position ?? null;
      return {
        connected: true,
        botVersion: null,
        totalRoles: guild.roles.cache.size,
        botRolePosition: botPosition,
        membersVisible: guild.memberCount,
        ...this.runtimeMetrics(),
      };
    } catch (error) {
      // getStatus is a health probe — it must never throw (e.g. no guild id or a
      // transient fetch error would otherwise break /discord/connection + verify).
      this.logger.error(`getStatus failed: ${(error as Error).message}`);
      return disconnected;
    }
  }

  /**
   * Live runtime metrics for the bot-status widget (T-0076). `cpu` is the
   * process-average CPU utilization since start (user+system time over wall
   * uptime) — a stable, sampling-free estimate. `wsPing` is clamped to null
   * before the first heartbeat (discord.js reports -1). Memory/CPU are
   * process-wide, since the gateway runs in the API process.
   */
  private runtimeMetrics(): Pick<
    DiscordGatewayStatus,
    'wsPing' | 'uptimeMs' | 'memoryBytes' | 'cpu' | 'readyAt'
  > {
    const client = this.client;
    const ping = client?.ws.ping ?? null;
    const cpuUsage = process.cpuUsage();
    const procUptimeSec = process.uptime();
    const cpuPercent =
      procUptimeSec > 0 ? ((cpuUsage.user + cpuUsage.system) / 1e6 / procUptimeSec) * 100 : null;
    return {
      wsPing: ping !== null && ping >= 0 ? Math.round(ping) : null,
      uptimeMs: client?.uptime ?? null,
      memoryBytes: process.memoryUsage().rss,
      cpu: cpuPercent !== null ? Math.round(cpuPercent * 10) / 10 : null,
      readyAt: client?.readyAt ? client.readyAt.toISOString() : null,
    };
  }

  async listRoles(): Promise<DiscordRole[]> {
    const guild = await this.resolveGuild();
    return guild.roles.cache.map((r) => ({ id: r.id, name: r.name, position: r.position }));
  }

  async listChannels(): Promise<DiscordChannel[]> {
    const guild = await this.resolveGuild();
    const channels = await guild.channels.fetch();
    // Only text channels the bot can post announcements/embeds to.
    return [...channels.values()]
      .filter((c): c is NonNullable<typeof c> => c?.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  async assignRole(discordUserId: string, roleId: string): Promise<void> {
    const guild = await this.resolveGuild();
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(roleId);
  }

  async removeRole(discordUserId: string, roleId: string): Promise<void> {
    const guild = await this.resolveGuild();
    const member = await guild.members.fetch(discordUserId);
    await member.roles.remove(roleId);
  }

  async sendChannelMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new ServiceUnavailableException('Channel is not a sendable text channel');
    }
    const message = await channel.send(content);
    return { messageId: message.id };
  }

  async sendDirectMessage(discordUserId: string, content: string): Promise<void> {
    const client = this.requireClient();
    const user = await client.users.fetch(discordUserId);
    await user.send(content);
  }

  async fetchMember(discordUserId: string): Promise<DiscordGuildMemberRef | null> {
    const guild = await this.resolveGuild();
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) return null;
    return {
      id: member.id,
      roles: member.roles.cache.map((r) => r.id),
      joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
    };
  }

  private requireClient(): Client {
    if (!this.ready || !this.client) {
      throw new ServiceUnavailableException('Discord bot is not connected');
    }
    return this.client;
  }

  private async resolveGuild(): Promise<Guild> {
    const client = this.requireClient();
    const guildId = this.config.get('discord', { infer: true }).guildId;
    if (!guildId) {
      throw new ServiceUnavailableException('No DISCORD_GUILD_ID configured');
    }
    return client.guilds.fetch(guildId);
  }
}
