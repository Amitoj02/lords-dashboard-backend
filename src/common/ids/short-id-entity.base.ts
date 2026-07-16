import { PrimaryColumn } from 'typeorm';

/**
 * Base class for entities whose primary key is a 12-char base62 short id
 * (T-0082). Deliberately column-only (no methods) so plain-object test fixtures
 * typed as the entity stay valid. The id is minted at insert time by
 * {@link ShortIdSubscriber} when not already set. Entities in the
 * security-retained set (discord_identities, discord_sync_jobs) keep their uuid
 * PKs and do NOT extend this.
 */
export abstract class ShortIdEntity {
  @PrimaryColumn({ type: 'char', length: 12 })
  id: string;
}
