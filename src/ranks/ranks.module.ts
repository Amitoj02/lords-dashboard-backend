import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordModule } from '../discord/discord.module';
import { Member } from '../members/entities/member.entity';
import { StorageModule } from '../storage/storage.module';
import { Rank } from './entities/rank.entity';
import { RanksController } from './ranks.controller';
import { RanksService } from './ranks.service';

/**
 * Rank ladder module. Registers the Rank repository plus Member (read-only) for
 * the holder counts and the delete-in-use guard. StorageModule provides the
 * presign key→URL resolver for rank images. AuditService is provided globally by
 * AuditModule, so it is not imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Rank, Member]),
    StorageModule,
    // For the bulk role re-link when a rank's Discord role changes (T-0158).
    // DiscordModule exports DiscordSyncService and does not import this one.
    DiscordModule,
  ],
  controllers: [RanksController],
  providers: [RanksService],
  exports: [RanksService],
})
export class RanksModule {}
