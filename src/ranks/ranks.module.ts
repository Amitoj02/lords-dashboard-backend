import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from '../members/entities/member.entity';
import { Rank } from './entities/rank.entity';
import { RanksController } from './ranks.controller';
import { RanksService } from './ranks.service';

/**
 * Rank ladder module. Registers the Rank repository plus Member (read-only) for
 * the holder counts and the delete-in-use guard. AuditService is provided
 * globally by AuditModule, so it is not imported here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Rank, Member])],
  controllers: [RanksController],
  providers: [RanksService],
  exports: [RanksService],
})
export class RanksModule {}
