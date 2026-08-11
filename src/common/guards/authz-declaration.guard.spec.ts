import { Get, Logger } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { LoginOnly } from '../decorators/route-authz.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthzDeclarationGuard } from './authz-declaration.guard';

type Handler = (this: void) => void;
type Controller = new () => object;

function contextFor(handler: Handler, controller: Controller): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', originalUrl: '/api/test' }),
      getResponse: () => ({ once: jest.fn() }),
    }),
  } as unknown as ExecutionContext;
}

function modulesFor(...controllers: Controller[]): ModulesContainer {
  const modules = new ModulesContainer();
  modules.set('test', {
    controllers: new Map(
      controllers.map((controller) => [
        controller.name,
        { metatype: controller, instance: new controller() },
      ]),
    ),
  } as never);
  return modules;
}

describe('AuthzDeclarationGuard', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('reports an undeclared HTTP handler without blocking it in report mode', () => {
    class UndeclaredController {
      handler(this: void): void {}
    }

    const guard = new AuthzDeclarationGuard(new Reflector());
    const result = guard.canActivate(
      contextFor(UndeclaredController.prototype.handler, UndeclaredController),
    );

    expect(result).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_undeclared',
        mode: 'report',
        observedUndeclaredRouteCount: 1,
      }),
      expect.any(String),
    );
  });

  it('recognizes a declared handler and starts observation without an undeclared warning', () => {
    class DeclaredController {
      handler(this: void): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(DeclaredController.prototype, 'handler');
    if (!descriptor) throw new Error('test handler descriptor missing');
    LoginOnly()(DeclaredController.prototype, 'handler', descriptor);

    const guard = new AuthzDeclarationGuard(new Reflector());
    const result = guard.canActivate(
      contextFor(DeclaredController.prototype.handler, DeclaredController),
    );

    expect(result).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authz_declaration_undeclared' }),
      expect.any(String),
    );
  });

  it('logs a static inventory separately from traffic-observed undeclared routes', () => {
    class InventoryController {
      @Get('undeclared')
      undeclared(this: void): void {}

      @Get('declared')
      @LoginOnly()
      declared(this: void): void {}

      helper(this: void): void {}
    }

    class PublicController {
      @Get('public')
      @Public()
      publicRoute(this: void): void {}
    }

    const guard = new AuthzDeclarationGuard(
      new Reflector(),
      modulesFor(InventoryController, PublicController),
    );
    guard.onApplicationBootstrap();

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_inventory',
        mode: 'report',
        totalUndeclaredRouteCount: 1,
      }),
      expect.any(String),
    );

    expect(
      guard.canActivate(contextFor(InventoryController.prototype.undeclared, InventoryController)),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_undeclared',
        totalUndeclaredRouteCount: 1,
        observedUndeclaredRouteCount: 1,
      }),
      expect.any(String),
    );
  });
});
