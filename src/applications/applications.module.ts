import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { Application } from './entities/application.entity';

/**
 * Recruitment applications: applicant self-submit + the staff review queue.
 * Creates the roster Member directly via the Member repository on approval to
 * avoid coupling to MembersModule. AuditService is global (no import needed).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Application, Member, Rank, DiscordIdentity, RegimentSettings]),
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
