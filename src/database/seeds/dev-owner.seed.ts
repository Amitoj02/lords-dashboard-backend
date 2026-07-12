import { DataSource } from 'typeorm';
import { DiscordIdentity } from '../../auth/entities/discord-identity.entity';
import { MemberRole, MemberStatus, Platform } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Rank } from '../../ranks/entities/rank.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';
import {
  ensure,
  OWNER_DISCORD_USER_ID,
  OWNER_IDENTITY_ID,
  OWNER_MEMBER_ID,
  REGIMENT_ID,
} from './seed.util';

/**
 * Seeds the regiment Owner (identity + member) so admin flows and /auth/me work
 * from the first boot.
 *
 * - DEV (default): a fixture owner with the well-known dev snowflake, so the
 *   Discord mock (`?as=owner`) resolves it and admin flows are testable with no
 *   live Discord login.
 * - PROD: set `OWNER_DISCORD_ID` (and optionally `OWNER_NAME`) to claim a REAL
 *   Owner on first deploy — the real person's Discord snowflake, so their first
 *   sign-in resolves the Owner member. The dev fixture is never valid for prod.
 */
export async function seedDevOwner(ds: DataSource): Promise<void> {
  const ownerDiscordId = process.env.OWNER_DISCORD_ID?.trim() || OWNER_DISCORD_USER_ID;
  const ownerName = process.env.OWNER_NAME?.trim() || 'Lord Commander';
  const isRealOwner = !!process.env.OWNER_DISCORD_ID?.trim();

  const identity = await ensure(
    ds.getRepository(DiscordIdentity),
    { id: OWNER_IDENTITY_ID },
    {
      discordUserId: ownerDiscordId,
      discordTag: isRealOwner ? null : '@lord_commander',
      discordUsername: isRealOwner ? null : 'lord_commander',
      globalName: ownerName,
      avatarUrl: null,
      guildMember: true,
      scopes: 'identify email',
    },
  );

  const generalRank = await ds
    .getRepository(Rank)
    .findOneOrFail({ where: { regimentId: REGIMENT_ID, name: 'General' } });

  const member = await ensure(
    ds.getRepository(Member),
    { id: OWNER_MEMBER_ID },
    {
      regimentId: REGIMENT_ID,
      discordIdentityId: identity.id,
      rankId: generalRank.id,
      name: ownerName,
      inGameName: isRealOwner ? null : 'Lord_Commander',
      role: MemberRole.Owner,
      status: MemberStatus.Active,
      platform: Platform.Steam,
      timezone: 'America/Toronto',
      discordLinked: true,
      standing: 'Good Order',
      joinedAt: new Date('2021-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-06-22T00:00:00.000Z'),
    },
  );

  await ds.getRepository(Regiment).update({ id: REGIMENT_ID }, { ownerMemberId: member.id });
}
