import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 保险审核工作台 e2e(2026-08-23)。
//
// 它解锁的是 `INSURANCE_ENFORCEMENT_ENABLED` 的前置条件:开关一开,「录了但没审」的记录
// 当场失效。开之前必须能回答「哪些还没审」—— 本 spec 锁的就是这个能力,以及它
// **没有顺手变成一个绕过掩码的批量通道**。
//
// 覆盖:
// - 越权(不持 `member-insurance.read.other` 的 ADMIN)→ 403,真 HTTP 不是 mock;
// - pending 筛选**比集合**(id 集合逐一相等),不是比计数 —— 计数相等可以靠两个错误互相抵消;
// - 🔴 PII:跨队员面保单号恒掩码,响应**任何角落**不含明文;
//   并与单人面同一条记录直接对拍,把两个面的口径差异钉成显式事实;
// - 软删记录 / 软删队员均不出(与单人面 26001 同口径);
// - 分页与 total 同 where。

const WORKBENCH_PATH = '/api/admin/v1/member-insurances';

const RAW_POLICY_PENDING = 'PICC-WORKBENCH-PENDING-RAW-0001';
const RAW_POLICY_VERIFIED = 'PICC-WORKBENCH-VERIFIED-RAW-0002';
const RAW_POLICY_REJECTED = 'PICC-WORKBENCH-REJECTED-RAW-0003';
const RAW_POLICY_SOFT_DELETED = 'PICC-WORKBENCH-SOFTDEL-RAW-0004';
const RAW_POLICY_DELETED_MEMBER = 'PICC-WORKBENCH-DELMEMBER-RAW-0005';

interface WorkbenchItem {
  id: string;
  member: {
    id: string;
    memberNo: string;
    realName: string;
    nickname: string | null;
    label: string;
  };
  insurerName: string;
  policyNumberMasked: string | null;
  coverageStart: string | null;
  coverageEnd: string;
  reviewStatusCode: string;
  version: number;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

describe('GET /api/admin/v1/member-insurances (保险审核工作台)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let readerAuth: string;
  let noPermissionAuth: string;
  /** verified / rejected 行的审核人 —— CHECK 要求审核快照成套,不能留 NULL。 */
  let reviewerUserId: string;

  let seq = 0;
  const nextSeq = () => ++seq;

  const created: Record<string, string> = {};

  async function createMember(options: { deleted?: boolean } = {}): Promise<string> {
    const member = await prisma.member.create({
      data: {
        memberNo: `WB-${nextSeq()}`,
        ...memberIdentityData(`Workbench Target ${nextSeq()}`),
        deletedAt: options.deleted ? new Date() : null,
      },
      select: { id: true },
    });
    return member.id;
  }

  async function createInsurance(options: {
    memberId: string;
    policyNumber: string;
    reviewStatusCode: string;
    deleted?: boolean;
  }): Promise<string> {
    // `member_insurances_review_snapshot_ck`(第 20260719160335 号 migration)要求审核快照成套:
    // pending ⇒ reviewer/reviewedAt 必须都为 NULL;verified/rejected ⇒ 必须都非 NULL。
    // 直插夹具绕过 service,所以这条组合律得自己遵守 —— 不遵守时是 DB 报 23514,不是断言变红。
    const reviewed = options.reviewStatusCode !== 'pending';
    const row = await prisma.memberInsurance.create({
      data: {
        memberId: options.memberId,
        insurerName: `Insurer-${nextSeq()}`,
        policyNumber: options.policyNumber,
        coverageStart: new Date('2026-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2098-12-31T00:00:00.000Z'),
        reviewStatusCode: options.reviewStatusCode,
        reviewedByUserId: reviewed ? reviewerUserId : null,
        reviewedAt: reviewed ? new Date('2026-06-01T00:00:00.000Z') : null,
        deletedAt: options.deleted ? new Date() : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const reader = await createTestUser(app, {
      username: 'insurance-workbench-reader',
      role: Role.ADMIN,
    });
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, reader.id, bizSeed.bizAdminRoleId);
    readerAuth = (await loginAs(app, 'insurance-workbench-reader')).authHeader;
    reviewerUserId = reader.id;

    // 只有 ADMIN 角色、不挂任何 RBAC 绑定 —— 拿不到 member-insurance.read.other。
    await createTestUser(app, { username: 'insurance-workbench-outsider', role: Role.ADMIN });
    noPermissionAuth = (await loginAs(app, 'insurance-workbench-outsider')).authHeader;

    // 直插夹具:三种审核状态各一条 + 两条不该出现的。
    const memberPending = await createMember();
    const memberVerified = await createMember();
    const memberRejected = await createMember();
    const memberSoftDeletedRow = await createMember();
    const memberDeleted = await createMember({ deleted: true });

    created.pending = await createInsurance({
      memberId: memberPending,
      policyNumber: RAW_POLICY_PENDING,
      reviewStatusCode: 'pending',
    });
    created.verified = await createInsurance({
      memberId: memberVerified,
      policyNumber: RAW_POLICY_VERIFIED,
      reviewStatusCode: 'verified',
    });
    created.rejected = await createInsurance({
      memberId: memberRejected,
      policyNumber: RAW_POLICY_REJECTED,
      reviewStatusCode: 'rejected',
    });
    created.softDeleted = await createInsurance({
      memberId: memberSoftDeletedRow,
      policyNumber: RAW_POLICY_SOFT_DELETED,
      reviewStatusCode: 'pending',
      deleted: true,
    });
    created.deletedMember = await createInsurance({
      memberId: memberDeleted,
      policyNumber: RAW_POLICY_DELETED_MEMBER,
      reviewStatusCode: 'pending',
    });
    created.memberPending = memberPending;
  });

  afterAll(async () => {
    await app.close();
  });

  async function listWorkbench(query: string, auth: string = readerAuth) {
    return request(httpServer(app)).get(`${WORKBENCH_PATH}${query}`).set('Authorization', auth);
  }

  describe('越权', () => {
    it('不持 member-insurance.read.other 的 ADMIN → 403 RBAC_FORBIDDEN', async () => {
      const res = await listWorkbench('', noPermissionAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).get(WORKBENCH_PATH);
      expect(res.status).toBe(401);
    });
  });

  describe('按审核状态筛', () => {
    it('reviewStatusCode=pending 筛出的**集合**恰是夹具造的 pending 集合', async () => {
      const res = await listWorkbench('?reviewStatusCode=pending&pageSize=100');
      expect(res.status).toBe(200);

      const items = res.body.data.items as WorkbenchItem[];
      const gotIds = items.map((i) => i.id).sort();

      // 比集合不比计数:软删行与软删队员的行也是 pending,
      // 计数相等可能是「少了该有的 + 多了不该有的」互相抵消。
      expect(gotIds).toEqual([created.pending].sort());
      expect(gotIds).not.toContain(created.softDeleted);
      expect(gotIds).not.toContain(created.deletedMember);
      expect(res.body.data.total).toBe(1);
    });

    it('reviewStatusCode=verified / rejected 各自只出对应那条', async () => {
      const verified = await listWorkbench('?reviewStatusCode=verified&pageSize=100');
      expect((verified.body.data.items as WorkbenchItem[]).map((i) => i.id)).toEqual([
        created.verified,
      ]);

      const rejected = await listWorkbench('?reviewStatusCode=rejected&pageSize=100');
      expect((rejected.body.data.items as WorkbenchItem[]).map((i) => i.id)).toEqual([
        created.rejected,
      ]);
    });

    it('不传 reviewStatusCode = 不筛:三种状态全出,软删两条仍不出', async () => {
      const res = await listWorkbench('?pageSize=100');
      const gotIds = (res.body.data.items as WorkbenchItem[]).map((i) => i.id).sort();

      expect(gotIds).toEqual([created.pending, created.verified, created.rejected].sort());
      expect(res.body.data.total).toBe(3);
    });

    it('非法 reviewStatusCode → 400', async () => {
      const res = await listWorkbench('?reviewStatusCode=not-a-status');
      expect(res.status).toBe(400);
    });
  });

  describe('🔴 PII:跨队员面保单号恒掩码', () => {
    it('持读码的调用方拿到的是掩码值,响应**任何角落**不含明文保单号', async () => {
      const res = await listWorkbench('?pageSize=100');

      const raw = JSON.stringify(res.body);
      for (const plaintext of [
        RAW_POLICY_PENDING,
        RAW_POLICY_VERIFIED,
        RAW_POLICY_REJECTED,
        RAW_POLICY_SOFT_DELETED,
        RAW_POLICY_DELETED_MEMBER,
      ]) {
        expect(raw).not.toContain(plaintext);
      }

      const item = (res.body.data.items as WorkbenchItem[]).find((i) => i.id === created.pending)!;
      expect(item.policyNumberMasked).toBe('PI****01');
      expect(item).not.toHaveProperty('policyNumber');
    });

    it('与单人面对拍:同一条记录,单人面返明文、工作台返掩码 —— 两个面的口径差异是显式事实', async () => {
      const single = await request(httpServer(app))
        .get(`/api/admin/v1/members/${created.memberPending}/insurances`)
        .set('Authorization', readerAuth);
      expect(single.status).toBe(200);

      const singleRow = (single.body.data as Array<Record<string, unknown>>).find(
        (r) => r.id === created.pending,
      )!;
      // 单人面历史口径:明文(本刀不改它 —— goal §6)。
      expect(singleRow.policyNumber).toBe(RAW_POLICY_PENDING);

      const workbench = await listWorkbench('?reviewStatusCode=pending&pageSize=100');
      const workbenchRow = (workbench.body.data.items as WorkbenchItem[]).find(
        (i) => i.id === created.pending,
      )!;
      // 工作台:恒掩码。跨队员面永不返明文。
      expect(workbenchRow.policyNumberMasked).toBe('PI****01');
      expect(JSON.stringify(workbench.body)).not.toContain(RAW_POLICY_PENDING);

      // 两个面的**安全列**必须逐字同值 —— 共用同一份投影的可观测证据。
      expect(workbenchRow.insurerName).toBe(singleRow.insurerName);
      expect(workbenchRow.coverageEnd).toBe(singleRow.coverageEnd);
      expect(workbenchRow.reviewStatusCode).toBe(singleRow.reviewStatusCode);
      expect(workbenchRow.version).toBe(singleRow.version);
    });

    it('不暴露审核人身份(模块铁律:不得暴露 reviewer)', async () => {
      const res = await listWorkbench('?pageSize=100');
      for (const item of res.body.data.items as WorkbenchItem[]) {
        expect(item).not.toHaveProperty('reviewedByUserId');
        expect(item).not.toHaveProperty('reviewer');
      }
      // verified / rejected 两条的 reviewedByUserId 在库里**确实非空**(CHECK 要求成套),
      // 所以这条断言不是空转:审核人 id 一旦漏进出参,这里就会红。
      expect(JSON.stringify(res.body)).not.toContain(reviewerUserId);
    });
  });

  describe('出参足以决策', () => {
    it('返回队员标识 / 保险起止 / 当前状态 / 审核所需 version', async () => {
      const res = await listWorkbench('?reviewStatusCode=pending&pageSize=100');
      const item = (res.body.data.items as WorkbenchItem[])[0];

      expect(item.member.id).toBe(created.memberPending);
      expect(item.member.memberNo).toBeTruthy();
      expect(item.member.label).toContain(item.member.memberNo);
      expect(item.coverageStart).toBeTruthy();
      expect(item.coverageEnd).toBeTruthy();
      expect(item.reviewStatusCode).toBe('pending');
      // 审核端点 expectedVersion 必填 —— 工作台不给,审核人就没法直接动手。
      expect(typeof item.version).toBe('number');
    });
  });

  describe('分页', () => {
    it('pageSize=1 时 items 长度为 1,total 仍是全量', async () => {
      const res = await listWorkbench('?pageSize=1');
      expect((res.body.data.items as WorkbenchItem[]).length).toBe(1);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(1);
    });

    it('翻页不重不漏:三页各一条,合起来恰是全集', async () => {
      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await listWorkbench(`?page=${page}&pageSize=1`);
        ids.push(...(res.body.data.items as WorkbenchItem[]).map((i) => i.id));
      }
      expect(ids.sort()).toEqual([created.pending, created.verified, created.rejected].sort());
    });
  });

  describe('审计', () => {
    it('查询落 member-insurance.read.other,extra 只记安全元数据', async () => {
      await listWorkbench('?reviewStatusCode=pending&pageSize=100');

      const log = await prisma.auditLog.findFirst({
        where: { event: 'member-insurance.read.other' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).not.toBeNull();
      // `extra` 落库在 context.extra 下(audit-logs.service.ts:74)。
      const context = JSON.stringify(log!.context);
      expect(context).toContain('workbench-list');
      // 保单号 / 保险公司 / id 列表一律不进审计。
      expect(context).not.toContain(RAW_POLICY_PENDING);
      expect(context).not.toContain(created.pending);
    });
  });
});
