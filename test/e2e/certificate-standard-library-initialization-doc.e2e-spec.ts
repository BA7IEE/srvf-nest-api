import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 证书标准库 · 第二轮跨模型评审 findings G4:**首批初始化指引按文档示例原样执行**。
//
// 为什么必须是「读文档 → 执行」而不是「照抄一份等价请求」:
// 抄一份就是抄一份 —— 文档改了、DTO 改了,抄件都不会红。上一轮的实际后果是
// 示例里写着 `"levelCode": null` / `"parentId": null`,而 service 的判据是
// `!== undefined`:显式 null 会掉进字典查询 / 父节点查询分支直接失败。
// 维护者照着这份文档做首批初始化,第一步就会撞墙,而仓库里没有任何东西会因此变红。
//
// 所以这条用例**解析文档里的请求示例并真的发出去**。文档一旦与真实 DTO 漂移,
// 这里立刻红 —— 这是「文档可执行」唯一靠得住的落法(写「请保持同步」没用)。

const DOC_PATH = join(__dirname, '../../docs/ops/certificate-standard-library-initialization.md');

const STANDARD_CODES = [
  'certificate-standard.read.record',
  'certificate-standard.create.record',
  'certificate-standard.update.record',
  'certificate-standard.delete.record',
  'certificate-recognition-policy.read.record',
  'certificate-recognition-policy.create.record',
  'certificate-recognition-policy.update.record',
  'certificate-recognition-policy.delete.record',
] as const;

interface DocRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/**
 * 从文档里抽出「一行 HTTP 方法 + 路径,后跟一段 JSON 体」形状的围栏块。
 *
 * 行尾 `// 注释` 逐行剥掉(路径不含 `//`,方法行本身也不进 JSON 解析,不会误伤)。
 * 抽取结果由下方第一条用例逐项对账 —— 少了那层对账,解析器悄悄抽到 0 个块
 * 也会让整组「全绿」,而那正是最坏的假绿。
 */
function parseDocRequests(markdown: string): DocRequest[] {
  const out: DocRequest[] = [];
  for (const block of markdown.split('```').filter((_, i) => i % 2 === 1)) {
    // 首行是围栏语言标注(text),第二行起才是内容。
    const content = block.split('\n').slice(1);
    const firstIdx = content.findIndex((l) => l.trim().length > 0);
    if (firstIdx === -1) continue;
    const head = /^(GET|POST|PATCH|PUT|DELETE)\s+(\S+)/.exec(content[firstIdx].trim());
    if (!head) continue;
    const rest = content
      .slice(firstIdx + 1)
      .map((l) => l.replace(/\s+\/\/.*$/, ''))
      .join('\n')
      .trim();
    if (!rest.startsWith('{')) continue;
    out.push({ method: head[1], path: head[2], body: JSON.parse(rest) as Record<string, unknown> });
  }
  return out;
}

describe('证书标准库首批初始化指引:文档示例可原样执行(评审 findings G4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let opsAuth: string;
  let docRequests: DocRequest[];

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const ops = await createTestUser(app, { username: 'init-doc-ops', role: Role.ADMIN });
    opsAuth = (await loginAs(app, 'init-doc-ops')).authHeader;
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    for (const code of STANDARD_CODES) {
      const [module, action, resourceType] = code.split('.');
      const perm = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module, action, resourceType },
        select: { id: true },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: seed.opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: seed.opsAdminRoleId, permissionId: perm.id },
      });
    }
    await grantOpsAdminToUser(app, ops.id, seed.opsAdminRoleId);

    // 文档第二节写明 `categoryCode` 取 cert_type 字典 code;招新只收 first_aid / bsafe。
    const certType = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: certType.id, code: 'first_aid', label: '急救' },
        { typeId: certType.id, code: 'bsafe', label: 'BSAFE' },
      ],
    });

    docRequests = parseDocRequests(readFileSync(DOC_PATH, 'utf8'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('文档里恰好两段可执行请求示例,且路径与本仓路由一致(防解析器抽空造成的假绿)', () => {
    expect(docRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/admin/v1/certificate-standards',
      'POST /api/admin/v1/certificate-standards/:standardId/recognition-policies',
    ]);
  });

  it('按文档示例原样跑通:建标准 → 启用 → 建认定规则 → 启用 → 两个 options 端点都能看到它', async () => {
    const [standardReq, policyReq] = docRequests;

    // ① 建标准:文档第二节的请求体**一字不改**发出去。
    // 修复前这里会红 —— 示例带着 `"levelCode": null` / `"parentId": null`,
    // 而 service 判的是 `!== undefined`:显式 null 会掉进字典查询 / 父节点查询分支。
    const created = await request(httpServer(app))
      .post(standardReq.path)
      .set('Authorization', opsAuth)
      .send(standardReq.body);
    expect(created.status).toBe(201);
    const standardId = created.body.data.id as string;
    // 文档:「新建为 DRAFT,**不能用于建证**」。
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.code).toBe(standardReq.body.code);

    // ② 文档:「`PATCH /:id/status` 切 `ACTIVE` 后才可用」。
    expect(
      (
        await request(httpServer(app))
          .patch(`/api/admin/v1/certificate-standards/${standardId}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(200);

    // ③ 建认定规则:文档第三节的请求体一字不改,路径里的 `:standardId` 按文档替换。
    const policyRes = await request(httpServer(app))
      .post(policyReq.path.replace(':standardId', standardId))
      .set('Authorization', opsAuth)
      .send(policyReq.body);
    expect(policyRes.status).toBe(201);
    expect(policyRes.body.data.status).toBe('DRAFT');

    // ④ 文档:「新建为 `DRAFT`,`PATCH /:id/status` 切 `ACTIVE` 时旧版本自动 `RETIRED`」。
    expect(
      (
        await request(httpServer(app))
          .patch(`/api/admin/v1/certificate-recognition-policies/${policyRes.body.data.id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(200);

    // ⑤ 文档第四节最小 smoke 的第 1、2 步。
    const options = await request(httpServer(app))
      .get('/api/admin/v1/certificate-standards/options')
      .set('Authorization', opsAuth);
    expect(options.status).toBe(200);
    expect(
      (options.body.data.items as Array<{ id: string }>).some((i) => i.id === standardId),
    ).toBe(true);

    // 公开选择器无需登录(文档原文标注「无需登录」)。
    const open = await request(httpServer(app)).get(
      '/api/open/v1/recruitment/certificate-standards',
    );
    expect(open.status).toBe(200);
    const mine = (open.body.data.items as Array<Record<string, unknown>>).find(
      (i) => i.id === standardId,
    );
    // 文档:`currentlyRecognized: false` 表示「已收录、待认定」;有了 ACTIVE Policy 就该是 true。
    expect(mine?.currentlyRecognized).toBe(true);
  });

  it('可执行示例里没有任何显式 null(后端判的是「键在不在」,显式 null 会走进 !== undefined 分支)', () => {
    // 断的是**解析出来的请求体**而不是文档全文:正文里那段警告本身就要引用
    // `"levelCode": null` 当反例,按全文匹配会把提醒写得越清楚、断言越容易误报。
    // 规则的本体是「示例发出去能不能成」,所以就断示例。
    for (const req of docRequests) {
      const nullKeys = Object.entries(req.body)
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      expect({ path: req.path, nullKeys }).toEqual({ path: req.path, nullKeys: [] });
    }
  });

  it('DRAFT 期确实可以补设 parentId —— 文档里那句「只能创建时设」已被 amendments A-3 推翻', async () => {
    const family = await request(httpServer(app))
      .post('/api/admin/v1/certificate-standards')
      .set('Authorization', opsAuth)
      .send({
        code: 'init-doc-family',
        name: '急救类',
        kind: 'FAMILY',
        categoryCode: 'first_aid',
      });
    expect(family.status).toBe(201);
    expect(
      (
        await request(httpServer(app))
          .patch(`/api/admin/v1/certificate-standards/${family.body.data.id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(200);

    const child = await request(httpServer(app))
      .post('/api/admin/v1/certificate-standards')
      .set('Authorization', opsAuth)
      .send({
        code: 'init-doc-child',
        name: '某急救证',
        kind: 'CREDENTIAL',
        categoryCode: 'first_aid',
      });
    expect(child.status).toBe(201);

    // 建完之后再挂树 —— 这正是被删掉那段文字断言「做不到」的事。
    // 只断言文档文本会在「文档改对了但代码又改回去」时假绿,所以这里跑真请求。
    const patched = await request(httpServer(app))
      .patch(`/api/admin/v1/certificate-standards/${child.body.data.id}`)
      .set('Authorization', opsAuth)
      .send({ parentId: family.body.data.id });
    expect(patched.status).toBe(200);
    expect(patched.body.data.parentId).toBe(family.body.data.id);

    const doc = readFileSync(DOC_PATH, 'utf8');
    expect(doc).not.toMatch(/`parentId`\s*只能在\s*create\s*时设/);
  });
});
