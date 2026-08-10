import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  beginAuthzRequestObservation,
  findAuthzObservationGap,
  normalizeRouteAuthzDeclaration,
  type RouteAuthzDeclarationFragment,
} from '../authz/authz-context';
import { ROUTE_AUTHZ_DECLARATION_KEY } from '../decorators/route-authz.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

export type AuthzDeclarationMode = 'report' | 'enforce';

// Phase 1A starts in report mode. Phase 1D changes only this value after all
// six enforce gates have independently passed.
export const AUTHZ_DECLARATION_MODE: AuthzDeclarationMode = 'report';

type ResponseWithFinishListener = {
  statusCode?: number;
  once?: (event: 'finish', listener: () => void) => unknown;
};

@Injectable()
export class AuthzDeclarationGuard implements CanActivate {
  private readonly logger = new Logger(AuthzDeclarationGuard.name);
  // Observability only: this Set is never read to make an access decision and
  // deliberately tracks handlers, not URLs containing user-supplied params.
  private readonly observedUndeclaredRoutes = new Set<string>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const handler = context.getHandler();
    const controller = context.getClass();
    const route = `${controller.name}.${handler.name}`;
    const targets = [handler, controller];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
    const fragments = targets.flatMap(
      (target) =>
        (Reflect.getMetadata(ROUTE_AUTHZ_DECLARATION_KEY, target) as
          | RouteAuthzDeclarationFragment[]
          | undefined) ?? [],
    );

    let declaration;
    try {
      declaration = normalizeRouteAuthzDeclaration({ isPublic, fragments });
    } catch (error) {
      this.logger.warn(
        {
          event: 'authz_declaration_invalid',
          mode: AUTHZ_DECLARATION_MODE,
          route,
          reason:
            error instanceof Error ? error.message : 'unknown declaration normalization failure',
        },
        'Route authorization declaration is invalid',
      );
      if (AUTHZ_DECLARATION_MODE === 'enforce') {
        throw new BizException(BizCode.AUTHZ_UNDECLARED);
      }
      return true;
    }

    if (declaration === null) {
      this.observedUndeclaredRoutes.add(route);
      const request = context
        .switchToHttp()
        .getRequest<{ method?: string; originalUrl?: string }>();
      this.logger.warn(
        {
          event: 'authz_declaration_undeclared',
          mode: AUTHZ_DECLARATION_MODE,
          route,
          method: request.method ?? 'UNKNOWN',
          path: request.originalUrl ?? 'UNKNOWN',
          undeclaredRouteCount: this.observedUndeclaredRoutes.size,
        },
        'Route has no authorization declaration',
      );
      if (AUTHZ_DECLARATION_MODE === 'enforce') {
        throw new BizException(BizCode.AUTHZ_UNDECLARED);
      }
      return true;
    }

    const observation = beginAuthzRequestObservation(declaration);
    const response = context.switchToHttp().getResponse<ResponseWithFinishListener>();
    response.once?.('finish', () => {
      // A later guard may have denied the request before its handler ran. Skip
      // non-success responses so observation never reports that as a missing
      // service assertion.
      if ((response.statusCode ?? 200) >= 400) return;
      const gap = findAuthzObservationGap(observation);
      if (!gap) return;
      this.logger.warn(
        {
          event: 'authz_declaration_observation_gap',
          route,
          mode: AUTHZ_DECLARATION_MODE,
          missingAdmission: gap.missingAdmission,
          missingCodes: gap.missingCodes,
          engine: gap.engine,
        },
        'Route declaration did not match observed authorization assertions',
      );
    });
    return true;
  }
}
