import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { DiscordModule } from '../discord/discord.module';
import { EventsModule } from '../events/events.module';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { StorageModule } from '../storage/storage.module';
import { GalleryModule } from '../gallery/gallery.module';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import { Member } from './entities/member.entity';
import { ServiceRecordEntry } from './entities/service-record-entry.entity';
import { UsernameReservation } from './entities/username-reservation.entity';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberAvatarService } from './public/member-avatar.service';
import { PublicMembersController } from './public/public-members.controller';
import { PublicMembersService } from './public/public-members.service';
import { UsernameService } from './username.service';

/**
 * Roster module. Registers the repositories the service reads from/writes to:
 * members + joined rank/identity, events + attendees (attendance metrics),
 * medals + member_medals (award/remove + medal display), service-record and
 * account-deletion (admin actions + GDPR), and the regiment (owner guard).
 * AuditService is provided globally by AuditModule, so it is not imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Member,
      Rank,
      DiscordIdentity,
      EventAttendee,
      Medal,
      MemberMedal,
      ServiceRecordEntry,
      AccountDeletionRequest,
      Regiment,
      // Vanity handles: the reservation ledger, plus the settings row the
      // anonymous surface resolves the single-tenant regiment from (T-0215).
      UsernameReservation,
      RegimentSettings,
    ]),
    // For enqueuing Discord role syncs on rank/role/medal changes and the
    // (flag-gated) kick on ban. DiscordModule exports DiscordSyncService.
    DiscordModule,
    // Resolves uploaded avatar/banner keys to public URLs (StorageService).
    StorageModule,
    // Reuses the events projection for the per-member events/RSVP profile tabs.
    EventsModule,
    // The public profile lists a member's approved gallery contributions, and
    // the avatar proxy reuses MediaEmbedService's capped reader.
    GalleryModule,
  ],
  controllers: [MembersController, PublicMembersController],
  providers: [MembersService, PublicMembersService, UsernameService, MemberAvatarService],
  // PublicMembersService and MemberAvatarService are exported for the SEO module,
  // which renders the same data as crawler-facing HTML from the same predicate.
  exports: [MembersService, PublicMembersService, MemberAvatarService],
})
export class MembersModule {}
