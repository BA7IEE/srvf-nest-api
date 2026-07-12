import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// CMS 内容发布模块(第 28 模块)T2 e2e(冻结评审稿 docs/archive/reviews/content-module-review.md §9 DoD):
// admin CRUD + 状态机各分支(含非法跃迁 29030)+ 封面 set/clear + 附件 Mode B(content-image / content-file)
// + content type config MIME/size 闸(13xxx)+ 字典校验(29010)+ 可见档校验(29011/29012,department 需 orgs)
// + 正文图占位读时改写(本文章命中替换 / 外来 id 不泄露)+ viewCount admin 详情不增 + 列表过滤(status/type/keyword/tags)。
//
// reset-db 把 contents / attachment_type_configs / DictItem / DictType / RBAC 4 表清空;biz-admin fixture
// 不含 content.* 5 码 + attachment.content-* 4 码,故 beforeAll 自行 seed(content_type 字典 + 2 type config +
// 9 内容相关权限码绑 biz-admin)。

const ADMIN_CONTENTS = '/api/admin/v1/contents';

// content_type 字典 ACTIVE item 之一(评审稿 §7;announcement / publicity / briefing / post)
const CONTENT_TYPE_ANNOUNCEMENT = 'announcement';
const CONTENT_TYPE_BRIEFING = 'briefing';

// 本 spec 需绑给 biz-admin 的内容相关权限码(seed.ts 绑,但 reset-db 清,故此处镜像 seed)。
const CONTENT_PERMISSION_CODES = [
  { code: 'content.read.record', module: 'content', action: 'read', resourceType: 'record' },
  { code: 'content.create.record', module: 'content', action: 'create', resourceType: 'record' },
  { code: 'content.update.record', module: 'content', action: 'update', resourceType: 'record' },
  { code: 'content.delete.record', module: 'content', action: 'delete', resourceType: 'record' },
  { code: 'content.publish.record', module: 'content', action: 'publish', resourceType: 'record' },
  {
    code: 'attachment.upload.content-image',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-image',
  },
  {
    code: 'attachment.delete.content-image',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-image',
  },
  {
    code: 'attachment.upload.content-file',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-file',
  },
  {
    code: 'attachment.delete.content-file',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-file',
  },
] as const;

describe('CMS 内容发布模块(第 28 模块)admin e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // biz-admin(承载 ADMIN 业务权限)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let bizAdminRoleId: string;

  // ===== content_type 字典 + 2 content attachment type config(镜像 seed.ts,reset-db 清后重建)=====
  async function seedContentPrereqs(): Promise<void> {
    const dictType = await prisma.dictType.create({
      data: { code: 'content_type', label: '内容类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dictType.id, code: 'announcement', label: '公告', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'publicity', label: '公示', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'briefing', label: '简报', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'post', label: '推文', status: 'ACTIVE' },
        // INACTIVE 项:验证 service 只认 ACTIVE(29010 路径)
        { typeId: dictType.id, code: 'archived_type', label: '停用类型', status: 'INACTIVE' },
      ],
    });
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'content-image',
        displayName: '内容图片',
        ownerTable: 'contents',
        defaultMaxSizeBytes: 10 * 1024 * 1024,
        defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'content-file',
        displayName: '内容文件附件',
        ownerTable: 'contents',
        defaultMaxSizeBytes: 20 * 1024 * 1024,
        defaultMimeWhitelist: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ],
      },
    });
  }

  // 把 content.* 5 + attachment.content-* 4 权限码补绑 biz-admin(biz-admin fixture 不含这 9 码)。
  async function seedContentPermissionsToBizAdmin(roleId: string): Promise<void> {
    for (const p of CONTENT_PERMISSION_CODES) {
      await prisma.permission.upsert({
        where: { code: p.code },
        update: {},
        create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      });
    }
    const seeded = await prisma.permission.findMany({
      where: { code: { in: CONTENT_PERMISSION_CODES.map((p) => p.code) } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: seeded.map((p) => ({ roleId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // biz-admin 角色 + 业务面码 + 内容相关 9 码补绑
    const seedResult = await seedBizAdminPermissionsAndRole(app);
    bizAdminRoleId = seedResult.bizAdminRoleId;
    await seedContentPermissionsToBizAdmin(bizAdminRoleId);

    // admin 用户(biz-admin)+ 普通 USER(reference data,beforeEach 不清)
    const adminUser = await createTestUser(app, { username: 'content_admin', role: Role.ADMIN });
    await grantBizAdminToUser(app, adminUser.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, 'content_admin')).authHeader;
    await createTestUser(app, { username: 'content_user', role: Role.USER });
    userAuth = (await loginAs(app, 'content_user')).authHeader;

    await seedContentPrereqs();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // 每测隔离:清内容 + 附件 + 内容审计(字典 / 配置 / 用户 / RBAC 作 reference 跨测持久)
    await prisma.attachment.deleteMany({
      where: { ownerType: { in: ['content-image', 'content-file'] } },
    });
    await prisma.content.deleteMany({});
    await prisma.auditLog.deleteMany({ where: { resourceType: 'content' } });
  });

  // ===== helpers =====
  function validCreateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: '测试公告标题',
      summary: '测试摘要',
      body: '正文内容 Markdown',
      contentTypeCode: CONTENT_TYPE_ANNOUNCEMENT,
      visibilityCode: 'public',
      ...over,
    };
  }

  function createContent(body: Record<string, unknown>, auth = adminAuth) {
    return request(httpServer(app)).post(ADMIN_CONTENTS).set('Authorization', auth).send(body);
  }

  async function createDraft(over: Record<string, unknown> = {}): Promise<string> {
    const res = await createContent(validCreateBody(over));
    expect(res.status).toBe(201); // POST 无 @HttpCode → NestJS 默认 201
    return res.body.data.id as string;
  }

  function post(path: string, auth = adminAuth) {
    return request(httpServer(app)).post(path).set('Authorization', auth).send({});
  }

  // 把 key 用 LocalProvider 实写到 tmp 目录,模拟 client 已上传完(沿 attachments.upload.e2e)
  async function fakeUploadToLocal(
    key: string,
    sizeBytes = 1024,
    mime = 'image/jpeg',
  ): Promise<void> {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const localCfg = app.get<{ storage: { localRoot: string } }>(appConfig.KEY);
    const filePath = path.resolve(localCfg.storage.localRoot, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const body = Buffer.alloc(sizeBytes);
    const prefix =
      mime === 'application/pdf'
        ? Buffer.from('%PDF-1.7', 'ascii')
        : Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    prefix.copy(body, 0, 0, Math.min(prefix.length, body.length));
    await fs.writeFile(filePath, body);
  }

  // Mode B:upload-url → fakeUpload → confirm,返回落库的 attachment view
  async function uploadAttachment(
    contentId: string,
    body: Record<string, unknown>,
    auth = adminAuth,
  ): Promise<{ id: string; key: string }> {
    const urlRes = await request(httpServer(app))
      .post(`${ADMIN_CONTENTS}/${contentId}/attachments/upload-url`)
      .set('Authorization', auth)
      .send(body);
    expect(urlRes.status).toBe(200);
    const key = urlRes.body.data.key as string;
    const token = urlRes.body.data.uploadToken as string;
    await fakeUploadToLocal(
      key,
      (body.sizeBytes as number) ?? 1024,
      (body.mime as string) ?? 'image/jpeg',
    );
    const confirmRes = await request(httpServer(app))
      .post(`${ADMIN_CONTENTS}/${contentId}/attachments/confirm`)
      .set('Authorization', auth)
      .send({ uploadToken: token });
    expect(confirmRes.status).toBe(200);
    return { id: confirmRes.body.data.id as string, key };
  }

  const imageUpload = (over: Record<string, unknown> = {}) => ({
    kind: 'image',
    originalName: 'cover.jpg',
    mime: 'image/jpeg',
    sizeBytes: 2048,
    ...over,
  });
  const fileUpload = (over: Record<string, unknown> = {}) => ({
    kind: 'file',
    originalName: 'doc.pdf',
    mime: 'application/pdf',
    sizeBytes: 4096,
    ...over,
  });

  // ============================================================================
  // ① CRUD
  // ============================================================================

  it('① 建草稿 → draft + authorUserId 落库;详情可读', async () => {
    const res = await createContent(validCreateBody({ tags: ['announce', 'team'] }));
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data.statusCode).toBe('draft');
    expect(res.body.data.publishedAt).toBeNull();
    expect(res.body.data.tags).toEqual(['announce', 'team']);
    expect(res.body.data.authorUserId).toBeTruthy();

    const id = res.body.data.id as string;
    const detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(id);
    expect(detail.body.data.attachments).toEqual([]);

    // 审计:content.create 1 条
    const auditCount = await prisma.auditLog.count({ where: { event: 'content.create' } });
    expect(auditCount).toBe(1);
  });

  it('② 更新内容(标题 + tags);详情反映', async () => {
    const id = await createDraft();
    const res = await request(httpServer(app))
      .patch(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth)
      .send({ title: '改后标题', tags: ['x'] });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('改后标题');
    expect(res.body.data.tags).toEqual(['x']);
    const auditCount = await prisma.auditLog.count({ where: { event: 'content.update' } });
    expect(auditCount).toBe(1);
  });

  it('③ 软删内容 → 详情 404(任意态可删)', async () => {
    const id = await createDraft();
    const del = await request(httpServer(app))
      .delete(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    expect(del.status).toBe(200);
    const detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    expectBizError(detail, BizCode.CONTENT_NOT_FOUND);
    const auditCount = await prisma.auditLog.count({ where: { event: 'content.delete' } });
    expect(auditCount).toBe(1);
  });

  it('④ 详情不存在 → 29001', async () => {
    const res = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/nonexistent-id`)
      .set('Authorization', adminAuth);
    expectBizError(res, BizCode.CONTENT_NOT_FOUND);
  });

  // ============================================================================
  // ② RBAC 边界
  // ============================================================================

  it('⑤ 普通 USER 调 admin 列表 → 30100', async () => {
    const res = await request(httpServer(app)).get(ADMIN_CONTENTS).set('Authorization', userAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  it('⑥ 未登录 → 40100', async () => {
    const res = await request(httpServer(app)).get(ADMIN_CONTENTS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(BizCode.UNAUTHORIZED.code);
  });

  // ============================================================================
  // ③ 状态机各分支(评审稿 §3)
  // ============================================================================

  it('⑦ publish: draft → published 置 publishedAt;unpublish 保留 publishedAt;archive 终态', async () => {
    const id = await createDraft();

    const pub = await post(`${ADMIN_CONTENTS}/${id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.statusCode).toBe('published');
    const publishedAt = pub.body.data.publishedAt;
    expect(publishedAt).toBeTruthy();

    const unpub = await post(`${ADMIN_CONTENTS}/${id}/unpublish`);
    expect(unpub.status).toBe(200);
    expect(unpub.body.data.statusCode).toBe('draft');
    expect(unpub.body.data.publishedAt).toBe(publishedAt); // 保留上次发布时刻

    // 再 publish 后 archive
    await post(`${ADMIN_CONTENTS}/${id}/publish`);
    const arc = await post(`${ADMIN_CONTENTS}/${id}/archive`);
    expect(arc.status).toBe(200);
    expect(arc.body.data.statusCode).toBe('archived');

    // 伞事件 content.publish 共 4 次(publish/unpublish/publish/archive)
    const publishAudits = await prisma.auditLog.findMany({
      where: { event: 'content.publish' },
      orderBy: { createdAt: 'asc' },
    });
    expect(publishAudits.length).toBe(4);
    const ops = publishAudits.map(
      (a) => (a.context as { extra: { operation: string } }).extra.operation,
    );
    expect(ops).toEqual(['publish', 'unpublish', 'publish', 'archive']);
  });

  it('⑧ 非法跃迁 → 29030:archive 一个 draft / unpublish 一个 draft / publish 一个 published', async () => {
    const id = await createDraft();
    expectBizError(
      await post(`${ADMIN_CONTENTS}/${id}/archive`),
      BizCode.CONTENT_INVALID_STATUS_TRANSITION,
    );
    expectBizError(
      await post(`${ADMIN_CONTENTS}/${id}/unpublish`),
      BizCode.CONTENT_INVALID_STATUS_TRANSITION,
    );
    await post(`${ADMIN_CONTENTS}/${id}/publish`);
    expectBizError(
      await post(`${ADMIN_CONTENTS}/${id}/publish`),
      BizCode.CONTENT_INVALID_STATUS_TRANSITION,
    );
  });

  it('⑨ archived 冻结:update 一个 archived → 29030', async () => {
    const id = await createDraft();
    await post(`${ADMIN_CONTENTS}/${id}/publish`);
    await post(`${ADMIN_CONTENTS}/${id}/archive`);
    const res = await request(httpServer(app))
      .patch(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth)
      .send({ title: '想改归档' });
    expectBizError(res, BizCode.CONTENT_INVALID_STATUS_TRANSITION);
  });

  // ============================================================================
  // ④ 字典 + 可见档校验(评审稿 §6)
  // ============================================================================

  it('⑩ contentTypeCode 非 content_type ACTIVE item → 29010(不存在 / INACTIVE)', async () => {
    expectBizError(
      await createContent(validCreateBody({ contentTypeCode: 'not-a-type' })),
      BizCode.CONTENT_TYPE_INVALID,
    );
    // INACTIVE 字典项也拒
    expectBizError(
      await createContent(validCreateBody({ contentTypeCode: 'archived_type' })),
      BizCode.CONTENT_TYPE_INVALID,
    );
  });

  it('⑪ visibilityCode 非法 5 档 → 29011(DTO @IsIn → 400 BAD_REQUEST)', async () => {
    const res = await createContent(validCreateBody({ visibilityCode: 'nobody' }));
    // DTO @IsIn 先挡 → 通用 400(评审稿:非法可见档 DTO 校验 400)
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
  });

  it('⑫ department 档需非空有效 orgs:空 → 29012;不存在 org → 29012;有效 org → 成功', async () => {
    // 空 visibleOrganizationIds
    expectBizError(
      await createContent(validCreateBody({ visibilityCode: 'department' })),
      BizCode.CONTENT_VISIBLE_ORG_INVALID,
    );
    // 不存在的 org
    expectBizError(
      await createContent(
        validCreateBody({ visibilityCode: 'department', visibleOrganizationIds: ['no-such-org'] }),
      ),
      BizCode.CONTENT_VISIBLE_ORG_INVALID,
    );
    // 有效活跃 org → 成功
    const org = await prisma.organization.create({
      data: { name: 'DeptA', nodeTypeCode: 'team', sortOrder: 0, status: 'ACTIVE' },
      select: { id: true },
    });
    const ok = await createContent(
      validCreateBody({ visibilityCode: 'department', visibleOrganizationIds: [org.id] }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.visibleOrganizationIds).toEqual([org.id]);
  });

  it('⑬ 非 department 档传非空 visibleOrganizationIds → 29012(须空)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'DeptB', nodeTypeCode: 'team', sortOrder: 0, status: 'ACTIVE' },
      select: { id: true },
    });
    expectBizError(
      await createContent(
        validCreateBody({ visibilityCode: 'public', visibleOrganizationIds: [org.id] }),
      ),
      BizCode.CONTENT_VISIBLE_ORG_INVALID,
    );
  });

  // ============================================================================
  // ⑤ 附件 Mode B(content-image + content-file)
  // ============================================================================

  it('⑭ content-image Mode B 上传/confirm → 详情含附件签名 URL(范围例外 a)', async () => {
    const id = await createDraft();
    const att = await uploadAttachment(id, imageUpload());
    expect(att.id).toBeTruthy();

    const detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    expect(detail.status).toBe(200);
    const images = (detail.body.data.attachments as Array<{ kind: string; url: string }>).filter(
      (a) => a.kind === 'image',
    );
    expect(images.length).toBe(1);
    expect(typeof images[0].url).toBe('string');
    expect(images[0].url).toMatch(/^\/uploads\//);

    // 审计:confirm 落 attachment.upload
    const uploadAudit = await prisma.auditLog.count({ where: { event: 'attachment.upload' } });
    expect(uploadAudit).toBe(1);
  });

  it('⑮ content-file Mode B 上传/confirm/删', async () => {
    const id = await createDraft();
    const att = await uploadAttachment(id, fileUpload());

    let detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    const files = (detail.body.data.attachments as Array<{ kind: string }>).filter(
      (a) => a.kind === 'file',
    );
    expect(files.length).toBe(1);

    // 删附件
    const del = await request(httpServer(app))
      .delete(`${ADMIN_CONTENTS}/${id}/attachments/${att.id}`)
      .set('Authorization', adminAuth);
    expect(del.status).toBe(200);
    detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    expect(detail.body.data.attachments.length).toBe(0);
    const delAudit = await prisma.auditLog.count({ where: { event: 'attachment.delete' } });
    expect(delAudit).toBe(1);
  });

  it('⑯ upload-url 对不存在内容 → 29001(owner 先存在)', async () => {
    const res = await request(httpServer(app))
      .post(`${ADMIN_CONTENTS}/nonexistent/attachments/upload-url`)
      .set('Authorization', adminAuth)
      .send(imageUpload());
    expectBizError(res, BizCode.CONTENT_NOT_FOUND);
  });

  it('⑰ MIME / size 闸:image 黑名单 mime → 13012;超 10MB → 13013;file 用 image mime → 13012', async () => {
    const id = await createDraft();
    // content-image 不含 application/pdf → 13012
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN_CONTENTS}/${id}/attachments/upload-url`)
        .set('Authorization', adminAuth)
        .send(imageUpload({ mime: 'application/pdf' })),
      BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    );
    // 超 content-image 10MB 上限 → 13013
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN_CONTENTS}/${id}/attachments/upload-url`)
        .set('Authorization', adminAuth)
        .send(imageUpload({ sizeBytes: 11 * 1024 * 1024 })),
      BizCode.ATTACHMENT_SIZE_EXCEEDED,
    );
    // content-file 不含 image/jpeg → 13012
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN_CONTENTS}/${id}/attachments/upload-url`)
        .set('Authorization', adminAuth)
        .send(fileUpload({ mime: 'image/jpeg' })),
      BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    );
  });

  it('⑱ 删附件归属校验:删非本文章附件 → 404(防越权)', async () => {
    const idA = await createDraft({ title: 'A' });
    const idB = await createDraft({ title: 'B' });
    const attA = await uploadAttachment(idA, imageUpload());
    // 用 B 的路径删 A 的附件 → 404(归属校验)
    const res = await request(httpServer(app))
      .delete(`${ADMIN_CONTENTS}/${idB}/attachments/${attA.id}`)
      .set('Authorization', adminAuth);
    expectBizError(res, BizCode.CONTENT_NOT_FOUND);
  });

  // ============================================================================
  // ⑥ 封面 set / clear(评审稿 §5.6)
  // ============================================================================

  it('⑲ 封面 set / clear:set content-image 附件 → coverImageUrl 非空;clear → null', async () => {
    const id = await createDraft();
    const att = await uploadAttachment(id, imageUpload());

    // set 封面
    const setRes = await request(httpServer(app))
      .put(`${ADMIN_CONTENTS}/${id}/cover`)
      .set('Authorization', adminAuth)
      .send({ attachmentId: att.id });
    expect(setRes.status).toBe(200);
    expect(setRes.body.data.coverAttachmentId).toBe(att.id);
    expect(typeof setRes.body.data.coverImageUrl).toBe('string');

    // 列表回显封面缩略图(coverImageKey 直签)
    const list = await request(httpServer(app)).get(ADMIN_CONTENTS).set('Authorization', adminAuth);
    const item = (list.body.data.items as Array<{ id: string; coverImageUrl: string | null }>).find(
      (i) => i.id === id,
    );
    expect(item?.coverImageUrl).toMatch(/^\/uploads\//);

    // clear 封面
    const clearRes = await request(httpServer(app))
      .put(`${ADMIN_CONTENTS}/${id}/cover`)
      .set('Authorization', adminAuth)
      .send({ attachmentId: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.data.coverAttachmentId).toBeNull();
    expect(clearRes.body.data.coverImageUrl).toBeNull();

    // set-cover 审计走 content.update extra.operation=set-cover(共 2 次:set + clear)
    const setCoverAudits = await prisma.auditLog.findMany({ where: { event: 'content.update' } });
    const setCoverOps = setCoverAudits.filter(
      (a) => (a.context as { extra?: { operation?: string } }).extra?.operation === 'set-cover',
    );
    expect(setCoverOps.length).toBe(2);
  });

  it('⑳ 封面 set 非本文章 content-image 附件 → 404', async () => {
    const idA = await createDraft({ title: 'A' });
    const idB = await createDraft({ title: 'B' });
    const attA = await uploadAttachment(idA, imageUpload());
    const res = await request(httpServer(app))
      .put(`${ADMIN_CONTENTS}/${idB}/cover`)
      .set('Authorization', adminAuth)
      .send({ attachmentId: attA.id });
    expectBizError(res, BizCode.CONTENT_NOT_FOUND);
  });

  it('㉑ 封面 set 用 content-file 附件(非 content-image)→ 404', async () => {
    const id = await createDraft();
    const file = await uploadAttachment(id, fileUpload());
    const res = await request(httpServer(app))
      .put(`${ADMIN_CONTENTS}/${id}/cover`)
      .set('Authorization', adminAuth)
      .send({ attachmentId: file.id });
    expectBizError(res, BizCode.CONTENT_NOT_FOUND);
  });

  // ============================================================================
  // ⑦ 正文图占位读时改写(评审稿 §5.5;wrinkle A)
  // ============================================================================

  it('㉒ 正文 attachment:<id> 占位:本文章 image id 改写为签名 URL;外来 id 原样保留', async () => {
    const id = await createDraft();
    const att = await uploadAttachment(id, imageUpload());
    const foreignId = 'cl0000000000foreignidxxxx';

    // 正文含本文章 image 占位 + 外来 id 占位
    await request(httpServer(app))
      .patch(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth)
      .send({
        body: `头图 ![cover](attachment:${att.id}) 中段 ![bad](attachment:${foreignId}) 尾`,
      })
      .expect(200);

    const detail = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}/${id}`)
      .set('Authorization', adminAuth);
    const body = detail.body.data.body as string;
    // 本文章 image id 被改写(不再含 attachment:<id> 字面,替换为 /uploads/ URL)
    expect(body).not.toContain(`attachment:${att.id}`);
    expect(body).toContain('/uploads/');
    // 外来 id 原样保留(零越权)
    expect(body).toContain(`attachment:${foreignId}`);
  });

  // ============================================================================
  // ⑧ viewCount:admin 详情不自增(评审稿 C)
  // ============================================================================

  it('㉓ admin 详情多次打开 viewCount 不自增(恒 0)', async () => {
    const id = await createDraft();
    for (let i = 0; i < 3; i++) {
      const d = await request(httpServer(app))
        .get(`${ADMIN_CONTENTS}/${id}`)
        .set('Authorization', adminAuth);
      expect(d.body.data.viewCount).toBe(0);
    }
    const row = await prisma.content.findFirstOrThrow({ where: { id } });
    expect(row.viewCount).toBe(0);
  });

  // ============================================================================
  // ⑨ 列表过滤(status / type / keyword / tags / pinned)+ 排序
  // ============================================================================

  it('㉔ 列表过滤:status / contentTypeCode / keyword / tags;admin 见全部状态', async () => {
    // 三条:draft announcement(tag a)/ published briefing(tag b,关键词命中)/ draft announcement(tag a)
    const id1 = await createDraft({
      title: '甲公告',
      contentTypeCode: CONTENT_TYPE_ANNOUNCEMENT,
      tags: ['a'],
    });
    const id2 = await createDraft({
      title: '乙简报SPECIAL',
      contentTypeCode: CONTENT_TYPE_BRIEFING,
      tags: ['b'],
      body: '正文含 SPECIAL 关键词',
    });
    await createDraft({ title: '丙公告', contentTypeCode: CONTENT_TYPE_ANNOUNCEMENT, tags: ['a'] });
    await post(`${ADMIN_CONTENTS}/${id2}/publish`);

    // admin 见全部状态(draft + published);total=3
    const all = await request(httpServer(app)).get(ADMIN_CONTENTS).set('Authorization', adminAuth);
    expect(all.body.data.total).toBe(3);

    // status=published → 仅 id2
    const pubOnly = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}?statusCode=published`)
      .set('Authorization', adminAuth);
    expect(pubOnly.body.data.total).toBe(1);
    expect(pubOnly.body.data.items[0].id).toBe(id2);

    // type=announcement → 2
    const byType = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}?contentTypeCode=${CONTENT_TYPE_ANNOUNCEMENT}`)
      .set('Authorization', adminAuth);
    expect(byType.body.data.total).toBe(2);

    // keyword=SPECIAL(标题 + 正文 ILIKE)→ 仅 id2
    const byKeyword = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}?keyword=special`)
      .set('Authorization', adminAuth);
    expect(byKeyword.body.data.total).toBe(1);
    expect(byKeyword.body.data.items[0].id).toBe(id2);

    // tags=a → 2(id1 + 丙)
    const byTag = await request(httpServer(app))
      .get(`${ADMIN_CONTENTS}?tags=a`)
      .set('Authorization', adminAuth);
    expect(byTag.body.data.total).toBe(2);
    const tagIds = (byTag.body.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(tagIds).toContain(id1);
  });

  it('㉕ 列表排序:pinned desc → publishedAt desc(nulls last)→ createdAt desc', async () => {
    // 普通 draft(无 publishedAt)
    const draftId = await createDraft({ title: '普通草稿' });
    // published(有 publishedAt)
    const pubId = await createDraft({ title: '已发布' });
    await post(`${ADMIN_CONTENTS}/${pubId}/publish`);
    // pinned draft → 排最前
    const pinnedId = await createDraft({ title: '置顶草稿', pinned: true });

    const list = await request(httpServer(app)).get(ADMIN_CONTENTS).set('Authorization', adminAuth);
    const ids = (list.body.data.items as Array<{ id: string }>).map((i) => i.id);
    // pinned 最前;其余 published(有 publishedAt)排在 draft(null publishedAt)之前
    expect(ids[0]).toBe(pinnedId);
    expect(ids.indexOf(pubId)).toBeLessThan(ids.indexOf(draftId));
  });
});
