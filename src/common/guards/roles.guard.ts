import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

// RolesGuard:全局注册(顺序在 JwtAuthGuard 之后)。详见 ARCHITECTURE.md §7.6 +
// CLAUDE.md §8。
//
// 规则:
// - 接口未标 @Roles(...) → 直接放行(只要 JwtAuthGuard 已通过)
// - 接口标了 @Roles(...) 但 request.user 为空 → 抛 UNAUTHORIZED
//   (而非 FORBIDDEN,这是文档明确铁律,防止 @Public() + @Roles(...) 错配
//    组合默默泄露权限接口)
// - request.user.role 不在允许列表 → 抛 FORBIDDEN
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();
    if (!request.user) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }

    if (!requiredRoles.includes(request.user.role)) {
      throw new BizException(BizCode.FORBIDDEN);
    }

    return true;
  }
}
