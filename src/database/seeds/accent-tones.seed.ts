import { DataSource } from 'typeorm';
import { AccentTone } from '../../regiments/entities/accent-tone.entity';
import { ensure } from './seed.util';

const TONES = [
  { key: 'brass', label: 'Antique Brass', hex: '#bf9447', sortOrder: 1 },
  { key: 'crimson', label: 'Crimson', hex: '#8b2c2c', sortOrder: 2 },
  { key: 'royal', label: 'Royal Blue', hex: '#3b5bdb', sortOrder: 3 },
  { key: 'forest', label: 'Forest', hex: '#2d6a4f', sortOrder: 4 },
  { key: 'pewter', label: 'Pewter', hex: '#6c757d', sortOrder: 5 },
  { key: 'oxblood', label: 'Oxblood', hex: '#6b1a1a', sortOrder: 6 },
];

export async function seedAccentTones(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(AccentTone);
  for (const tone of TONES) {
    await ensure(repo, { key: tone.key }, tone);
  }
}
