import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditLogEvent, AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { MembersService } from '../../src/modules/members/members.service';
import { RealnameSettingsService } from '../../src/modules/realname/realname-settings.service';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { StorageSettingsService } from '../../src/modules/storage/storage-settings.service';
import { UsersService } from '../../src/modules/users/users.service';
import { WechatSettingsService } from '../../src/modules/wechat/wechat-settings.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 第六刀 finding 15:控制面高危写 audit characterization。
//
// 覆盖矩阵(第六刀 11 个事件 + 第七刀 members 轴 1 个事件):
// A. user.{role.update,status.update,soft-delete}
// B-E. storage/sms/wechat/realname setting.{update,reset-credentials}
// F. audit 写入后故意失败 → user / member 业务写与 audit 行同事务回滚
//
// 最硬红线锁定:
// - update 只在 context.extra.changedFields 记非敏感字段名,不记字段值。
// - reset-credentials 的 context 键集合严格等于 requestId/ip/ua;不含 before/after/extra,
//   并逐一断言不含本次明文和落库密文。

const AUDIT_META: AuditMeta = {
  requestId: 'control-plane-audit-req-00000001',
  ip: '127.0.0.1',
  ua: 'jest/30 control-plane-audit-characterization',
};

interface ReadAuditContext {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

describe('control-plane audit characterization (finding 15)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auditLogs: AuditLogsService;
  let users: UsersService;
  let members: MembersService;
  let storage: StorageSettingsService;
  let sms: SmsSettingsService;
  let wechat: WechatSettingsService;
  let realname: RealnameSettingsService;
  let actor: CurrentUserPayload;
  let targetSeq = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    prisma = app.get(PrismaService);
    auditLogs = app.get(AuditLogsService);
    users = app.get(UsersService);
    members = app.get(MembersService);
    storage = app.get(StorageSettingsService);
    sms = app.get(SmsSettingsService);
    wechat = app.get(WechatSettingsService);
    realname = app.get(RealnameSettingsService);

    const admin = await prisma.user.create({
      data: {
        username: 'control-plane-audit-admin',
        passwordHash: '$2a$10$synthetic-hash-unused-no-login',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    actor = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.storageSettings.deleteMany({});
    await prisma.smsSettings.deleteMany({});
    await prisma.wechatSettings.deleteMany({});
    await prisma.realnameVerificationSettings.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { not: actor.id } } });
    await prisma.member.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createTarget(
    role: Role = Role.USER,
    status: UserStatus = UserStatus.ACTIVE,
  ): Promise<string> {
    targetSeq += 1;
    const row = await prisma.user.create({
      data: {
        username: `control-audit-target-${targetSeq}`,
        passwordHash: '$2a$10$synthetic-hash-unused-no-login',
        role,
        status,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function readSingleAudit(
    event: AuditLogEvent,
    resourceType: string,
    resourceId: string,
  ): Promise<ReadAuditContext> {
    const rows = await prisma.auditLog.findMany({ where: { event } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actorUserId).toBe(actor.id);
    expect(row.actorRoleSnap).toBe(Role.SUPER_ADMIN);
    expect(row.resourceType).toBe(resourceType);
    expect(row.resourceId).toBe(resourceId);
    expect(row.success).toBe(true);

    const context = row.context as unknown as ReadAuditContext;
    expect(context.requestId).toBe(AUDIT_META.requestId);
    expect(context.ip).toBe(AUDIT_META.ip);
    expect(context.ua).toBe(AUDIT_META.ua);
    return context;
  }

  function assertResetContextContainsNoCredentials(
    context: ReadAuditContext,
    forbiddenValues: Array<string | null>,
  ): void {
    expect(Object.keys(context).sort()).toEqual(['ip', 'requestId', 'ua']);
    expect(context.before).toBeUndefined();
    expect(context.after).toBeUndefined();
    expect(context.extra).toBeUndefined();

    const serialized = JSON.stringify(context);
    for (const value of forbiddenValues) {
      if (value !== null) expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toMatch(/secret|credential|password|token|signed.?url/i);
  }

  describe('A. users high-risk writes', () => {
    it('A1. updateRole → one user.role.update audit with old/new role', async () => {
      const targetId = await createTarget(Role.USER);
      await users.updateRole(actor, targetId, { role: Role.ADMIN }, AUDIT_META);

      const context = await readSingleAudit('user.role.update', 'user', targetId);
      expect(context.before).toEqual({ role: Role.USER });
      expect(context.after).toEqual({ role: Role.ADMIN });
    });

    it('A2. updateStatus → one user.status.update audit with old/new status', async () => {
      const targetId = await createTarget(Role.USER, UserStatus.ACTIVE);
      await users.updateStatus(actor, targetId, { status: UserStatus.DISABLED }, AUDIT_META);

      const context = await readSingleAudit('user.status.update', 'user', targetId);
      expect(context.before).toEqual({ status: UserStatus.ACTIVE });
      expect(context.after).toEqual({ status: UserStatus.DISABLED });
    });

    it('A3. softDelete → one user.soft-delete audit with delete/status snapshot', async () => {
      const targetId = await createTarget(Role.USER, UserStatus.ACTIVE);
      await users.softDelete(actor, targetId, AUDIT_META);

      const context = await readSingleAudit('user.soft-delete', 'user', targetId);
      expect(context.before).toEqual({ deleted: false, status: UserStatus.ACTIVE });
      expect(context.after).toEqual({ deleted: true, status: UserStatus.DISABLED });
    });
  });

  describe('B. storage settings', () => {
    it('B1. updateSettings → one storage-setting.update audit with changed field names only', async () => {
      const row = await storage.updateSettings(
        { enabled: false, remarks: 'synthetic storage audit update' },
        actor,
        AUDIT_META,
      );

      const context = await readSingleAudit('storage-setting.update', 'storage_setting', row.id);
      expect(context.extra).toEqual({ changedFields: ['enabled', 'remarks'] });
      expect(JSON.stringify(context)).not.toContain('synthetic storage audit update');
    });

    it('B2. resetCredentials → one audit;context contains neither plaintext nor ciphertext', async () => {
      const plaintext = ['storage-secret-id-synthetic', 'storage-secret-key-synthetic'];
      const row = await storage.resetCredentials(
        { secretId: plaintext[0], secretKey: plaintext[1] },
        actor,
        AUDIT_META,
      );
      const stored = await prisma.storageSettings.findUniqueOrThrow({ where: { id: row.id } });

      const context = await readSingleAudit(
        'storage-setting.reset-credentials',
        'storage_setting',
        row.id,
      );
      assertResetContextContainsNoCredentials(context, [
        ...plaintext,
        stored.secretIdEncrypted,
        stored.secretKeyEncrypted,
      ]);
    });
  });

  describe('C. sms settings', () => {
    it('C1. updateSettings → one sms-setting.update audit with changed field names only', async () => {
      const row = await sms.updateSettings(
        { enabled: false, remarks: 'synthetic sms audit update' },
        actor,
        AUDIT_META,
      );

      const context = await readSingleAudit('sms-setting.update', 'sms_setting', row.id);
      expect(context.extra).toEqual({ changedFields: ['enabled', 'remarks'] });
      expect(JSON.stringify(context)).not.toContain('synthetic sms audit update');
    });

    it('C2. resetCredentials → one audit;context contains neither plaintext nor ciphertext', async () => {
      const plaintext = ['sms-secret-id-synthetic', 'sms-secret-key-synthetic'];
      const row = await sms.resetCredentials(
        { secretId: plaintext[0], secretKey: plaintext[1] },
        actor,
        AUDIT_META,
      );
      const stored = await prisma.smsSettings.findUniqueOrThrow({ where: { id: row.id } });

      const context = await readSingleAudit('sms-setting.reset-credentials', 'sms_setting', row.id);
      assertResetContextContainsNoCredentials(context, [
        ...plaintext,
        stored.secretIdEncrypted,
        stored.secretKeyEncrypted,
      ]);
    });
  });

  describe('D. wechat settings', () => {
    it('D1. updateSettings → one wechat-setting.update audit with changed field names only', async () => {
      const row = await wechat.updateSettings(
        { enabled: false, remarks: 'synthetic wechat audit update' },
        actor,
        AUDIT_META,
      );

      const context = await readSingleAudit('wechat-setting.update', 'wechat_setting', row.id);
      expect(context.extra).toEqual({ changedFields: ['enabled', 'remarks'] });
      expect(JSON.stringify(context)).not.toContain('synthetic wechat audit update');
    });

    it('D2. resetCredentials → one audit;context contains neither plaintext nor ciphertext', async () => {
      const plaintext = 'wechat-app-secret-synthetic';
      const row = await wechat.resetCredentials({ appSecret: plaintext }, actor, AUDIT_META);
      const stored = await prisma.wechatSettings.findUniqueOrThrow({ where: { id: row.id } });

      const context = await readSingleAudit(
        'wechat-setting.reset-credentials',
        'wechat_setting',
        row.id,
      );
      assertResetContextContainsNoCredentials(context, [plaintext, stored.appSecretEncrypted]);
    });
  });

  describe('E. realname settings', () => {
    it('E1. updateSettings → one realname-setting.update audit with changed field names only', async () => {
      const row = await realname.updateSettings(
        { enabled: false, remarks: 'synthetic realname audit update' },
        actor,
        AUDIT_META,
      );

      const context = await readSingleAudit('realname-setting.update', 'realname_setting', row.id);
      expect(context.extra).toEqual({ changedFields: ['enabled', 'remarks'] });
      expect(JSON.stringify(context)).not.toContain('synthetic realname audit update');
    });

    it('E2. resetCredentials → one audit;context contains neither plaintext nor ciphertext', async () => {
      const plaintext = ['realname-secret-id-synthetic', 'realname-secret-key-synthetic'];
      const row = await realname.resetCredentials(
        { secretId: plaintext[0], secretKey: plaintext[1] },
        actor,
        AUDIT_META,
      );
      const stored = await prisma.realnameVerificationSettings.findUniqueOrThrow({
        where: { id: row.id },
      });

      const context = await readSingleAudit(
        'realname-setting.reset-credentials',
        'realname_setting',
        row.id,
      );
      assertResetContextContainsNoCredentials(context, [
        ...plaintext,
        stored.secretIdEncrypted,
        stored.secretKeyEncrypted,
      ]);
    });
  });

  describe('F. transaction rollback', () => {
    it('F1. audit writes then fails → user role and audit row both roll back', async () => {
      const targetId = await createTarget(Role.USER);
      const realLog = auditLogs.log.bind(auditLogs);
      jest.spyOn(auditLogs, 'log').mockImplementationOnce(async (input) => {
        await realLog(input);
        throw new Error('synthetic audit failure after insert');
      });

      await expect(
        users.updateRole(actor, targetId, { role: Role.ADMIN }, AUDIT_META),
      ).rejects.toThrow('synthetic audit failure after insert');

      expect((await prisma.user.findUniqueOrThrow({ where: { id: targetId } })).role).toBe(
        Role.USER,
      );
      expect(await prisma.auditLog.count({ where: { event: 'user.role.update' } })).toBe(0);
    });

    it('F2. members audit writes then fails → account status and audit row both roll back', async () => {
      targetSeq += 1;
      const member = await prisma.member.create({
        data: {
          memberNo: `control-audit-member-${targetSeq}`,
          displayName: `Control Audit Member ${targetSeq}`,
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const targetId = await createTarget(Role.USER, UserStatus.ACTIVE);
      await prisma.user.update({ where: { id: targetId }, data: { memberId: member.id } });

      const realLog = auditLogs.log.bind(auditLogs);
      jest.spyOn(auditLogs, 'log').mockImplementationOnce(async (input) => {
        await realLog(input);
        throw new Error('synthetic member audit failure after insert');
      });

      await expect(
        members.updateAccountStatus(member.id, { status: UserStatus.DISABLED }, actor, AUDIT_META),
      ).rejects.toThrow('synthetic member audit failure after insert');

      expect((await prisma.user.findUniqueOrThrow({ where: { id: targetId } })).status).toBe(
        UserStatus.ACTIVE,
      );
      expect(
        await prisma.auditLog.count({ where: { event: 'member.account.status-change' } }),
      ).toBe(0);
    });
  });
});
