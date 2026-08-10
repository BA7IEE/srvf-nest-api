import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { LoginOnly } from '../decorators/route-authz.decorator';
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

describe('AuthzDeclarationGuard', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
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
        undeclaredRouteCount: 1,
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
});
