import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// CMS 内容发布模块(第 28 模块)T3 open/v1 公开读取面 e2e
// (冻结评审稿 docs/archive/reviews/content-module-review.md §8 open + §9 DoD):
//   - 仅 published+public 进列表 / 详情;draft / archived / 非 public 档不进列表 + 详情 404(防枚举,
//     与"不存在"同 404 不区分);
//   - viewCount:详情 +1;列表 / 404 不计;
//   - 搜索 keyword + 标签 tags 仍受 public-only 闸(搜不到非 public);
//   - 防注入(pageSize 上限 50 + DTO 白名单拒未知字段不报错但被吞);
//   - 读者出参零敏感:无 authorUserId / 无 visibleOrganizationIds。
//
// open/v1 = @Public,无需登录;reset-db 已清 contents,本 spec 直接 prisma.content.create 造数据。

const OPEN_CONTENTS = '/api/open/v1/contents';

describe('CMS 内容发布模块(第 28 模块)open/v1 公开读取面 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 直接造一条内容(绕过 admin 写路径;读取面不校验 contentTypeCode 字典)。
  async function makeContent(over: {
    title?: string;
    body?: string;
    statusCode?: string;
    visibilityCode?: string;
    visibleOrganizationIds?: string[];
    tags?: string[];
    publishedAt?: Date | null;
    authorUserId?: string | null;
  }): Promise<string> {
    const row = await prisma.content.create({
      data: {
        title: over.title ?? '公开公告',
        summary: '摘要',
        body: over.body ?? '正文内容 Markdown',
        contentTypeCode: 'announcement',
        statusCode: over.statusCode ?? 'published',
        visibilityCode: over.visibilityCode ?? 'public',
        visibleOrganizationIds: over.visibleOrganizationIds ?? [],
        tags: over.tags ?? [],
        publishedAt: over.publishedAt ?? new Date(),
        authorUserId: over.authorUserId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  function listOpen(qs = ''): request.Test {
    return request(httpServer(app)).get(`${OPEN_CONTENTS}${qs}`);
  }
  function detailOpen(id: string): request.Test {
    return request(httpServer(app)).get(`${OPEN_CONTENTS}/${id}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.content.deleteMany({});
  });

  describe('列表:仅 published + public', () => {
    it('published+public 进列表;draft / archived / 非 public 档均不进', async () => {
      const pubId = await makeContent({ title: 'P-公开', visibilityCode: 'public' });
      await makeContent({ title: 'D-草稿', statusCode: 'draft', visibilityCode: 'public' });
      await makeContent({ title: 'A-归档', statusCode: 'archived', visibilityCode: 'public' });
      await makeContent({ title: 'M-会员', statusCode: 'published', visibilityCode: 'member' });
      await makeContent({
        title: 'DEP-部门',
        statusCode: 'published',
        visibilityCode: 'department',
        visibleOrganizationIds: ['org-x'],
      });
      await makeContent({
        title: 'MGMT-管理',
        statusCode: 'published',
        visibilityCode: 'management',
      });

      const res = await listOpen();
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      const ids = (res.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).toEqual([pubId]);
    });

    it('列表 item 零敏感:无 authorUserId / 无 visibleOrganizationIds / 无 body / 无 statusCode', async () => {
      await makeContent({ authorUserId: 'some-admin-user-id', tags: ['t1'] });
      const res = await listOpen();
      expect(res.status).toBe(200);
      const item = res.body.data.items[0] as Record<string, unknown>;
      expect(item).not.toHaveProperty('authorUserId');
      expect(item).not.toHaveProperty('visibleOrganizationIds');
      expect(item).not.toHaveProperty('body');
      expect(item).not.toHaveProperty('statusCode');
      // 读者列表正向字段在
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('viewCount');
      expect(item).toHaveProperty('coverImageUrl');
    });

    it('列表不增 viewCount', async () => {
      const id = await makeContent({});
      await listOpen();
      await listOpen();
      const row = await prisma.content.findUnique({ where: { id }, select: { viewCount: true } });
      expect(row?.viewCount).toBe(0);
    });
  });

  describe('详情:published + public 才可见,否则 404 防枚举', () => {
    it('published+public → 200 + 详情;含 body / visibilityCode;零 authorUserId / 零 visibleOrganizationIds', async () => {
      const id = await makeContent({
        body: '正文正文',
        visibilityCode: 'public',
        authorUserId: 'admin-id',
      });
      const res = await detailOpen(id);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data.body).toBe('正文正文');
      expect(res.body.data.visibilityCode).toBe('public');
      expect(res.body.data).not.toHaveProperty('authorUserId');
      expect(res.body.data).not.toHaveProperty('visibleOrganizationIds');
      expect(res.body.data).not.toHaveProperty('statusCode');
      expect(Array.isArray(res.body.data.attachments)).toBe(true);
    });

    it('draft 详情 → 404(防枚举:与不存在同 404)', async () => {
      const id = await makeContent({ statusCode: 'draft', visibilityCode: 'public' });
      const res = await detailOpen(id);
      expectBizError(res, BizCode.CONTENT_NOT_FOUND);
    });

    it('archived 详情 → 404', async () => {
      const id = await makeContent({ statusCode: 'archived', visibilityCode: 'public' });
      expectBizError(await detailOpen(id), BizCode.CONTENT_NOT_FOUND);
    });

    it('非 public 档(member)详情 → 404(防枚举,不区分"存在但不可见")', async () => {
      const id = await makeContent({ statusCode: 'published', visibilityCode: 'member' });
      expectBizError(await detailOpen(id), BizCode.CONTENT_NOT_FOUND);
    });

    it('不存在 id → 404(与不可见同码)', async () => {
      expectBizError(await detailOpen('nonexistent-id-xyz'), BizCode.CONTENT_NOT_FOUND);
    });

    it('已软删的 published+public → 404', async () => {
      const id = await makeContent({ visibilityCode: 'public' });
      await prisma.content.update({ where: { id }, data: { deletedAt: new Date() } });
      expectBizError(await detailOpen(id), BizCode.CONTENT_NOT_FOUND);
    });
  });

  describe('viewCount:详情 +1,404 不计', () => {
    it('public 详情每次 +1', async () => {
      const id = await makeContent({});
      const r1 = await detailOpen(id);
      expect(r1.body.data.viewCount).toBe(1);
      const r2 = await detailOpen(id);
      expect(r2.body.data.viewCount).toBe(2);
      const row = await prisma.content.findUnique({ where: { id }, select: { viewCount: true } });
      expect(row?.viewCount).toBe(2);
    });

    it('不可见详情(404)不增 viewCount', async () => {
      const id = await makeContent({ statusCode: 'published', visibilityCode: 'member' });
      await detailOpen(id); // 404
      const row = await prisma.content.findUnique({ where: { id }, select: { viewCount: true } });
      expect(row?.viewCount).toBe(0);
    });
  });

  describe('搜索 keyword + 标签 tags:不旁路 public-only', () => {
    it('keyword 命中标题但内容是 member 档 → 搜不到(可见性 AND)', async () => {
      await makeContent({ title: '秘密会员通知', visibilityCode: 'member' });
      const res = await listOpen('?keyword=秘密会员通知');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    });

    it('keyword 命中 public 内容 → 搜得到(标题 + 正文 ILIKE,大小写不敏感)', async () => {
      const id = await makeContent({ title: 'HelloWorld 公告', body: '正文含 KEYWORDX 词' });
      // 标题命中(大小写不敏感)
      const r1 = await listOpen('?keyword=helloworld');
      expect((r1.body.data.items as { id: string }[]).map((i) => i.id)).toEqual([id]);
      // 正文命中
      const r2 = await listOpen('?keyword=keywordx');
      expect((r2.body.data.items as { id: string }[]).map((i) => i.id)).toEqual([id]);
    });

    it('tags hasSome 命中但内容是 department 档 → 搜不到', async () => {
      await makeContent({
        title: '部门标签内容',
        visibilityCode: 'department',
        visibleOrganizationIds: ['org-a'],
        tags: ['urgent'],
      });
      const res = await listOpen('?tags=urgent');
      expect(res.body.data.total).toBe(0);
    });

    it('tags hasSome 命中 public 内容 → 搜得到', async () => {
      const id = await makeContent({ tags: ['news', 'rescue'] });
      await makeContent({ tags: ['other'] });
      const res = await listOpen('?tags=rescue');
      expect((res.body.data.items as { id: string }[]).map((i) => i.id)).toEqual([id]);
    });
  });

  describe('防注入 / 防滥取', () => {
    it('pageSize 超上限 50 → 400(DTO @Max 校验)', async () => {
      await makeContent({});
      const res = await listOpen('?pageSize=200');
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=50(边界)→ 200', async () => {
      await makeContent({});
      const res = await listOpen('?pageSize=50');
      expect(res.status).toBe(200);
    });

    it('读者注入未声明查询字段(statusCode)→ 400(forbidNonWhitelisted;读者无法借此看草稿)', async () => {
      // 读者试图传 statusCode=draft 看草稿:ListContentReadQueryDto 无此字段 → 全局
      // forbidNonWhitelisted 直接 400 拒绝(而非被赋予草稿可见面)。
      await makeContent({ statusCode: 'draft', visibilityCode: 'public' });
      const res = await listOpen('?statusCode=draft');
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('读者注入未声明查询字段(visibilityCode)→ 400(无法借此看越档内容)', async () => {
      await makeContent({ statusCode: 'published', visibilityCode: 'member' });
      const res = await listOpen('?visibilityCode=member');
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
