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
 * Dev fixture: an owner identity + member so admin flows and /auth/me are
 * testable without a live Discord login. In production the owner is established
 * by the onboarding wizard.
 */
export async function seedDevOwner(ds: DataSource): Promise<void> {
  const identity = await ensure(
    ds.getRepository(DiscordIdentity),
    { id: OWNER_IDENTITY_ID },
    {
      discordUserId: OWNER_DISCORD_USER_ID,
      discordTag: '@lord_commander',
      discordUsername: 'lord_commander',
      globalName: 'Lord Commander',
      avatarUrl: null,
      guildMember: true,
      scopes: 'identify email guilds',
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
      name: 'Lord Commander',
      inGameName: 'Lord_Commander',
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
