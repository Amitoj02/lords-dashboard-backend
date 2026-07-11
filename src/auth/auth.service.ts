import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { MemberRole } from '../common/enums';
import { AuthzService } from '../authz/authz.service';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { CurrentUserDto } from './dto/current-user.dto';
import { DiscordOAuthService } from './discord-oauth.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
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
  private defaultRegimentId: string | null = null;

  constructor(
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    private readonly discordOAuth: DiscordOAuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly authz: AuthzService,
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

    const guildId = this.config.get('discord', { infer: true }).guildId;
    const guildMember = guildId
      ? await this.discordOAuth.isMemberOfGuild(token.access_token, guildId)
      : false;

    const identity = await this.upsertIdentity(profile, token, guildMember, ip);

    const member = await this.members.findOne({
      where: { discordIdentityId: identity.id },
      relations: { rank: true },
    });
    if (member) {
      member.lastSeenAt = new Date();
      member.discordLinked = true;
      await this.members.save(member);
    }

    const jwtToken = await this.issueToken(identity, member);
    return { token: jwtToken, identity, member, isMember: member !== null };
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

  /** Sign a JWT for the session. */
  async issueToken(identity: DiscordIdentity, member: Member | null): Promise<string> {
    const payload: JwtPayload = {
      sub: identity.id,
      mid: member?.id ?? null,
      did: identity.discordUserId,
      role: member?.role ?? MemberRole.Applicant,
      rid: member?.regimentId ?? (await this.getDefaultRegimentId()),
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

  /** Resolve (and cache) the single regiment's id for identity-only sessions. */
  private async getDefaultRegimentId(): Promise<string> {
    if (this.defaultRegimentId) return this.defaultRegimentId;
    const regiment = await this.regiments.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });
    if (!regiment) {
      throw new UnauthorizedException('No regiment configured');
    }
    this.defaultRegimentId = regiment.id;
    return regiment.id;
  }
}
