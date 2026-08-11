import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
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

// Nest's ExecutionContext currently exposes the handler as Function; keep the framework's exact
// contract behind a named alias instead of widening our own API with a bare Function annotation.
type RouteHandler = ReturnType<ExecutionContext['getHandler']>;
type RouteMetadataTarget = RouteHandler | Type<unknown>;

@Injectable()
export class AuthzDeclarationGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(AuthzDeclarationGuard.name);
  private readonly metadataScanner = new MetadataScanner();
  // This is a startup inventory, not a request-derived measurement. It is the
  // authoritative report-mode progress number for declaration backfill.
  private totalUndeclaredRouteCount: number | null = null;
  // Observability only: this Set is never read to make an access decision and
  // deliberately tracks handlers, not URLs containing user-supplied params.
  private readonly observedUndeclaredRoutes = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly modulesContainer: ModulesContainer = new ModulesContainer(),
  ) {}

  onApplicationBootstrap(): void {
    this.totalUndeclaredRouteCount = this.countUndeclaredHttpRoutes();
    this.logger.log(
      {
        event: 'authz_declaration_inventory',
        mode: AUTHZ_DECLARATION_MODE,
        totalUndeclaredRouteCount: this.totalUndeclaredRouteCount,
      },
      'Route authorization declaration inventory',
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const handler = context.getHandler();
    const controller = context.getClass();
    const route = `${controller.name}.${handler.name}`;
    let declaration;
    try {
      declaration = this.normalizedDeclaration(handler, controller);
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
          totalUndeclaredRouteCount: this.totalUndeclaredRouteCount,
          observedUndeclaredRouteCount: this.observedUndeclaredRoutes.size,
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

  private countUndeclaredHttpRoutes(): number {
    let total = 0;
    for (const module of this.modulesContainer.values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        const instance = wrapper.instance;
        if (controller === null || instance === null || instance === undefined) continue;
        const prototype = Object.getPrototypeOf(instance) as object | null;
        if (prototype === null) continue;
        for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
          const handler = Reflect.get(prototype, methodName) as unknown;
          if (typeof handler !== 'function') continue;
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          try {
            if (this.normalizedDeclaration(handler, controller) === null) total++;
          } catch {
            // Invalid declarations are also not enforceable, so the inventory
            // deliberately keeps them inside the remediation total.
            total++;
          }
        }
      }
    }
    return total;
  }

  private normalizedDeclaration(handler: RouteHandler, controller: RouteMetadataTarget) {
    const targets = [handler, controller];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
    const fragments = targets.flatMap(
      (target) =>
        (Reflect.getMetadata(ROUTE_AUTHZ_DECLARATION_KEY, target) as
          | RouteAuthzDeclarationFragment[]
          | undefined) ?? [],
    );
    return normalizeRouteAuthzDeclaration({ isPublic, fragments });
  }
}
