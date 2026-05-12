import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ContributionRulesController } from './contribution-rules.controller';
import { ContributionRulesService } from './contribution-rules.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ContributionRulesController],
  providers: [ContributionRulesService],
})
export class ContributionRulesModule {}
