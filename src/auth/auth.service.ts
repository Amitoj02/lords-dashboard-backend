import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberRole } from '../common/enums';
import { AuthzService } from '../authz/authz.service';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { CurrentUserDto } from './dto/current-user.dto';
import { DiscordOAuthService } from './discord-oauth.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { GuildMembershipService, StoredGuildVerdict } from './guild-membership.service';
import { SessionContextService } from './session-context.service';
import { AuthenticatedUser } from './types/authenticated-user.interface';
import { JwtPayload } from './types/jwt-payload.interface';

export interface SignInResult {
  token: string;
  identity: DiscordIdentity;
  member: Member | null;
  isMember: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    private readonly discordOAuth: DiscordOAuthService,
    private readonly jwt: JwtService,
    private readonly authz: AuthzService,
    private readonly sessionContext: SessionContextService,
    private readonly guildMembership: GuildMembershipService,
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
    // `null` means the lookup did not complete; see upsertIdentity (T-0168).
    const guildMember = await this.guildMembership.probe(profile.id);

    const identity = await this.upsertIdentity(profile, token, guildMember, ip);
    // Sign-in has just re-derived (or deliberately preserved) the verdict; keep
    // the cached copy from contradicting the row it was derived from.
    this.guildMembership.syncCache(identity);

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
   * Create or update the Discord identity keyed by the stable snowflake.
   *
   * `guildMember` is `null` when the bot lookup did not complete (disconnected,
   * timed out, breaker open, or no guild configured). Originally (T-0050) that
   * case was written straight through as `false`, which was harmless while the
   * flag was informational — but it means a real member who signs in during a
   * bot outage has their TRUE verdict overwritten with a stale `false`, and once
   * that verdict gates access the outage locks them out even after the bot comes
   * back. So an unconfirmed lookup now writes NOTHING (T-0168): the previous
   * verdict and its `guildCheckedAt` stamp survive untouched, and only a brand
   * new identity — which has no verdict to preserve — is seeded with `false`.
   */
  private async upsertIdentity(
    profile: Awaited<ReturnType<DiscordOAuthService['fetchUser']>>,
    token: Awaited<ReturnType<DiscordOAuthService['exchangeCode']>>,
    guildMember: boolean | null,
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
    if (guildMember === null) {
      // Unconfirmed: preserve whatever we last knew (false only for a new row).
      identity.guildMember = identity.guildMember ?? false;
    } else {
      identity.guildMember = guildMember;
      identity.guildCheckedAt = new Date();
    }
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
   *
   * It also carries everything the client needs to render the guild gate
   * (T-0166) — the verdict, the invite to escape it, whether the gate is even
   * on, and whether this caller is exempt — so the shell does not have to make a
   * second call before it can decide what to show. Crucially this path reads the
   * STORED verdict only: /auth/me must never trigger a Discord lookup.
   */
  async getCurrentUser(user: AuthenticatedUser): Promise<CurrentUserDto> {
    let projection: CurrentUserDto | null = null;
    let role: MemberRole = MemberRole.Applicant;
    let stored: StoredGuildVerdict | null = null;

    if (user.memberId) {
      const member = await this.members.findOne({
        where: { id: user.memberId },
        relations: { rank: true, discordIdentity: true },
      });
      if (member) {
        projection = AuthService.toMemberProjection(member);
        role = member.role;
        stored = member.discordIdentity ?? null;
      }
    }

    if (!projection) {
      const identity = await this.identities.findOne({ where: { id: user.identityId } });
      if (!identity) {
        throw new UnauthorizedException('Account no longer exists');
      }
      projection = AuthService.toIdentityProjection(identity);
      role = MemberRole.Applicant;
      stored = identity;
    }

    const [capabilities, regiment, gate] = await Promise.all([
      this.authz.grantedCapabilities(user.regimentId, role),
      this.regiments.findOne({ where: { id: user.regimentId } }),
      this.guildMembership.gateFlags(user.regimentId, role),
    ]);

    projection.capabilities = capabilities;
    projection.guildMember = GuildMembershipService.verdictOf(stored).guildMember;
    projection.discordInviteUrl = regiment?.discordInviteUrl ?? null;
    projection.guildGateEnabled = gate.gateEnabled;
    projection.guildGateExempt = gate.exempt;
    return projection;
  }

  private static toMemberProjection(member: Member): CurrentUserDto {
    return {
      id: member.id,
      inGameName: member.inGameName,
      rank: member.rank?.name ?? null,
      role: member.role,
      discordTag: null,
      discordLinked: member.discordLinked,
      // Fall back to the linked Discord avatar when the member has no custom one.
      avatarUrl: member.avatarUrl ?? member.discordIdentity?.avatarUrl ?? null,
      isMember: true,
      // Filled in by getCurrentUser from the role_permissions matrix.
      capabilities: [],
      // Filled in by getCurrentUser; the fail-open default (T-0168) is the safe
      // placeholder, so a projector that somehow escapes enrichment cannot gate.
      guildMember: true,
      discordInviteUrl: null,
      guildGateEnabled: false,
      guildGateExempt: false,
    };
  }

  private static toIdentityProjection(identity: DiscordIdentity): CurrentUserDto {
    return {
      id: identity.id,
      inGameName: identity.globalName ?? identity.discordUsername ?? 'Recruit',
      rank: null,
      role: MemberRole.Applicant,
      discordTag: identity.discordTag,
      discordLinked: false,
      avatarUrl: identity.avatarUrl,
      isMember: false,
      // Filled in by getCurrentUser from the role_permissions matrix.
      capabilities: [],
      // Filled in by getCurrentUser; see toMemberProjection for why `true`.
      guildMember: true,
      discordInviteUrl: null,
      guildGateEnabled: false,
      guildGateExempt: false,
    };
  }
}
