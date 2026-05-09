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
// 关于 app.listen(0)(issue #1 修复,2026-05):
// supertest 7.x 的 lib/test.js#serverAddress 在 server 未 listen 时会自动调
// `app.listen(0)` 启动一个临时端口,并在每次 request `end()` 后调 `server.close()`。
// 整个 spec 的 supertest 调用共享同一个 NestJS httpServer 实例,导致 server 在每个
// request 之间反复 listen/close,产生 socket race:新 request 撞上正在关闭的 listener,
// 表现为 `status=404/426 + body={}`、`Parse Error: Expected HTTP/`、`read ECONNRESET`
// (issue #1 描述的 transport 级抖动)。
// 修复方法:在 app.init() 之后显式 `app.listen(0)`,让 OS 分配一个临时端口,server
// 持久监听到 spec 结束;supertest 的 serverAddress 看到 address 不为 null 就跳过
// 自己的 listen,end() 也不会触碰 server 生命周期,所有 request 共享一个稳定的 listener。
// app.close() 仍由 spec 的 afterAll 调用,负责优雅关闭(stop accepting → drain →
// PrismaService.$disconnect),与 detectOpenHandles 兼容。
//
// 不做的事:
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
  await app.listen(0);
  return app;
}
