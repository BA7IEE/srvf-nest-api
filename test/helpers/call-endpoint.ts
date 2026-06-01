import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import { httpServer } from './http-server';

// 通用管理接口端点描述,与 supertest 配合使用动态调用任意 method/path/body 组合。
// 主要供 it.each 跨多端点参数化用例(如 role-boundary、soft-delete 副作用矩阵)。
//
// path 中含 __ID__ 占位符,callEndpoint 调用时用 targetId 替换;
// path 不含占位符的端点(GET /api/admin/v1/users / POST /api/admin/v1/users)直接传任意 targetId 即可,
// replace 是 no-op。
export interface AdminEndpoint {
  name: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  body?: object;
}

export async function callEndpoint(
  app: INestApplication,
  authHeader: string,
  ep: AdminEndpoint,
  targetId: string,
): Promise<Response> {
  const path = ep.path.replace('__ID__', targetId);
  const req = request(httpServer(app));
  switch (ep.method) {
    case 'get':
      return req.get(path).set('Authorization', authHeader);
    case 'delete':
      return req.delete(path).set('Authorization', authHeader);
    case 'post':
      return req
        .post(path)
        .set('Authorization', authHeader)
        .send(ep.body ?? {});
    case 'patch':
      return req
        .patch(path)
        .set('Authorization', authHeader)
        .send(ep.body ?? {});
    case 'put':
      return req
        .put(path)
        .set('Authorization', authHeader)
        .send(ep.body ?? {});
  }
}
