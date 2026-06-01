import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { TEST_PASSWORD } from './users.fixture';

export interface AuthCredentials {
  accessToken: string;
  authHeader: string; // 'Bearer <token>',spec 直接 .set('Authorization', authHeader)
}

// 走真实 POST /api/auth/v1/login 拿 token——不绕过 service 层,
// 这样 fixture 同时也是 auth-login spec 的间接回归测试。
//
// 失败时直接抛错:loginAs 设计意图是"以该用户身份登录",失败说明 fixture 用法错
// (用户没造、密码错、状态不对),应该立即 fail 暴露,而不是返回 null 让 spec 自己处理。
export async function loginAs(
  app: INestApplication,
  username: string,
  password: string = TEST_PASSWORD,
): Promise<AuthCredentials> {
  const res = await request(httpServer(app))
    .post('/api/auth/v1/login')
    .send({ username, password });

  if (res.status !== 200 || res.body?.code !== 0) {
    throw new Error(
      `loginAs failed for username='${username}': status=${res.status}, body=${JSON.stringify(res.body)}`,
    );
  }

  const accessToken: string = res.body.data.accessToken;
  return { accessToken, authHeader: `Bearer ${accessToken}` };
}
