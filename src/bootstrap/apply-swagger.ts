import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '../config/app.config';

// 应用 Swagger 文档注册。main.ts 与 test/setup/test-app.ts 共用此函数,
// 与 applyGlobalSetup 同原则:避免 main.ts 与测试两边复制 Swagger 注册代码导致漂移
// (改了 main.ts 路径或选项,test 不跟,swagger spec 失效)。
//
// 内部判断 appCfg.swaggerEnabled,关闭则 no-op。
//
// 路径锚定:文档(ARCHITECTURE.md §6 / CLAUDE.md §4)固定 /api/docs。
// SwaggerModule 11 默认 setup() 不跟全局前缀,必须显式 useGlobalPrefix: true,
// 让其在 setGlobalPrefix('/api') 下注册到 /api/docs(及 /api/docs-json、/api/docs-yaml)。
export function applySwagger(app: INestApplication, appCfg: AppConfig): void {
  if (!appCfg.swaggerEnabled) return;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('U Nest API Starter')
    .setDescription('AI-friendly TypeScript API base — NestJS + Prisma + PostgreSQL')
    .setVersion('0.4.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: true,
  });
}
