import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { MemberProfilesService } from '../../src/modules/member-profiles/member-profiles.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// member-profiles 敏感字段分级 masking(第三轮全仓 review v0.38.0 §F&A-3)。
// service-level e2e(沿 organizations-audit-characterization 范式):app.get(Service) 直调,构造不同 actor payload。
//
// 分级:入口码 member-profile.read.record 仍是门闸;documentNumber / mobile 明文需更严的
// member-profile.read.sensitive。覆盖 3 出口(findOne / create 回显 / update 回显)× 三类 actor:
//   - SUPER_ADMIN → 明文(rbac.can 短路)
//   - 持 read.record + create/update.record 但**无** read.sensitive → 掩码
//   - 持 read.record + read.sensitive → 明文
// R13:证件号 / 手机号一律合成占位,非真实。

const PLAIN_ID = '110101199001011234'; // 18 位合成证件号
const PLAIN_MOBILE = '13800000001';
const MASKED_ID = '110101********1234'; // maskIdCard(18 位):前 6 + 8*'*' + 后 4
const MASKED_MOBILE = '138****0001'; // maskPhone(11 位)

describe('member-profiles sensitive masking (F&A-3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: MemberProfilesService;
  let saPayload: CurrentUserPayload;
  let recordOnlyPayload: CurrentUserPayload; // read/create/update.record,无 read.sensitive → 掩码
  let sensitivePayload: CurrentUserPayload; // read.record + read.sensitive → 明文

  let memberSeq = 0;
  async function newMember(): Promise<string> {
    memberSeq += 1;
    const m = await prisma.member.create({
      data: { memberNo: `mp-mask-m${memberSeq}`, displayName: `MPMask${memberSeq}` },
      select: { id: true },
    });
    return m.id;
  }

  // 直连 prisma 建 profile(绕过 dict 校验;findOne 路径用),明文入库。
  async function seedProfile(memberId: string): Promise<void> {
    await prisma.memberProfile.create({
      data: {
        memberId,
        realName: 'Mask Test',
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id-card',
        documentNumber: PLAIN_ID,
        mobile: PLAIN_MOBILE,
        email: 'mask@test.local',
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'other',
        privacyConsentSigned: true,
      },
    });
  }

  // 建 role + 绑定指定 codes + GLOBAL RoleBinding 给新 USER,返回其 payload(判权读源 = GLOBAL RoleBinding)。
  async function seedActor(username: string, codes: string[]): Promise<CurrentUserPayload> {
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: '$2a$10$dummy-hash-not-used',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: `mp-mask-role-${username}`, displayName: username },
      select: { id: true },
    });
    for (const code of codes) {
      const [module, action, resourceType] = code.split('.');
      const perm = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module, action, resourceType },
        select: { id: true },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: user.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
    return {
      id: user.id,
      username,
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(MemberProfilesService);

    const sa = await prisma.user.create({
      data: {
        username: 'mp-mask-sa',
        passwordHash: '$2a$10$dummy-hash-not-used',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    saPayload = {
      id: sa.id,
      username: 'mp-mask-sa',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    recordOnlyPayload = await seedActor('mp-mask-record', [
      'member-profile.read.record',
      'member-profile.create.record',
      'member-profile.update.record',
    ]);
    sensitivePayload = await seedActor('mp-mask-sensitive', [
      'member-profile.read.record',
      'member-profile.create.record',
      'member-profile.update.record',
      'member-profile.read.sensitive',
    ]);

    // create / update 路径需 dict gender + document_type(status 默认 ACTIVE)。
    const genderType = await prisma.dictType.create({
      data: { code: 'gender', label: '性别' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: genderType.id, code: 'male', label: '男' } });
    const docType = await prisma.dictType.create({
      data: { code: 'document_type', label: '证件类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: docType.id, code: 'id-card', label: '身份证' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ A. findOne ============
  describe('A. findOne 分级', () => {
    it('A1. 无 read.sensitive → documentNumber / mobile 掩码;其余字段明文', async () => {
      const memberId = await newMember();
      await seedProfile(memberId);
      const dto = await service.findOne(memberId, recordOnlyPayload);
      expect(dto).not.toBeNull();
      expect(dto!.documentNumber).toBe(MASKED_ID);
      expect(dto!.mobile).toBe(MASKED_MOBILE);
      expect(dto!.realName).toBe('Mask Test'); // 非敏感字段不动
      expect(dto!.email).toBe('mask@test.local');
    });

    it('A2. 持 read.sensitive → documentNumber / mobile 明文', async () => {
      const memberId = await newMember();
      await seedProfile(memberId);
      const dto = await service.findOne(memberId, sensitivePayload);
      expect(dto!.documentNumber).toBe(PLAIN_ID);
      expect(dto!.mobile).toBe(PLAIN_MOBILE);
    });

    it('A3. SUPER_ADMIN → 明文(rbac.can 短路)', async () => {
      const memberId = await newMember();
      await seedProfile(memberId);
      const dto = await service.findOne(memberId, saPayload);
      expect(dto!.documentNumber).toBe(PLAIN_ID);
      expect(dto!.mobile).toBe(PLAIN_MOBILE);
    });

    it('A4. member 有但无 profile → null(不因掩码报错)', async () => {
      const memberId = await newMember();
      const dto = await service.findOne(memberId, recordOnlyPayload);
      expect(dto).toBeNull();
    });
  });

  // ============ B. create 回显分级 ============
  describe('B. create 回显分级', () => {
    function payload() {
      return {
        realName: 'Create Mask',
        genderCode: 'male',
        birthDate: '1992-02-02',
        documentTypeCode: 'id-card',
        documentNumber: PLAIN_ID,
        mobile: PLAIN_MOBILE,
        email: 'cmask@test.local',
        joinedDate: '2021-03-03',
        joinSourceCode: 'other',
        privacyConsentSigned: true,
      };
    }

    it('B1. 无 read.sensitive create → 回显掩码;库内仍明文', async () => {
      const memberId = await newMember();
      const dto = await service.create(memberId, payload(), recordOnlyPayload);
      expect(dto.documentNumber).toBe(MASKED_ID);
      expect(dto.mobile).toBe(MASKED_MOBILE);
      // 库内明文(掩码仅出口值变换,不改存储)
      const row = await prisma.memberProfile.findUniqueOrThrow({ where: { memberId } });
      expect(row.documentNumber).toBe(PLAIN_ID);
      expect(row.mobile).toBe(PLAIN_MOBILE);
    });

    it('B2. SUPER_ADMIN create → 回显明文', async () => {
      const memberId = await newMember();
      const dto = await service.create(memberId, payload(), saPayload);
      expect(dto.documentNumber).toBe(PLAIN_ID);
      expect(dto.mobile).toBe(PLAIN_MOBILE);
    });
  });

  // ============ C. update 回显分级 ============
  describe('C. update 回显分级', () => {
    it('C1. 无 read.sensitive update → 回显掩码', async () => {
      const memberId = await newMember();
      await seedProfile(memberId);
      const dto = await service.update(memberId, { realName: 'Updated' }, recordOnlyPayload);
      expect(dto.realName).toBe('Updated');
      expect(dto.documentNumber).toBe(MASKED_ID);
      expect(dto.mobile).toBe(MASKED_MOBILE);
    });

    it('C2. 持 read.sensitive update → 回显明文', async () => {
      const memberId = await newMember();
      await seedProfile(memberId);
      const dto = await service.update(memberId, { realName: 'Updated2' }, sensitivePayload);
      expect(dto.documentNumber).toBe(PLAIN_ID);
      expect(dto.mobile).toBe(PLAIN_MOBILE);
    });
  });
});
