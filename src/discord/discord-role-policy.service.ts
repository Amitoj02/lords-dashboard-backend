import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DiscordGateway } from './gateway/discord-gateway';

/**
 * Discord permission bits (documented, stable API values — see
 * https://discord.com/developers/docs/topics/permissions). Defined locally as
 * bigint constants rather than importing discord.js's `PermissionFlagsBits` so
 * the discord.js dependency stays confined to RealDiscordGateway (the single
 * boundary file), per the module's architecture note.
 *
 * A role holding ANY of these is a role the dashboard's capability model never
 * granted — linking a rank/medal to it would let web-app staff hand themselves
 * (and everyone at that rank) real Discord server authority (LDA-H1).
 */
const PRIVILEGED_PERMISSION_BITS: Record<string, bigint> = {
  ADMINISTRATOR: 1n << 3n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_MESSAGES: 1n << 13n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MODERATE_MEMBERS: 1n << 40n,
};

const PRIVILEGED_PERMISSION_MASK = Object.values(PRIVILEGED_PERMISSION_BITS).reduce(
  (mask, bit) => mask | bit,
  0n,
);

/**
 * Advisory returned (not thrown) when a rank/medal is linked to a role carrying
 * privileged bits — T-0189 turned that case from a veto into a warning. Written
 * to name the consequence rather than the rule, because the admin reading it has
 * already decided to do this and only needs to know what it costs.
 */
export const PRIVILEGED_ROLE_WARNING =
  'Heads up: this Discord role grants privileged permissions (administrator, kick/ban, ' +
  'manage roles/channels/messages, moderate members, or mention-everyone). Everyone the bot ' +
  'gives it to will hold those permissions in the guild.';

/**
 * Rejection used where a privileged role is still a hard 400 — the join and Ban
 * role settings, which the bot applies with no admin in the loop to read a
 * warning. See {@link DiscordRolePolicyService.assertRoleLinkable}.
 */
const PRIVILEGED_ROLE_REJECTION =
  'That role grants privileged Discord permissions (administrator, kick/ban, ' +
  'manage roles/channels/messages, moderate members, or mention-everyone) and ' +
  'cannot be linked.';

/**
 * Validates that a Discord role is safe to bind to a rank/medal or to the
 * join/ban settings (LDA-H1). Before this, `POST /api/ranks/:id/link-discord`
 * accepted any `discordRoleId` string and fanned it out to every holder of the
 * rank with no self-exclusion — an `edit_ranks_medals` holder could self-grant
 * `@Moderator` (kick/ban) that the capability model never conferred.
 *
 * The privileged half of that control is ADVISORY on the rank/medal path as of
 * T-0189 (the owner asked for a warning, not a veto): {@link checkRoleLinkable}
 * returns the warning and the caller decides. The self-exclusion in the re-link
 * fan-out is untouched and remains the reason a self-grant still cannot happen
 * in one click.
 */
@Injectable()
export class DiscordRolePolicyService {
  constructor(
    private readonly gateway: DiscordGateway,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Validate `roleId` for linking and RETURN the privileged advisory instead of
   * throwing it. Null means the role is clean.
   *
   * The other three checks still throw, because they are not judgement calls: a
   * role that is missing from the guild, sits at or above the bot, or is
   * integration-managed is one the bot *physically cannot assign*, so accepting
   * the link would only bank a mapping that fails later, once per holder, in a
   * background job nobody is watching. A privileged role is the opposite — the
   * bot can assign it perfectly well, and whether that is acceptable is the
   * regiment's call to make with its eyes open (T-0189).
   *
   * While the bot is MOCKED (production today) there is no real guild to check
   * and the role fan-out is a no-op, so validation is deferred — H1 is latent
   * until a real bot runs. Snowflake FORMAT is still enforced by the DTO layer
   * regardless of this method.
   */
  async checkRoleLinkable(roleId: string): Promise<string | null> {
    const { botMock } = this.config.get('discord', { infer: true });
    if (botMock) return null;

    const status = await this.gateway.getStatus();
    if (!status.connected || status.botRolePosition == null) {
      throw new ServiceUnavailableException(
        'The Discord bot is not connected, so the target role cannot be validated. ' +
          'Try again once the bot is online.',
      );
    }

    const role = (await this.gateway.listRoles()).find((r) => r.id === roleId);
    if (!role) {
      throw new BadRequestException('That role is not a role in the regiment Discord guild.');
    }
    if (role.position >= status.botRolePosition) {
      throw new BadRequestException(
        'That role sits at or above the bot in the hierarchy; the bot cannot manage it.',
      );
    }
    if (role.managed) {
      throw new BadRequestException(
        'That role is managed by an integration and cannot be assigned by the bot.',
      );
    }
    return DiscordRolePolicyService.holdsPrivilegedPermissions(role.permissions)
      ? PRIVILEGED_ROLE_WARNING
      : null;
  }

  /**
   * Strict variant of {@link checkRoleLinkable}: the privileged advisory becomes
   * a 400. Used for the join and Ban role settings, where the bot assigns the
   * role with no per-member decision behind it — the join role lands on everyone
   * who walks into the guild and the Ban role on everyone banned — so there is
   * no moment where an admin could read a warning and weigh it. Rank and medal
   * links go through `checkRoleLinkable` instead.
   */
  async assertRoleLinkable(roleId: string): Promise<void> {
    if (await this.checkRoleLinkable(roleId)) {
      throw new BadRequestException(PRIVILEGED_ROLE_REJECTION);
    }
  }

  /** True when the permission bitfield string carries any privileged bit. */
  static holdsPrivilegedPermissions(permissions: string): boolean {
    let bits: bigint;
    try {
      bits = BigInt(permissions || '0');
    } catch {
      // An unparseable bitfield is treated as privileged (fail closed).
      return true;
    }
    return (bits & PRIVILEGED_PERMISSION_MASK) !== 0n;
  }
}
