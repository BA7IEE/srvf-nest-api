import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { BirthdayGreetingService } from '../../src/modules/notifications/birthday-greeting.service';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 生日祝福 job e2e(goal DoD-6/7;冻结评审稿 queue-b-otp-birthday-infra-review.md §6/§7)。
//
// **直调范式**(评审稿 E-B11):app.get(BirthdayGreetingService).runOnce()——不等真实定时;
// 选取 / 幂等 / 前置检查 / 流水落库语义全部经直调 + 真实 DB 锁定;
// @Cron 注册本身由 docker-smoke 启动锚行验证(E-B10),不在本文件覆盖。
// settings 60s 缓存:直插 settings 行后调 SmsSettingsService.invalidate()(公开方法)。
//
// 单条失败路径(provider 抛错)在 unit 经 mock router 锁定,e2e 走 DevStub 恒成功链路。

const PHONE_HIT = '13920000001';
const PHONE_HIT2 = '13920000007';

// 用固定 UTC+8 日界口径构造"今天生日"(出生年任意取 1990;UTC 04:00 = UTC+8 12:00 稳居当日)
function birthDateTodayUtc8(): Date {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(Date.UTC(1990, shifted.getUTCMonth(), shifted.getUTCDate(), 4, 0, 0));
}

// 加 40 天:任何月份长度下月日组合必然改变
function birthDateNotTodayUtc8(): Date {
  return new Date(birthDateTodayUtc8().getTime() + 40 * 86_400_000);
}

describe('生日祝福 job(直调 runOnce;不等真实定时)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let job: BirthdayGreetingService;
  let settings: SmsSettingsService;
  let seq = 0;

  async function createMemberWithProfile(input: {
    username: string;
    birthDate: Date;
    memberStatus?: 'ACTIVE' | 'INACTIVE';
    profileDeletedAt?: Date | null;
    userPhone?: string | null;
    userStatus?: 'ACTIVE' | 'DISABLED';
  }): Promise<void> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `BD${String(seq).padStart(4, '0')}`,
        displayName: `生日测试${seq}`,
        status: input.memberStatus ?? 'ACTIVE',
      },
    });
    await prisma.memberProfile.create({
      data: {
        memberId: member.id,
        realName: `生日测试${seq}`,
        genderCode: 'male',
        birthDate: input.birthDate,
        documentTypeCode: 'id_card',
        documentNumber: `11010119900101${String(seq).padStart(4, '0')}`,
        mobile: `1351000${String(seq).padStart(4, '0')}`, // MemberProfile.mobile 永不用于发送(拍板⑤)
        email: `bd${seq}@example.com`,
        joinedDate: new Date('2024-01-01T00:00:00.000Z'),
        joinSourceCode: 'recruitment',
        privacyConsentSigned: true,
        deletedAt: input.profileDeletedAt ?? null,
      },
    });
    const user = await createTestUser(app, {
      username: input.username,
      status: input.userStatus ?? 'ACTIVE',
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id, phone: input.userPhone ?? null },
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    job = app.get(BirthdayGreetingService);
    settings = app.get(SmsSettingsService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('前置检查:settings 未配置 → 整批跳过零行;配置但 templateIdBirthday 空 → 同跳过', async () => {
    expect(await job.runOnce()).toEqual({
      selected: 0,
      sent: 0,
      skippedIdempotent: 0,
      failed: 0,
    });

    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    settings.invalidate();
    expect(await job.runOnce()).toEqual({
      selected: 0,
      sent: 0,
      skippedIdempotent: 0,
      failed: 0,
    });
    expect(await prisma.smsSendLog.count()).toBe(0);
  });

  it('六类造数:仅全链命中者发送;send_logs 行字段正确(templateKey/providerType/codeId=null);summary 与 DB 一致', async () => {
    await prisma.smsSettings.updateMany({ data: { templateIdBirthday: 'tpl-bd-001' } });
    settings.invalidate();

    const today = birthDateTodayUtc8();
    await createMemberWithProfile({ username: 'bd_hit', birthDate: today, userPhone: PHONE_HIT }); // ① 应发
    await createMemberWithProfile({
      username: 'bd_not_today',
      birthDate: birthDateNotTodayUtc8(),
      userPhone: '13920000002',
    }); // ② 月日不符
    await createMemberWithProfile({
      username: 'bd_member_inactive',
      birthDate: today,
      memberStatus: 'INACTIVE',
      userPhone: '13920000003',
    }); // ③ member INACTIVE
    await createMemberWithProfile({ username: 'bd_no_phone', birthDate: today, userPhone: null }); // ④ 无 phone
    await createMemberWithProfile({
      username: 'bd_user_disabled',
      birthDate: today,
      userPhone: '13920000005',
      userStatus: 'DISABLED',
    }); // ⑤ user DISABLED
    await createMemberWithProfile({
      username: 'bd_profile_deleted',
      birthDate: today,
      profileDeletedAt: new Date(),
      userPhone: '13920000006',
    }); // ⑥ profile 软删

    const summary = await job.runOnce();
    expect(summary).toEqual({ selected: 1, sent: 1, skippedIdempotent: 0, failed: 0 });

    const rows = await prisma.smsSendLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phone: PHONE_HIT,
      templateKey: 'birthday-greeting',
      providerType: 'DEV_STUB',
      status: 'SENT',
      codeId: null, // 非验证码类发送
    });
  });

  it('幂等:立即二跑零新增(skippedIdempotent);重启语义 = 以 DB 为准,直调即模拟重启后再跑', async () => {
    const second = await job.runOnce();
    expect(second).toEqual({ selected: 1, sent: 0, skippedIdempotent: 1, failed: 0 });
    expect(await prisma.smsSendLog.count({ where: { templateKey: 'birthday-greeting' } })).toBe(1); // 仍只有一行,未重发

    // FAILED 行不挡重试边界(E-B6):把唯一 SENT 行改为 FAILED → 三跑会再发
    await prisma.smsSendLog.updateMany({
      where: { phone: PHONE_HIT },
      data: { status: 'FAILED' },
    });
    const third = await job.runOnce();
    expect(third).toEqual({ selected: 1, sent: 1, skippedIdempotent: 0, failed: 0 });
  });

  it('当日新增命中者:已发者跳过、新者照发(幂等按号隔离)', async () => {
    await createMemberWithProfile({
      username: 'bd_hit2',
      birthDate: birthDateTodayUtc8(),
      userPhone: PHONE_HIT2,
    });
    const summary = await job.runOnce();
    expect(summary).toEqual({ selected: 2, sent: 1, skippedIdempotent: 1, failed: 0 });
    expect(
      await prisma.smsSendLog.count({
        where: { phone: PHONE_HIT2, templateKey: 'birthday-greeting', status: 'SENT' },
      }),
    ).toBe(1);
  });
});
