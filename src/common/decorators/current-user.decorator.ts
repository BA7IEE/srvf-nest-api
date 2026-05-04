import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { Request } from 'express';

// 当前登录用户的形状(详见 ARCHITECTURE.md §7.6)。
// JwtStrategy.validate() 返回的对象由 passport 自动挂到 request.user 上,
// 字段必须与本接口一致。第 7 阶段接入 auth 时落地具体填充逻辑。
export interface CurrentUserPayload {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
}

// 用法:async getMe(@CurrentUser() user: CurrentUserPayload) { ... }
// 信任 JwtAuthGuard 已挂载 user;若 user 缺失,前置 Guard 已抛 UNAUTHORIZED。
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const request = ctx.switchToHttp().getRequest<Request & { user: CurrentUserPayload }>();
    return request.user;
  },
);
