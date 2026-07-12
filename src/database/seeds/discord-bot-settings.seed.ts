import { DataSource } from 'typeorm';
import { DiscordBotSettings } from '../../discord/entities/discord-bot-settings.entity';
import { ensure, REGIMENT_ID } from './seed.util';

/**
 * A default, DORMANT Discord bot config for the seeded regiment: the bot is
 * disabled (nothing is enqueued) and the sensitive apply-Ban-role-on-ban is off.
 * An admin turns the bot on and wires channels/roles from the Settings UI once
 * real credentials exist.
 */
export async function seedDiscordBotSettings(ds: DataSource): Promise<void> {
  await ensure(
    ds.getRepository(DiscordBotSettings),
    { regimentId: REGIMENT_ID },
    {
      botEnabled: false,
      joinRoleName: 'Guest',
      welcomeMessage: 'Welcome to the Lords Regiment! An officer will be with you shortly.',
      syncRolesOnChange: true,
      applyBanRoleOnBan: false,
    },
  );
}
