import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimentEvent } from '../events/entities/event.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentsController } from './regiments.controller';
import { RegimentsService } from './regiments.service';
import { RegimentDocument } from './entities/regiment-document.entity';
import { RegimentSettings } from './entities/regiment-settings.entity';
import { Regiment } from './entities/regiment.entity';

/**
 * Regiment module. Exposes the public profile, landing statistics and the
 * anonymous legal-document reads. Registers the regiment/settings repositories
 * plus members and events (which the service aggregates for the stat counters)
 * and regiment_documents (T-0149) — the public legal pages are reached before
 * sign-in, so they cannot go through the capability-gated settings routes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Regiment, RegimentSettings, Member, RegimentEvent, RegimentDocument]),
  ],
  controllers: [RegimentsController],
  providers: [RegimentsService],
  exports: [RegimentsService],
})
export class RegimentsModule {}
