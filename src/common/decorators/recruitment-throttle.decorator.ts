import { SetMetadata } from '@nestjs/common';

// 招新一期 T3(2026-06-18):招新报名公开端点限流装饰器(第 9 个独立 throttler 实例)。
// 镜像 login-wechat-throttle 范式(纯 metadata;limit/ttl 从 app.config 注入,物理隔离不影响其它八实例)。
// 评审稿 E-R-25:open/v1 公开报名/查询两端点挂 @RecruitmentThrottle(),防重复/高频提交 + 配合付费核验成本纪律。

export const RECRUITMENT_THROTTLE_KEY = 'recruitment-throttle:enabled';
export const RECRUITMENT_THROTTLER_NAME = 'recruitment';

export const RecruitmentThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RECRUITMENT_THROTTLE_KEY, true);
