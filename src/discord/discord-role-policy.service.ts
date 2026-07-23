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
 * Validates that a Discord role is safe to bind to a rank/medal or to the
 * join/ban settings (LDA-H1). Before this, `POST /api/ranks/:id/link-discord`
 * accepted any `discordRoleId` string and fanned it out to every holder of the
 * rank with no self-exclusion — an `edit_ranks_medals` holder could self-grant
 * `@Moderator` (kick/ban) that the capability model never conferred.
 */
@Injectable()
export class DiscordRolePolicyService {
  constructor(
    private readonly gateway: DiscordGateway,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Throw unless `roleId` is a role in the bound guild that the bot may safely
   * assign: it must exist, sit strictly below the bot in the hierarchy, not be
   * integration-managed, and hold no privileged permission bits.
   *
   * While the bot is MOCKED (production today) there is no real guild to check
   * and the role fan-out is a no-op, so validation is deferred — H1 is latent
   * until a real bot runs. Snowflake FORMAT is still enforced by the DTO layer
   * regardless of this method.
   */
  async assertRoleLinkable(roleId: string): Promise<void> {
    const { botMock } = this.config.get('discord', { infer: true });
    if (botMock) return;

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
    if (DiscordRolePolicyService.holdsPrivilegedPermissions(role.permissions)) {
      throw new BadRequestException(
        'That role grants privileged Discord permissions (administrator, kick/ban, ' +
          'manage roles/channels/messages, moderate members, or mention-everyone) and ' +
          'cannot be linked.',
      );
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
