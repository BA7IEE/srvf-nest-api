import { Logger, Module, type OnModuleInit } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { SmsModule } from '../sms/sms.module';
import { BirthdayGreetingService } from './birthday-greeting.service';

// B 队列 F5-T2(2026-06-11):notifications 模块——G-7(通知/短信/推送)首个落地点
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6.3)。
//
// 本期仅承载生日祝福 job(零端点 / 零权限码 / 零 DTO);
// 通知/推送的统一出口策略仍待 Effect 真出现时决议(architecture-boundary §3.6),
// 后续新通知类型先回评审,不在本模块自由生长。
//
// onModuleInit 锚行:docker-smoke 以 grep 本行确证 ScheduleModule.forRoot() 在
// 生产镜像内装配成功且生日 job 完成注册(评审稿 E-B10;改动本文案需同步
// .github/workflows/docker-smoke.yml 的 grep 步骤)。
@Module({
  imports: [DatabaseModule, SmsModule],
  providers: [BirthdayGreetingService],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  onModuleInit(): void {
    this.logger.log('Birthday greeting cron registered (09:00 Asia/Shanghai)');
  }
}
