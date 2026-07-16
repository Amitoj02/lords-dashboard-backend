import { EntitySubscriberInterface, EventSubscriber, InsertEvent } from 'typeorm';
import { generateShortId } from './short-id';

/**
 * Global TypeORM subscriber that mints a 12-char short id at insert time for any
 * entity whose primary key is a single `char(12)` `id` column (i.e. every
 * {@link ShortIdEntity}) when the id is not already set (T-0082). Keyed on
 * column metadata rather than a base-class method so entities carry no extra
 * structural members (test fixtures stay plain objects). Retained-uuid tables
 * (discord_identities, discord_sync_jobs) and composite-PK junctions are
 * naturally excluded — their PK is not a single char(12) `id`.
 *
 * Discovered via `@EventSubscriber()` (global metadata store) and also listed in
 * the shared data-source `subscribers`, so it applies uniformly to the Nest
 * runtime, the CLI, seeds, and e2e. Fires on `.save()` (entity listeners) —
 * every short-id entity is created through `save()`; the composite-PK junctions
 * written via `.insert()` supply their full PK. The `id == null` guard keeps it
 * idempotent if registered twice.
 */
@EventSubscriber()
export class ShortIdSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<{ id?: string | null }>): void {
    const entity = event.entity;
    if (!entity) {
      return;
    }
    const pk = event.metadata.primaryColumns;
    if (
      pk.length === 1 &&
      pk[0].propertyName === 'id' &&
      pk[0].type === 'char' &&
      String(pk[0].length) === '12' &&
      entity.id == null
    ) {
      entity.id = generateShortId();
    }
  }
}
