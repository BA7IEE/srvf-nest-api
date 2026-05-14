import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { Request } from 'express';

// 当前登录用户的形状(详见 ARCHITECTURE.md §7.6)。
// JwtStrategy.validate() 返回的对象由 passport 自动挂到 request.user 上,
// 字段必须与本接口一致。第 7 阶段接入 auth 时落地具体填充逻辑。
//
// V2.x C-6 RBAC 实施 PR #6(2026-05-14):新增 memberId 字段(沿 D7 v1.1 §8.2 / §8.3
// owner 判定)。User.memberId 是 V2 第一阶段批次 5 引入的可空外键(沿 ARCHITECTURE.md §12.8);
// 取值规则:用户未绑定 member 时为 null。
//
// **v1 14 接口契约不变**:本字段仅扩展服务端 CurrentUserPayload 形状,**不**进入任何
// response DTO / 出参 schema。v1 14 / V2 79 既有 controller 即使读 `user.memberId`
// 也只用于内部判定,不向 client 暴露。
export interface CurrentUserPayload {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  memberId: string | null;
}

// 用法:async getMe(@CurrentUser() user: CurrentUserPayload) { ... }
// 信任 JwtAuthGuard 已挂载 user;若 user 缺失,前置 Guard 已抛 UNAUTHORIZED。
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const request = ctx.switchToHttp().getRequest<Request & { user: CurrentUserPayload }>();
    return request.user;
  },
);
