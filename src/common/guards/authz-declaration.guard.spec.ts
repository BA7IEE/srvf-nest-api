import { Get, Logger, type ExecutionContext } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { LoginOnly } from '../decorators/route-authz.decorator';
import { Public } from '../decorators/public.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
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

  it('rejects an undeclared HTTP handler in enforce mode', () => {
    class UndeclaredController {
      handler(this: void): void {}
    }

    const guard = new AuthzDeclarationGuard(new Reflector());
    let thrown: unknown;
    try {
      guard.canActivate(contextFor(UndeclaredController.prototype.handler, UndeclaredController));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BizException);
    expect((thrown as BizException).biz).toBe(BizCode.AUTHZ_UNDECLARED);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_undeclared',
        mode: 'enforce',
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
        mode: 'enforce',
        totalUndeclaredRouteCount: 1,
      }),
      expect.any(String),
    );

    let thrown: unknown;
    try {
      guard.canActivate(contextFor(InventoryController.prototype.undeclared, InventoryController));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BizException);
    expect((thrown as BizException).biz).toBe(BizCode.AUTHZ_UNDECLARED);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_undeclared',
        mode: 'enforce',
        totalUndeclaredRouteCount: 1,
        observedUndeclaredRouteCount: 1,
      }),
      expect.any(String),
    );
  });
});
