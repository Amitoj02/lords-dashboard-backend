import { DataSource } from 'typeorm';
import { RegimentSettings } from '../../regiments/entities/regiment-settings.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';
import { ensure, REGIMENT_ID } from './seed.util';

export async function seedRegiment(ds: DataSource): Promise<void> {
  // A genuine greenfield deploy (a real OWNER_DISCORD_ID is provisioned) starts
  // with setup INCOMPLETE so the real Owner is guided into first-run setup
  // (T-0037/T-0056). The dev fixture (no OWNER_DISCORD_ID) is treated as already
  // set up, so dev/e2e sign-ins land straight on the dashboard.
  // NOTE: seed is a first-deploy provisioning tool — re-running it with
  // OWNER_DISCORD_ID set after the Owner has finished setup would reset the flag.
  const isRealDeploy = !!process.env.OWNER_DISCORD_ID?.trim();
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
      setupComplete: !isRealDeploy,
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
