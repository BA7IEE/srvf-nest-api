import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * 旅程测试唯一允许触达 Prisma 的夹具边界。
 *
 * `test/journeys/**` 只拿 runtime 和领域动作 helper：造数在本目录内收敛，业务动作则由
 * helper 调真实 HTTP / 注入的真实 service，避免金五条自己绕过应用层。
 */
export interface JourneyRuntime {
  readonly app: INestApplication;
  readonly adminAuth: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

interface JourneyRuntimeState {
  readonly prisma: PrismaService;
  adminUserId: string;
  adminAuth: string;
}

const states = new WeakMap<JourneyRuntime, JourneyRuntimeState>();

function stateOf(runtime: JourneyRuntime): JourneyRuntimeState {
  const state = states.get(runtime);
  if (!state) throw new Error('journey runtime 已关闭或未初始化');
  return state;
}

async function createDict(
  prisma: PrismaService,
  code: string,
  label: string,
  items: Array<{ code: string; label: string }>,
): Promise<void> {
  // journey-direct-write: ambient — 字典是全 journey 共用的环境底座,不属于任何一条被验链
  const type = await prisma.dictType.create({ data: { code, label }, select: { id: true } });
  // journey-direct-write: ambient — 同上
  await prisma.dictItem.createMany({
    data: items.map((item) => ({ typeId: type.id, code: item.code, label: item.label })),
  });
}

async function seedJourneyReferenceData(prisma: PrismaService): Promise<void> {
  // 公开报名的两条 DevStub 通道，以及发号/入队使用的业务字典，均是夹具前置事实。
  // journey-direct-write: ambient — 第三方渠道配置;走 HTTP 需要真实凭证,且不属于被验链
  await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
  // journey-direct-write: ambient — 同上
  await prisma.realnameVerificationSettings.create({
    data: { providerType: 'DEV_STUB', enabled: true },
  });
  // journey-direct-write: ambient — 同上
  await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

  await createDict(prisma, 'emergency_relation', '紧急联系人关系', [
    { code: 'parent', label: '父母' },
    { code: 'family', label: '家属' },
  ]);
  await createDict(prisma, 'document_type', '证件类型', [{ code: 'id_card', label: '居民身份证' }]);
  await createDict(prisma, 'member_grade', '队员等级', [
    { code: 'volunteer', label: '志愿者' },
    { code: 'level-1', label: '一级队员' },
  ]);
  await createDict(prisma, 'cert_type', '证书类别', [
    { code: 'first_aid', label: '急救' },
    { code: 'bsafe', label: 'BSAFE' },
  ]);
  await createDict(prisma, 'recruitment_stage', '招新进度', [
    { code: 'threshold', label: '门槛未完成' },
    { code: 'threshold_done', label: '门槛已完成' },
    { code: 'evaluation', label: '待综合评定' },
    { code: 'publicity', label: '公示中' },
    { code: 'volunteer', label: '已转志愿者' },
    { code: 'rejected', label: '未通过' },
    { code: 'withdrawn', label: '已撤销' },
    { code: 'manual', label: '待人工核验' },
  ]);
}

export async function createJourneyRuntime(): Promise<JourneyRuntime> {
  const app = await createTestApp();
  const state: JourneyRuntimeState = {
    prisma: app.get(PrismaService),
    adminUserId: '',
    adminAuth: '',
  };

  const runtime: JourneyRuntime = {
    app,
    get adminAuth(): string {
      return state.adminAuth;
    },
    async reset(): Promise<void> {
      await resetDb(app);
      await seedJourneyReferenceData(state.prisma);
      const admin = await createTestUser(app, {
        username: 'journey-super-admin',
        role: Role.SUPER_ADMIN,
      });
      state.adminUserId = admin.id;
      state.adminAuth = (await loginAs(app, 'journey-super-admin')).authHeader;
    },
    async close(): Promise<void> {
      states.delete(runtime);
      await app.close();
    },
  };
  states.set(runtime, state);
  await runtime.reset();
  return runtime;
}

/** @internal 仅供 test/support 内的造数 helper 使用。 */
export function journeyPrisma(runtime: JourneyRuntime): PrismaService {
  return stateOf(runtime).prisma;
}

/** @internal 仅供 test/support 内的真实 service 调用使用。 */
export function journeyAdmin(runtime: JourneyRuntime): CurrentUserPayload {
  const state = stateOf(runtime);
  return {
    id: state.adminUserId,
    username: 'journey-super-admin',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
}
