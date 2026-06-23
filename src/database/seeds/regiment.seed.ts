import { DataSource } from 'typeorm';
import { RegimentSettings } from '../../regiments/entities/regiment-settings.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';
import { ensure, REGIMENT_ID } from './seed.util';

export async function seedRegiment(ds: DataSource): Promise<void> {
  await ensure(
    ds.getRepository(Regiment),
    { id: REGIMENT_ID },
    {
      name: 'Lords Regiment',
      shortTag: 'LORDS',
      missionStatement:
        'Discipline, honour, and the line. A Holdfast: Nations at War regiment of standing.',
      accentTone: 'brass',
      establishedYear: 2021,
      setupStep: 5,
      setupComplete: true,
    },
  );

  await ensure(
    ds.getRepository(RegimentSettings),
    { regimentId: REGIMENT_ID },
    {
      galleryAllowedImageTypes: ['jpg', 'png', 'webp'],
      galleryAllowedVideoTypes: ['mp4', 'webm', 'mov'],
      eventDefaultNotifyBefore: [60, 15],
      eventDefaultTimezone: 'America/Toronto',
    },
  );
}
