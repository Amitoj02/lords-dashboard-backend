import { DataSource } from 'typeorm';
import { Rank } from '../../ranks/entities/rank.entity';
import { ensure, REGIMENT_ID } from './seed.util';

/** Default rank ladder (precedence 1 = highest). Applicant is the entry rank. */
const LADDER = [
  { name: 'General', precedence: 1, discordRoleName: '@General' },
  { name: 'Colonel', precedence: 2, discordRoleName: '@Colonel' },
  { name: 'Major', precedence: 3, discordRoleName: '@Major' },
  { name: 'Captain', precedence: 4, discordRoleName: '@Captain' },
  { name: 'Lieutenant', precedence: 5, discordRoleName: '@Lieutenant' },
  { name: 'Sergeant', precedence: 6, discordRoleName: '@Sergeant' },
  { name: 'Corporal', precedence: 7, discordRoleName: '@Corporal' },
  { name: 'Private, First Class', precedence: 8, discordRoleName: '@Private1C' },
  { name: 'Private', precedence: 9, discordRoleName: '@Private' },
  { name: 'Recruit', precedence: 10, discordRoleName: '@Recruit' },
  { name: 'Mercenary', precedence: 11, discordRoleName: '@Mercenary' },
  { name: 'Applicant', precedence: 12, discordRoleName: null },
];

export async function seedRanks(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(Rank);
  for (const rank of LADDER) {
    await ensure(
      repo,
      { regimentId: REGIMENT_ID, name: rank.name },
      {
        precedence: rank.precedence,
        discordRoleName: rank.discordRoleName,
        linked: false,
      },
    );
  }
}
