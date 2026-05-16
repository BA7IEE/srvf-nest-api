import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { isProductionLike, type AppConfig } from '../config/app.config';

// 应用全局启动配置(helmet 安全头 / 全局前缀 / CORS / ValidationPipe / 全局异常过滤器 / 全局响应拦截器)。
// main.ts 与 test 套件 (createTestApp) 共用此函数,保证测试与运行时行为 1:1 一致;
// 任何 main.ts 里的全局设定调整都必须改在这里,而不是在 main.ts 里手写一份新的。
//
// 不在此函数内做的事:
// - NestFactory.create:由调用方负责,便于测试替换 AppModule overrides
// - app.listen:测试不监听端口,直接用 supertest 走 app.getHttpServer()
// - Swagger 注册:仅 main.ts 在生产/开发链路注册,测试不需要
// - 配置强校验:由 ConfigService 加载 app.config.ts 时触发,无需在此重复
export function applyGlobalSetup(app: INestApplication, appCfg: AppConfig): void {
  // V1.1 §11.2 / TASKS.md 15.6:HTTP 基线安全头(X-Content-Type-Options / X-Frame-Options /
  // Strict-Transport-Security / Referrer-Policy / X-DNS-Prefetch-Control 等),用 helmet 默认配置。
  //
  // /api/docs 路径局部禁 CSP:Swagger UI HTML 内含 inline `<script>`,helmet 默认 CSP
  // (`script-src 'self'`)会阻止其执行,导致页面白屏。仅对 docs 路径关闭 CSP,**禁止**全局关闭。
  // 其余安全头(包括 X-Frame-Options 等)在 docs 路径仍然生效,只 CSP 这一项放行。
  //
  // 中间件分发模式:预先创建两个 helmet 实例,按 req.path 选择,避免重复 helmet 调用导致
  // 后注册的 helmet({csp:false}) 无法清除前一个 helmet() 写入的 Content-Security-Policy 头
  // (helmet `csp:false` 只是不写,不会主动 removeHeader)。
  const helmetDefault = helmet();
  const helmetForSwagger = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/docs')) {
      return helmetForSwagger(req, res, next);
    }
    return helmetDefault(req, res, next);
  });

  app.setGlobalPrefix('/api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // production-like(production / smoke)隐藏异常 message;sanitize 沿 production 行为
  app.useGlobalFilters(new AllExceptionsFilter(isProductionLike(appCfg.env)));
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.enableCors({ origin: appCfg.corsOrigin });
}
