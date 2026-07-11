import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimentEvent } from '../events/entities/event.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentsController } from './regiments.controller';
import { RegimentsService } from './regiments.service';
import { RegimentSettings } from './entities/regiment-settings.entity';
import { Regiment } from './entities/regiment.entity';

/**
 * Regiment module. Exposes the public profile + landing statistics endpoints.
 * Registers the regiment/settings repositories plus members and events, which
 * the service aggregates for the stat counters.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Regiment, RegimentSettings, Member, RegimentEvent])],
  controllers: [RegimentsController],
  providers: [RegimentsService],
  exports: [RegimentsService],
})
export class RegimentsModule {}
