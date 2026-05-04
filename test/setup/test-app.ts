import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { applyGlobalSetup } from '../../src/bootstrap/apply-global-setup';
import { applySwagger } from '../../src/bootstrap/apply-swagger';
import type { AppConfig } from '../../src/config/app.config';

// E2E 测试唯一的 NestApplication 工厂。
// 必须与 src/main.ts bootstrap() 的全局配置严格一致——双方共享 applyGlobalSetup
// 与 applySwagger,任何全局 pipe / filter / interceptor / 前缀 / CORS / Swagger
// 注册的调整都改在 bootstrap/ 下,test 自动跟上,避免漂移。
//
// 默认带 Swagger:.env.test 设置 ENABLE_SWAGGER=true,appCfg.swaggerEnabled=true,
// /api/docs* 在测试环境可达,横切 spec(swagger.e2e-spec.ts)需要据此验证
// ResponseInterceptor 的 SKIP_PREFIXES 跳过逻辑。
//
// 不做的事:
// - 不调用 app.listen():supertest 直接通过 app.getHttpServer() 走内存 HTTP
// - 不注入 fixtures:每个 spec 自行造数据,保证隔离
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // 静默 NestJS 内置 Logger:E2E 输出只关心用例 PASS/FAIL,不需要 Routes/Provider
  // 初始化日志噪音。必须在 app.init() 之前调用,才能挡住启动阶段日志。
  // 副作用:业务代码里 logger.error/warn 也会被静默——E2E 用响应断言判定,
  // 真错误靠 Jest 的 stack trace,不靠日志,可接受。
  app.useLogger(false);

  const configService = app.get(ConfigService);
  const appCfg = configService.get<AppConfig>('app');
  if (!appCfg) {
    throw new Error('app.config 未加载,createTestApp 中止');
  }

  applyGlobalSetup(app, appCfg);
  applySwagger(app, appCfg);

  await app.init();
  return app;
}
