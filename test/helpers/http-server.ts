import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';

// NestJS 的 `app.getHttpServer()` 在类型层面返回 `any`(底层平台无关,
// Express/Fastify 等返回的 server 实例对 NestJS 是不透明的)。直接把 `any`
// 喂给 supertest 的 `request()` 会触发 `@typescript-eslint/no-unsafe-argument`,
// 把它收敛在这一个 helper 里,test 调用点就能保持 0 warnings。
//
// 使用:`request(httpServer(app))` 替代 `request(app.getHttpServer())`。
export function httpServer(app: INestApplication): App {
  return app.getHttpServer() as App;
}
