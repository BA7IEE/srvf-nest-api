import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { applyGlobalSetup } from '../../src/bootstrap/apply-global-setup';
import type { AppConfig } from '../../src/config/app.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';

const PROBE_PATH = '/api/system/v1/authz-declaration-enforce-probe';

let handlerInvocationCount = 0;

// This controller deliberately has no route-authorization decorator. It exists only inside the
// testing module, so production's controller inventory and OpenAPI contract remain unchanged.
@Controller('system/v1/authz-declaration-enforce-probe')
class UndeclaredAuthzProbeController {
  @Get()
  probe(): { reached: true } {
    handlerInvocationCount += 1;
    return { reached: true };
  }
}

async function createEnforceProbeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [UndeclaredAuthzProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();

  try {
    app.useLogger(false);
    const appConfig = app.get(ConfigService).get<AppConfig>('app');
    if (!appConfig) throw new Error('app.config 未加载,AuthzDeclarationGuard enforce probe 中止');
    applyGlobalSetup(app, appConfig);
    await app.init();
    await app.listen(0);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

describe('AuthzDeclarationGuard enforce red-first probe', () => {
  let app: INestApplication;
  let authHeader: string;

  beforeAll(async () => {
    app = await createEnforceProbeApp();
    await resetDb(app);
    await createTestUser(app, {
      username: 'authz-enforce-probe',
      role: Role.USER,
    });
    authHeader = (await loginAs(app, 'authz-enforce-probe')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an undeclared HTTP route with AUTHZ_UNDECLARED before its handler runs', async () => {
    handlerInvocationCount = 0;

    const response = await request(httpServer(app))
      .get(PROBE_PATH)
      .set('Authorization', authHeader);

    // Red-first proof: in report mode this is 1 and the test must fail. After the single mode
    // switch it remains 0, proving the real global Guard rejects before controller execution.
    expect(handlerInvocationCount).toBe(0);
    expectBizError(response, BizCode.AUTHZ_UNDECLARED);
  });
});
