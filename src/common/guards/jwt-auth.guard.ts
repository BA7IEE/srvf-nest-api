import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

// JwtAuthGuard:全局注册(顺序在 RolesGuard 之前),先验登录。
// 通过 Reflector 识别 @Public() 元数据放行;否则交给 passport 的 JWT strategy。
//
// override handleRequest:strategy.validate() 抛 BizException 时直接 rethrow
// 让 AllExceptionsFilter 处理为统一响应,避免被 passport 默认转成
// UnauthorizedException(那样会丢失 BizCode)。
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser = CurrentUserPayload>(err: unknown, user: TUser | false): TUser {
    if (err instanceof BizException) throw err;
    if (err instanceof Error) throw err;
    if (!user) throw new BizException(BizCode.UNAUTHORIZED);
    return user;
  }
}
