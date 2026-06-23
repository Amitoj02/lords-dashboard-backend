import { DataSource } from 'typeorm';
import { Rank } from '../../ranks/entities/rank.entity';
import { ensure, REGIMENT_ID } from './seed.util';

/** Default rank ladder (precedence 1 = highest). Applicant is the entry rank. */
const LADDER = [
  { name: 'General', chevrons: 5, precedence: 1, discordRoleName: '@General' },
  { name: 'Colonel', chevrons: 5, precedence: 2, discordRoleName: '@Colonel' },
  { name: 'Major', chevrons: 4, precedence: 3, discordRoleName: '@Major' },
  { name: 'Captain', chevrons: 4, precedence: 4, discordRoleName: '@Captain' },
  { name: 'Lieutenant', chevrons: 3, precedence: 5, discordRoleName: '@Lieutenant' },
  { name: 'Sergeant', chevrons: 3, precedence: 6, discordRoleName: '@Sergeant' },
  { name: 'Corporal', chevrons: 2, precedence: 7, discordRoleName: '@Corporal' },
  { name: 'Private, First Class', chevrons: 1, precedence: 8, discordRoleName: '@Private1C' },
  { name: 'Private', chevrons: 1, precedence: 9, discordRoleName: '@Private' },
  { name: 'Recruit', chevrons: 0, precedence: 10, discordRoleName: '@Recruit' },
  { name: 'Mercenary', chevrons: 0, precedence: 11, discordRoleName: '@Mercenary' },
  { name: 'Applicant', chevrons: 0, precedence: 12, discordRoleName: null },
];

export async function seedRanks(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(Rank);
  for (const rank of LADDER) {
    await ensure(
      repo,
      { regimentId: REGIMENT_ID, name: rank.name },
      {
        chevrons: rank.chevrons,
        precedence: rank.precedence,
        discordRoleName: rank.discordRoleName,
        linked: false,
      },
    );
  }
}
