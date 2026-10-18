import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import appConfig, { type AppConfig } from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { RbacService } from '../permissions/rbac.service';
import { httpServer } from '../../../test/helpers/http-server';
import { ContributionRulesController } from './contribution-rules.controller';
import { ContributionRulesService } from './contribution-rules.service';

// A narrow HTTP integration with a synthetic principal and provider doubles.
// No AppModule, database, JWT/route guard or production admission is exercised.
describe('E5 legacy rule HTTP errors with synthetic authentication', () => {
  let app: INestApplication | undefined;
  const actor: CurrentUserPayload = {
    id: 'http-test-actor',
    username: 'http-test',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const transaction = jest.fn();
  const audit = { log: jest.fn() };
  const rbac = { can: jest.fn() };
  const commands = [
    [
      'post',
      '',
      'contribution.create.rule',
      { activityTypeCode: 'service', attendanceRoleCode: 'member', pointsBelow: 1 },
    ],
    ['patch', '/synthetic-rule', 'contribution.update.rule', { remark: 'synthetic update' }],
    ['delete', '/synthetic-rule', 'contribution.delete.rule', {}],
  ] as const;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ContributionRulesController],
      providers: [
        ContributionRulesService,
        {
          provide: appConfig.KEY,
          useValue: {
            env: 'test',
            contributionSettlementMode: 'active',
          } satisfies Partial<AppConfig>,
        },
        { provide: PrismaService, useValue: { $transaction: transaction } },
        { provide: AuditLogsService, useValue: audit },
        { provide: RbacService, useValue: rbac },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.use((req: Request & { user?: CurrentUserPayload }, _res: Response, next: NextFunction) => {
      req.user = actor;
      next();
    });
    app.useGlobalFilters(new AllExceptionsFilter(true));
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rbac.can.mockResolvedValue(true);
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(commands)(
    'returns actual409/23013 for %s, including the declared204 delete route',
    async (method, suffix, permission, body) => {
      if (!app) throw new Error('HTTP fixture unavailable');
      const response = await request(httpServer(app))
        [method]('/api/system/v1/contribution-rules' + suffix)
        .send(body);
      expect(response.status).toBe(BizCode.CONTRIBUTION_RULE_READONLY.httpStatus);
      expect(response.body).toEqual({
        code: 23013,
        message: BizCode.CONTRIBUTION_RULE_READONLY.message,
        data: null,
      });
      expect(rbac.can).toHaveBeenCalledWith(actor, permission);
      expect(transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(commands)(
    'preserves actual403/30100 ahead of readonly for %s',
    async (method, suffix, permission, body) => {
      if (!app) throw new Error('HTTP fixture unavailable');
      rbac.can.mockResolvedValue(false);
      const response = await request(httpServer(app))
        [method]('/api/system/v1/contribution-rules' + suffix)
        .send(body);
      expect(response.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
      expect(response.body).toEqual({
        code: 30100,
        message: BizCode.RBAC_FORBIDDEN.message,
        data: null,
      });
      expect(rbac.can).toHaveBeenCalledWith(actor, permission);
      expect(transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );
});
