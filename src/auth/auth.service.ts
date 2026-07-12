import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { MemberRole } from '../common/enums';
import { AuthzService } from '../authz/authz.service';
import { DiscordGateway } from '../discord/gateway/discord-gateway';
import { Member } from '../members/entities/member.entity';
import { CurrentUserDto } from './dto/current-user.dto';
import { DiscordOAuthService } from './discord-oauth.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { SessionContextService } from './session-context.service';
import { AuthenticatedUser } from './types/authenticated-user.interface';
import { JwtPayload } from './types/jwt-payload.interface';

export interface SignInResult {
  token: string;
  identity: DiscordIdentity;
  member: Member | null;
  isMember: boolean;
}

/**
 * Upper bound on the inline guild-membership lookup during sign-in. The bot call
 * is best-effort (regression risk T-0050#0): a slow/hung gateway must never block
 * login, so we abandon the lookup after this and fall back to guildMember=false.
 */
const GUILD_LOOKUP_TIMEOUT_MS = 4000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    private readonly discordOAuth: DiscordOAuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly authz: AuthzService,
    private readonly sessionContext: SessionContextService,
    private readonly discordGateway: DiscordGateway,
  ) {}

  /**
   * Step 1: the URL to redirect the browser to. `persona` is only meaningful
   * when the Discord mock is active (it selects which canned user to sign in
   * as); the real flow ignores it.
   */
  getLoginUrl(state: string, persona?: string): string {
    return this.discordOAuth.buildAuthorizeUrl(state, persona);
  }

  /**
   * Steps 3–6: exchange the code, upsert the Discord identity (the user record),
   * resolve the linked member if any, and issue a JWT.
   */
  async signInWithDiscord(code: string, ip?: string | null): Promise<SignInResult> {
    const token = await this.discordOAuth.exchangeCode(code);
    const profile = await this.discordOAuth.fetchUser(token.access_token);

    // Guild membership is resolved from the bot (T-0050), not the OAuth `guilds`
    // scope — so the consent screen no longer asks "know what servers you're in".
    const guildMember = await this.resolveGuildMembership(profile.id);

    const identity = await this.upsertIdentity(profile, token, guildMember, ip);

    const member = await this.members.findOne({
      where: { discordIdentityId: identity.id },
      relations: { rank: true },
    });
    // A ban/suspend must not be defeatable by re-authenticating: refuse to mint a
    // token for a banned member or one under an active suspension (the resolver
    // also rejects such tokens per request as defence in depth).
    if (member && (member.bannedAt || this.isActivelySuspended(member))) {
      throw new UnauthorizedException('This account is banned or suspended');
    }
    if (member) {
      member.lastSeenAt = new Date();
      member.discordLinked = true;
      await this.members.save(member);
    }

    // A fresh sign-in may have just linked a member to this identity; drop any
    // cached context so the resolver re-reads the live role on the next request.
    this.sessionContext.invalidate(identity.id);

    const jwtToken = await this.issueToken(identity);
    return { token: jwtToken, identity, member, isMember: member !== null };
  }

  /**
   * Invalidate the caller's outstanding tokens on logout (T-0048): advance the
   * identity's session cutoff so this and any concurrent tokens are rejected.
   */
  async logout(user: AuthenticatedUser): Promise<void> {
    await this.sessionContext.invalidateSessions(user.identityId);
  }

  /** True when a member is currently within an active suspension window. */
  private isActivelySuspended(member: Member): boolean {
    return !!member.suspendedUntil && member.suspendedUntil.getTime() > Date.now();
  }

  /**
   * Whether the signing-in Discord user is in the regiment guild, resolved via
   * the bot's gateway (T-0050) rather than the OAuth `guilds` scope. Runs INLINE
   * on the synchronous sign-in path, so it is deliberately defensive (regression
   * risk T-0050#0): it never throws and is bounded by {@link GUILD_LOOKUP_TIMEOUT_MS},
   * so a slow, failing, or disconnected bot can never stall or block login —
   * membership simply falls back to `false` (parity with the old
   * fetchGuilds([]-on-failure) behaviour). Returns `false` when no guild is
   * configured (nothing to check against).
   */
  private async resolveGuildMembership(discordUserId: string): Promise<boolean> {
    const guildId = this.config.get('discord', { infer: true }).guildId;
    if (!guildId) return false;
    try {
      const member = await this.withTimeout(
        this.discordGateway.fetchMember(discordUserId),
        GUILD_LOOKUP_TIMEOUT_MS,
      );
      return member !== null;
    } catch (error) {
      this.logger.warn(
        `Guild membership lookup failed for ${discordUserId}; treating as non-member: ${
          (error as Error).message
        }`,
      );
      return false;
    }
  }

  /** Reject with a timeout error if `promise` has not settled within `ms`. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`gateway lookup timed out after ${ms}ms`)),
        ms,
      );
      // Don't let the timer hold the event loop open (e.g. during shutdown/tests).
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Create or update the Discord identity keyed by the stable snowflake. */
  private async upsertIdentity(
    profile: Awaited<ReturnType<DiscordOAuthService['fetchUser']>>,
    token: Awaited<ReturnType<DiscordOAuthService['exchangeCode']>>,
    guildMember: boolean,
    ip?: string | null,
  ): Promise<DiscordIdentity> {
    let identity = await this.identities.findOne({ where: { discordUserId: profile.id } });
    if (!identity) {
      identity = this.identities.create({ discordUserId: profile.id });
    }

    const hasDiscriminator = profile.discriminator && profile.discriminator !== '0';
    identity.discordUsername = hasDiscriminator
      ? `${profile.username}#${profile.discriminator}`
      : profile.username;
    identity.discordTag = `@${profile.username}`;
    identity.globalName = profile.global_name ?? profile.username;
    identity.email = profile.email ?? null;
    identity.avatarUrl = this.discordOAuth.buildAvatarUrl(profile.id, profile.avatar);
    identity.accessToken = token.access_token;
    identity.refreshToken = token.refresh_token ?? null;
    identity.tokenExpiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;
    identity.scopes = token.scope ?? null;
    identity.guildMember = guildMember;
    identity.lastSignInAt = new Date();
    identity.lastSignInIp = ip ?? null;

    return this.identities.save(identity);
  }

  /**
   * Sign a JWT for the session. The payload is deliberately slim (T-0047): only
   * stable identity claims (`sub`, `did`). Role/regiment/member are resolved
   * fresh from the DB per request by {@link SessionContextService}, so they can
   * never go stale in the token.
   */
  async issueToken(identity: DiscordIdentity): Promise<string> {
    const payload: JwtPayload = {
      sub: identity.id,
      did: identity.discordUserId,
    };
    return this.jwt.signAsync(payload);
  }

  /**
   * The CurrentUser projection for /auth/me, enriched with the caller's
   * effective capabilities (resolved from the role_permissions matrix). A
   * member is projected off their current roster row (fresher than the JWT); an
   * identity-only session projects off the Discord identity as an Applicant.
   */
  async getCurrentUser(user: AuthenticatedUser): Promise<CurrentUserDto> {
    let projection: CurrentUserDto | null = null;
    let role: MemberRole = MemberRole.Applicant;

    if (user.memberId) {
      const member = await this.members.findOne({
        where: { id: user.memberId },
        relations: { rank: true },
      });
      if (member) {
        projection = AuthService.toMemberProjection(member);
        role = member.role;
      }
    }

    if (!projection) {
      const identity = await this.identities.findOne({ where: { id: user.identityId } });
      if (!identity) {
        throw new UnauthorizedException('Account no longer exists');
      }
      projection = AuthService.toIdentityProjection(identity);
      role = MemberRole.Applicant;
    }

    projection.capabilities = await this.authz.grantedCapabilities(user.regimentId, role);
    return projection;
  }

  private static toMemberProjection(member: Member): CurrentUserDto {
    return {
      id: member.id,
      name: member.name,
      rank: member.rank?.name ?? null,
      role: member.role,
      discordTag: null,
      discordLinked: member.discordLinked,
      avatarUrl: member.avatarUrl,
      isMember: true,
      // Filled in by getCurrentUser from the role_permissions matrix.
      capabilities: [],
    };
  }

  private static toIdentityProjection(identity: DiscordIdentity): CurrentUserDto {
    return {
      id: identity.id,
      name: identity.globalName ?? identity.discordUsername ?? 'Recruit',
      rank: null,
      role: MemberRole.Applicant,
      discordTag: identity.discordTag,
      discordLinked: false,
      avatarUrl: identity.avatarUrl,
      isMember: false,
      // Filled in by getCurrentUser from the role_permissions matrix.
      capabilities: [],
    };
  }
}
