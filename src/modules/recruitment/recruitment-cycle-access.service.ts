import { Injectable } from '@nestjs/common';
import { type RecruitmentCycle } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {} from '../realname/realname.constants';
import { CYCLE_STATUS_OPEN } from './recruitment.constants';
import {} from './recruitment-identity.service';
import {} from './recruitment-progress-presenter';
import {} from './recruitment-applications.presenter';
import type {} from './recruitment.dto';

/*
 * 招新**当前开放周期**的查找与容量预检(Phase 6-B 第三域第四刀,§3.2)。
 *
 * 两个方法被 OCR 族(recognize 前置)与报名主链(submit 前置)**双方**使用,
 * 故降为共享底座 —— 不先降,被抽出的 OCR 族就得 import 回主 service(循环依赖)。
 *
 * ⚠️ resolveOpenCycleOrThrow 的容量预检是**快速失败**,不是权威闸:
 * 它省的是"满员场景下白烧一次付费 OCR"。真正的原子兜底在 issueTempNo 的行锁内
 * (FM-C:并发 TOCTOU 与人工 resolve 旁路都只有那里挡得住)。
 * 把这里的预检当成唯一闸会重新打开超发窗口。
 */
@Injectable()
export class RecruitmentCycleAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // 当前唯一 open 轮(无 → 28030);**不卡容量**(识别端点用;OCR 改造 §4)
  async findOpenCycleOrThrow(): Promise<RecruitmentCycle> {
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
    }
    return cycle;
  }

  // open 轮 + 容量预检(提交端用;满 → 28031 快速失败省付费 OCR;原子兜底在 issueTempNo,FM-C)。
  // 十项收口刀A:预检口径由「verified 现员数」对齐权威闸的 tempNoSeq 累计口径——verified 现员数
  // 随推进/淘汰下降而 tempNo 永不回收,旧口径系统性偏松,恰在满员场景放行 → 烧付费 OCR 后被
  // 权威闸 28031 整单回滚。同口径后预检 = 权威闸的无锁快照(轻微陈旧无害),并省一次 count 查询。
  async resolveOpenCycleOrThrow(): Promise<RecruitmentCycle> {
    const cycle = await this.findOpenCycleOrThrow();
    if (cycle.capacity !== null && cycle.tempNoSeq >= cycle.capacity) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
    }
    return cycle;
  }
}
