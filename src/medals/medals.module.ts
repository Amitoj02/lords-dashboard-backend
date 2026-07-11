import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Medal } from './entities/medal.entity';
import { MemberMedal } from './entities/member-medal.entity';
import { MedalsController } from './medals.controller';
import { MedalsService } from './medals.service';

/**
 * Medal catalogue module. Registers the medal lookup table plus the member_medals
 * junction (read-only here, for the derived holder/award counts). AuditService is
 * provided globally by AuditModule, so it is not imported here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Medal, MemberMedal])],
  controllers: [MedalsController],
  providers: [MedalsService],
  exports: [MedalsService],
})
export class MedalsModule {}
