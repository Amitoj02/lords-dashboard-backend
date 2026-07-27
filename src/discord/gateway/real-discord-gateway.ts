import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIEmbed,
  APIMessageTopLevelComponent,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  Guild,
  MessageCreateOptions,
  MessageFlags,
  MessageMentionOptions,
  SendableChannels,
} from 'discord.js';
import { AppConfig } from '../../config/configuration';
import {
  DiscordActionRow,
  DiscordButtonPress,
  DiscordChannel,
  DiscordEmbed,
  DiscordGateway,
  DiscordGuildMemberRef,
  DiscordGatewayStatus,
  DiscordInteractionHandler,
  DiscordMentionAllowList,
  DiscordMessageEdit,
  DiscordRole,
  DiscordSendExtras,
  MemberJoinHandler,
  MemberLeaveHandler,
} from './discord-gateway';

/** App button style → discord.js. `primary` is the affirmative RSVP. */
const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

/** How long an event thread stays open with no activity (Discord's max: 1 week). */
const THREAD_AUTO_ARCHIVE_MINUTES = 10_080;

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
  private readonly joinHandlers: MemberJoinHandler[] = [];
  private readonly leaveHandlers: MemberLeaveHandler[] = [];
  private readonly interactionHandlers: DiscordInteractionHandler[] = [];

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
        if (!this.isBoundGuild(member.guild.id, 'GuildMemberAdd')) return;
        void this.fanOut(this.joinHandlers, member.id, 'join');
      });
      this.client.on(Events.GuildMemberRemove, (member) => {
        if (!this.isBoundGuild(member.guild.id, 'GuildMemberRemove')) return;
        void this.fanOut(this.leaveHandlers, member.id, 'leave');
      });
      this.client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isButton()) return;
        if (!this.isBoundGuild(interaction.guildId ?? '', 'InteractionCreate')) return;
        void this.dispatchButton(interaction);
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
    this.joinHandlers.push(handler);
  }

  registerMemberLeaveHandler(handler: MemberLeaveHandler): void {
    this.leaveHandlers.push(handler);
  }

  registerInteractionHandler(handler: DiscordInteractionHandler): void {
    this.interactionHandlers.push(handler);
  }

  /**
   * Answer one button press.
   *
   * ── THE THREE-SECOND CLOCK IS WHY THIS DEFERS FIRST ─────────────────────────
   * Discord discards an interaction that is not acknowledged within three
   * seconds and shows the presser "This interaction failed". A handler here does
   * real work — resolve the identity, resolve the roster member, check the
   * capability, upsert the RSVP — against a database that is occasionally slow,
   * so acknowledging FIRST and filling in the answer afterwards is the only
   * shape that cannot lose a press. `deferReply` buys fifteen minutes.
   *
   * Ephemeral throughout: the confirmation is for the presser alone. The channel
   * already learns the outcome from the re-rendered announcement, and an event
   * with forty RSVPs must not also produce forty "you're going!" messages.
   *
   * Nothing here may reject — an unhandled rejection inside discord.js's emitter
   * would take down the API process.
   */
  private async dispatchButton(interaction: {
    customId: string;
    user: { id: string };
    channelId: string;
    message: { id: string };
    deferReply: (options: { flags: MessageFlags.Ephemeral }) => Promise<unknown>;
    editReply: (options: { content: string }) => Promise<unknown>;
  }): Promise<void> {
    const press: DiscordButtonPress = {
      customId: interaction.customId,
      discordUserId: interaction.user.id,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    };
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      // A press we could not acknowledge is already lost to the presser; do NOT
      // run the handlers, or a retried click would double-apply its side effect.
      this.logger.error(`Could not acknowledge a button press: ${(error as Error).message}`);
      return;
    }

    let content = 'That control is no longer active.';
    for (const handler of this.interactionHandlers) {
      try {
        const reply = await handler(press);
        if (reply) {
          content = reply.content;
          break;
        }
      } catch (error) {
        this.logger.error(`A button handler failed: ${(error as Error).message}`);
        content = 'Something went wrong handling that. Try again in a moment.';
        break;
      }
    }

    try {
      await interaction.editReply({ content });
    } catch (error) {
      this.logger.error(`Could not answer a button press: ${(error as Error).message}`);
    }
  }

  /**
   * Ignore member events from any guild other than the bound DISCORD_GUILD_ID.
   *
   * The GuildMemberAdd handler used to discard `member.guild.id` entirely, so a
   * bot invited to two guilds (the common "test server + live server" setup)
   * fired onboarding for BOTH: a join in the test guild DM'd a production
   * welcome and assigned a production role, and vice versa. Every other method
   * here resolves the bound guild explicitly via {@link resolveGuild}; the event
   * handlers must be scoped the same way. When no guild is configured nothing is
   * bound, so no event can be attributed and all are dropped.
   */
  private isBoundGuild(guildId: string, event: string): boolean {
    const bound = this.config.get('discord', { infer: true }).guildId;
    if (!bound) {
      this.logger.warn(`Ignoring ${event} from guild ${guildId}: no DISCORD_GUILD_ID configured`);
      return false;
    }
    if (guildId !== bound) {
      this.logger.debug?.(`Ignoring ${event} from unbound guild ${guildId}`);
      return false;
    }
    return true;
  }

  /**
   * Run every subscriber for a member event in registration order, isolating
   * failures: one throwing subscriber must not stop the others, and nothing here
   * may reject into discord.js's event emitter (an unhandled rejection there
   * would take down the API process).
   */
  private async fanOut(
    handlers: readonly MemberJoinHandler[],
    discordUserId: string,
    kind: string,
  ): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(discordUserId);
      } catch (error) {
        this.logger.error(
          `A member-${kind} handler failed for ${discordUserId}: ${(error as Error).message}`,
        );
      }
    }
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
    return guild.roles.cache.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      // Decimal string of the 64-bit permission bitfield (LDA-H1 link validation).
      permissions: r.permissions.bitfield.toString(),
      managed: r.managed,
    }));
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

  async sendChannelMessage(
    channelId: string,
    content: string,
    embeds?: DiscordEmbed[],
    extras?: DiscordSendExtras,
  ): Promise<{ messageId: string }> {
    const channel = await this.resolveGuildChannel(channelId);
    const message = await channel.send(this.toSendOptions(content, embeds, extras));
    return { messageId: message.id };
  }

  async editChannelMessage(
    channelId: string,
    messageId: string,
    update: DiscordMessageEdit,
  ): Promise<void> {
    const channel = await this.resolveGuildChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit({
      // No mention allow-list is even accepted by this method: an announcement is
      // re-rendered on every RSVP, and a re-render that re-pings the role would
      // turn one ping into forty.
      allowedMentions: { parse: [] },
      ...(update.content !== undefined ? { content: update.content } : {}),
      ...(update.embeds ? { embeds: update.embeds.map((embed) => this.toApiEmbed(embed)) } : {}),
      // `[]` is meaningful here — it is how the RSVP buttons are removed when an
      // event ends — so this checks for PRESENCE, not truthiness.
      ...(update.components ? { components: this.toApiComponents(update.components) } : {}),
    });
  }

  async createMessageThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<{ threadId: string }> {
    const channel = await this.resolveGuildChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    // Discord caps a thread name at 100 characters and rejects the whole call
    // over it, so an event with a long title must be shortened, not refused.
    const thread = await message.startThread({
      name: name.slice(0, 100),
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
    });
    return { threadId: thread.id };
  }

  /**
   * Resolve a channel id (a real channel OR a thread) to something sendable,
   * scoped to the bound guild (LDA-M6): a channel id that resolves to a
   * DIFFERENT guild the bot happens to be in must never receive this regiment's
   * announcements. DMs have no guildId and are handled by sendDirectMessage.
   */
  private async resolveGuildChannel(channelId: string): Promise<SendableChannels> {
    const client = this.requireClient();
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      throw new ServiceUnavailableException('Channel is not a sendable text channel');
    }
    const boundGuildId = this.config.get('discord', { infer: true }).guildId;
    const channelGuildId = 'guildId' in channel ? channel.guildId : null;
    if (!boundGuildId || channelGuildId !== boundGuildId) {
      throw new ServiceUnavailableException('Channel is not in the configured regiment guild');
    }
    return channel;
  }

  async sendDirectMessage(
    discordUserId: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const user = await client.users.fetch(discordUserId);
    const message = await user.send(this.toSendOptions(content, embeds));
    return { messageId: message.id };
  }

  /**
   * THE discord.js boundary for outbound messages (T-0172). Everything upstream
   * speaks the app's own {@link DiscordEmbed}; the conversion to discord.js
   * happens here and nowhere else.
   *
   * `content` is omitted entirely when empty rather than sent as `''` — Discord
   * rejects an empty-string content, so an embed-only message must not carry the
   * key at all.
   */
  private toSendOptions(
    content: string,
    embeds?: DiscordEmbed[],
    extras?: DiscordSendExtras,
  ): MessageCreateOptions {
    const options: MessageCreateOptions = {
      allowedMentions: this.toAllowedMentions(extras?.mentions),
    };
    if (content) options.content = content;
    if (embeds?.length) options.embeds = embeds.map((embed) => this.toApiEmbed(embed));
    if (extras?.components?.length) options.components = this.toApiComponents(extras.components);
    // Neither half present would be an empty message; fall back to the content
    // key so the API returns a clear error instead of us sending `{}`.
    if (!options.content && !options.embeds) options.content = content;
    return options;
  }

  /**
   * Build the mention allow-list.
   *
   * `parse: []` is UNCONDITIONAL — it is what neutralises `@everyone`/`@here`
   * and any stray `<@id>` inside admin-authored text at the single send
   * boundary, permanently (LDA-M6). A caller that needs a real ping supplies
   * EXPLICIT SNOWFLAKES, which are added alongside; they cannot widen `parse`,
   * so there is no path from "this message mentions a role" to "this message
   * pinged the whole guild".
   *
   * Both arrays are truncated to Discord's documented maximum of 100 ids. Over
   * that, Discord rejects the message outright — and a rejected event thread
   * pings nobody at all, which is strictly worse than pinging the first hundred.
   */
  private toAllowedMentions(mentions?: DiscordMentionAllowList): MessageMentionOptions {
    const allowed: MessageMentionOptions = { parse: [] };
    if (mentions?.roles?.length) allowed.roles = mentions.roles.slice(0, 100);
    if (mentions?.users?.length) allowed.users = mentions.users.slice(0, 100);
    return allowed;
  }

  /**
   * Map action rows onto Discord's wire shape. Built as plain API objects rather
   * than through `ButtonBuilder`/`ActionRowBuilder` for the same reason
   * {@link toApiEmbed} avoids `EmbedBuilder`: the builders VALIDATE and THROW,
   * and a throw inside the send path is indistinguishable from a transient
   * Discord failure — the outbox would retry it five times and then fail it
   * permanently.
   */
  private toApiComponents(rows: DiscordActionRow[]): APIMessageTopLevelComponent[] {
    return rows.map((row): APIActionRowComponent<APIComponentInMessageActionRow> => ({
      type: ComponentType.ActionRow,
      components: row.buttons.map((button) => ({
        type: ComponentType.Button,
        style: BUTTON_STYLES[button.style],
        label: button.label,
        custom_id: button.customId,
        ...(button.emoji ? { emoji: { name: button.emoji } } : {}),
        ...(button.disabled ? { disabled: true } : {}),
      })),
    }));
  }

  /**
   * Map one app embed onto Discord's wire shape.
   *
   * Built as a plain `APIEmbed` object rather than through `EmbedBuilder` ON
   * PURPOSE: the builder's setters VALIDATE and THROW, and a throw inside the
   * send path is indistinguishable from a transient Discord failure — the outbox
   * would retry it five times and then fail it permanently. Composition is
   * already clamped to Discord's limits at enqueue time (see `clampEmbed`), so
   * the remaining risk is a malformed URL, which is dropped by the composer's
   * `safeUrl` rather than thrown over. `EmbedBuilder#toJSON()` produces exactly
   * this object.
   */
  private toApiEmbed(embed: DiscordEmbed): APIEmbed {
    return {
      ...(embed.title !== undefined ? { title: embed.title } : {}),
      ...(embed.description !== undefined ? { description: embed.description } : {}),
      ...(embed.url !== undefined ? { url: embed.url } : {}),
      ...(embed.color !== undefined ? { color: embed.color } : {}),
      ...(embed.timestamp !== undefined ? { timestamp: embed.timestamp } : {}),
      ...(embed.fields?.length
        ? {
            fields: embed.fields.map((f) => ({
              name: f.name,
              value: f.value,
              ...(f.inline !== undefined ? { inline: f.inline } : {}),
            })),
          }
        : {}),
      ...(embed.author
        ? {
            author: {
              name: embed.author.name,
              ...(embed.author.iconUrl ? { icon_url: embed.author.iconUrl } : {}),
              ...(embed.author.url ? { url: embed.author.url } : {}),
            },
          }
        : {}),
      ...(embed.footer
        ? {
            footer: {
              text: embed.footer.text,
              ...(embed.footer.iconUrl ? { icon_url: embed.footer.iconUrl } : {}),
            },
          }
        : {}),
      ...(embed.thumbnailUrl ? { thumbnail: { url: embed.thumbnailUrl } } : {}),
      ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}),
    };
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
