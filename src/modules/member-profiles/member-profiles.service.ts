import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { maskIdCard, maskPhone } from '../../common/audit/mask-pii.util';
import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { CreateMemberProfileDto } from './dto/create-member-profile.dto';
import { MemberProfileResponseDto } from './dto/member-profile-response.dto';
import { UpdateMemberProfileDto } from './dto/update-member-profile.dto';

// V2 第一阶段批次 1 member_profiles service。
// 详见 docs:批次1_API前评审... §3 / §6 / §9 + 草案 §4 / §10。
//
// 关键约定:
// - 1:1 with Member;memberId 唯一(schema @unique)
// - findOne member 存在但无 profile → 返 null(沿用 member-departments.findCurrent 风格)
// - 字典 code 校验:5 个 NOT NULL + 5 个可空字典字段提供时校验(对应 BizCode 16010-16014)
// - 日期字段 birthDate / joinedDate / privacyConsentSignedAt 入库前规范化为 UTC 00:00:00.000
// - audit:findOne 查询完成后 fail-closed 落 profile.read.other;create/update 不扩本批次审计面

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
// 必须与 MemberProfileResponseDto 同步维护。
const memberProfileSafeSelect = {
  id: true,
  memberId: true,
  realName: true,
  genderCode: true,
  birthDate: true,
  documentTypeCode: true,
  documentNumber: true,
  ethnicityCode: true,
  politicalStatusCode: true,
  isVeteran: true,
  maritalStatusCode: true,
  educationCode: true,
  major: true,
  workNatureCode: true,
  residenceArea: true,
  workArea: true,
  mobile: true,
  landline: true,
  email: true,
  qq: true,
  wechat: true,
  heightCm: true,
  weightKg: true,
  bloodTypeCode: true,
  eyesight: true,
  medicalNotes: true,
  hasVehicle: true,
  vehicleType: true,
  exerciseFrequencyCode: true,
  exerciseSportCode: true,
  exerciseMethods: true,
  firstAidKnowledgeCode: true,
  firstAidSkills: true,
  otherSkills: true,
  joinedDate: true,
  joinSourceCode: true,
  noCriminalRecordSigned: true,
  privacyConsentSigned: true,
  privacyConsentSignedAt: true,
  volunteerNo: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberProfileSelect;

type PrismaTx = Prisma.TransactionClient;

// 第三轮全仓 review(v0.38.0)§F&A-3 收口:管理档案面敏感字段分级。入口码 member-profile.read.record
// 仍是门闸;无更严的 member-profile.read.sensitive 者,在全部 3 个响应出口(findOne / create 回显 /
// update 回显)看到掩码后的 documentNumber(证件号)与 mobile(本人手机)。掩码格式复用 mask-pii.util
// (documentNumber → maskIdCard〔15/18 位保前 6 后 4,余长度 → '****'〕/ mobile → maskPhone〔138****1234〕,
// 该 helper 注释即预留「member_profiles 复活时使用」)。maskX 对 null/空串短路返回 null,`?? 原值` 兜底。
//
// 十项收口刀D(2026-07-11「全收紧」拍板;⚠️ 行为变更):掩码集由 2 字段扩为全量敏感面——精确生日、
// 座机、email/QQ/微信、医疗五项(身高/体重/血型/视力/病史)无 sensitive 码时一律置 null(生日等无
// 在型掩码格式,统一 null 化;birthDate/email 响应类型随之放宽为 nullable)。背景:组长(group-manager)
// 持 read.record 可见全队明文生日/病史,与招新面「连持 sensitive 的 admin 都只见年龄段」口径倒挂。
// 带队应急需要明文者按人绑 member-profile.read.sensitive(role-binding)。App 自助面(本人)零碰。
// ⚠️ FE 回写陷阱:编辑表单 round-trip 会把 null/掩码值写回覆盖真值——admin-web 须沿 hasPerms 镜像
// + 无权字段 delete 的既有范式适配(首例 member-profile v0.39.0)。
function presentMemberProfile(
  profile: MemberProfileResponseDto,
  masked: boolean,
): MemberProfileResponseDto {
  if (!masked) return profile;
  return {
    ...profile,
    documentNumber: maskIdCard(profile.documentNumber) ?? profile.documentNumber,
    mobile: maskPhone(profile.mobile) ?? profile.mobile,
    birthDate: null,
    landline: null,
    email: null,
    qq: null,
    wechat: null,
    heightCm: null,
    weightKg: null,
    bloodTypeCode: null,
    eyesight: null,
    medicalNotes: null,
  };
}

// 字典 type code 常量(对应 prisma/seed.ts V2_DICT_SEED 必开 6 个 + 草案 §12.1)。
const DICT_TYPE_GENDER = 'gender';
const DICT_TYPE_DOCUMENT_TYPE = 'document_type';
const DICT_TYPE_POLITICAL_STATUS = 'political_status';
const DICT_TYPE_BLOOD_TYPE = 'blood_type';
const DICT_TYPE_WORK_NATURE = 'work_nature';

@Injectable()
export class MemberProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  // ============ helpers ============

  // v0.49:档案管理统一按 member 的 active PRIMARY 组织归属做 point auth；不存在资源仅对
  // 原 GLOBAL 持码者保留既有 MEMBER_NOT_FOUND。
  private async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    memberId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, { type: 'member', id: memberId });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) return;
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  // 校验 member 存在且未软删(沿用 member-departments / members 模式)。
  private async findMemberOrThrow(memberId: string, tx?: PrismaTx): Promise<{ id: string }> {
    const client = tx ?? this.prisma;
    const m = await client.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return m;
  }

  // 通用字典 code 校验(对齐 members.assertGradeCodeValid 模式):
  //   dict_type.code = typeCode + ACTIVE + deletedAt=null
  //   dict_item.code = code + ACTIVE + deletedAt=null
  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx?: PrismaTx,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // P2002 兜底:并发场景下预检查通过但 create 撞 1:1 唯一约束。
  // member-departments 模式:Prisma 6.x P2002 meta.target 不可靠,直接转 ALREADY_EXISTS。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.MEMBER_PROFILE_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // 校验所有提供了的字典 code(create / update 共用)。
  // genderCode / documentTypeCode 在 create 时必填(DTO 层已保证非空);其余可选。
  private async assertAllDictCodes(
    dto: {
      genderCode?: string;
      documentTypeCode?: string;
      politicalStatusCode?: string;
      bloodTypeCode?: string;
      workNatureCode?: string;
    },
    tx?: PrismaTx,
  ): Promise<void> {
    if (dto.genderCode !== undefined) {
      await this.assertDictItemValid(
        DICT_TYPE_GENDER,
        dto.genderCode,
        BizCode.MEMBER_PROFILE_GENDER_CODE_INVALID,
        tx,
      );
    }
    if (dto.documentTypeCode !== undefined) {
      await this.assertDictItemValid(
        DICT_TYPE_DOCUMENT_TYPE,
        dto.documentTypeCode,
        BizCode.MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID,
        tx,
      );
    }
    if (dto.politicalStatusCode !== undefined) {
      await this.assertDictItemValid(
        DICT_TYPE_POLITICAL_STATUS,
        dto.politicalStatusCode,
        BizCode.MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID,
        tx,
      );
    }
    if (dto.bloodTypeCode !== undefined) {
      await this.assertDictItemValid(
        DICT_TYPE_BLOOD_TYPE,
        dto.bloodTypeCode,
        BizCode.MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID,
        tx,
      );
    }
    if (dto.workNatureCode !== undefined) {
      await this.assertDictItemValid(
        DICT_TYPE_WORK_NATURE,
        dto.workNatureCode,
        BizCode.MEMBER_PROFILE_WORK_NATURE_CODE_INVALID,
        tx,
      );
    }
  }

  // ============ findOne ============

  // 决策:member 存在但无 profile → 返 null(批次 1 评审 §1.1)。
  // member 不存在 → MEMBER_NOT_FOUND。
  // hook A2 profile.read.other:本批次仅 ADMIN/SUPER_ADMIN 路由,无论是否找到 profile,
  // 只要发起一次"看他人档案"动作就记录(顶层 §11 + 草案 §14)。
  async findOne(
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberProfileResponseDto | null> {
    await this.assertCanOrThrow(currentUser, 'member-profile.read.record', memberId);
    await this.findMemberOrThrow(memberId);

    // §F&A-3:无 read.sensitive 者见掩码(入口码仍是 read.record)。
    const masked = !(await this.authz.can(currentUser, 'member-profile.read.sensitive', {
      type: 'member',
      id: memberId,
    }));

    const profile = await this.prisma.memberProfile.findFirst({
      where: notDeletedWhere({ memberId }),
      select: memberProfileSafeSelect,
    });

    await this.auditLogs.log({
      event: 'profile.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member_profile',
      resourceId: profile?.id ?? null,
      meta: auditMeta,
      extra: {
        operation: 'detail',
        targetMemberId: memberId,
        maskLevel: masked ? 'masked' : 'plain',
      },
    });

    if (!profile) return null;
    return presentMemberProfile(profile as MemberProfileResponseDto, masked);
  }

  // ============ create ============

  // 批次 1 不打 A3 update.self / A4 update.review hook(无 USER 自助接口、不实现审批流)。
  // Slow-4 T2:currentUser 仅用于 rbac 判权,不改 audit 行为。
  async create(
    memberId: string,
    dto: CreateMemberProfileDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member-profile.create.record', memberId);
    // §F&A-3:create 回显同 findOne 分级(无 read.sensitive 见掩码 documentNumber / mobile)。
    const masked = !(await this.authz.can(currentUser, 'member-profile.read.sensitive', {
      type: 'member',
      id: memberId,
    }));
    return this.prisma.$transaction(async (tx) => {
      // 1. 校验 member 存在
      await this.findMemberOrThrow(memberId, tx);

      // 2. 校验所有提供的字典 code
      await this.assertAllDictCodes(dto, tx);

      // 3. 1:1 唯一性预检查(包含软删 — 草案 Q-S07 保留 deletedAt 字段位但不开放业务删除,
      //    本批次软删记录视为占用,与 members memberNo 同模式)
      const existing = await tx.memberProfile.findUnique({
        where: { memberId },
        select: { id: true },
      });
      if (existing) throw new BizException(BizCode.MEMBER_PROFILE_ALREADY_EXISTS);

      // 4. 创建 + P2002 兜底防并发
      const data: Prisma.MemberProfileUncheckedCreateInput = {
        memberId,
        realName: dto.realName,
        genderCode: dto.genderCode,
        birthDate: normalizeDateOnly(dto.birthDate),
        documentTypeCode: dto.documentTypeCode,
        documentNumber: dto.documentNumber,
        mobile: dto.mobile,
        email: dto.email,
        joinedDate: normalizeDateOnly(dto.joinedDate),
        joinSourceCode: dto.joinSourceCode,
        privacyConsentSigned: dto.privacyConsentSigned,
        ethnicityCode: dto.ethnicityCode,
        politicalStatusCode: dto.politicalStatusCode,
        isVeteran: dto.isVeteran,
        maritalStatusCode: dto.maritalStatusCode,
        educationCode: dto.educationCode,
        major: dto.major,
        workNatureCode: dto.workNatureCode,
        residenceArea: dto.residenceArea,
        workArea: dto.workArea,
        landline: dto.landline,
        qq: dto.qq,
        wechat: dto.wechat,
        heightCm: dto.heightCm,
        weightKg: dto.weightKg,
        bloodTypeCode: dto.bloodTypeCode,
        eyesight: dto.eyesight,
        hasVehicle: dto.hasVehicle,
        vehicleType: dto.vehicleType,
        exerciseFrequencyCode: dto.exerciseFrequencyCode,
        exerciseSportCode: dto.exerciseSportCode,
        firstAidKnowledgeCode: dto.firstAidKnowledgeCode,
        otherSkills: dto.otherSkills,
        noCriminalRecordSigned: dto.noCriminalRecordSigned,
        volunteerNo: dto.volunteerNo,
      };
      // medicalNotes JSON:class-transformer 实例可序列化,直接 cast(运行时正确)。
      if (dto.medicalNotes !== undefined) {
        data.medicalNotes = dto.medicalNotes as unknown as Prisma.InputJsonValue;
      }
      // String[] 字段:undefined 时 Prisma 写入空数组(PG 默认行为)
      if (dto.exerciseMethods !== undefined) data.exerciseMethods = dto.exerciseMethods;
      if (dto.firstAidSkills !== undefined) data.firstAidSkills = dto.firstAidSkills;
      // 日期可选字段
      if (dto.privacyConsentSignedAt !== undefined) {
        data.privacyConsentSignedAt = normalizeDateOnly(dto.privacyConsentSignedAt);
      }

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.memberProfile.create({
          data,
          select: memberProfileSafeSelect,
        }),
      );
      return presentMemberProfile(created as MemberProfileResponseDto, masked);
    });
  }

  // ============ update ============

  async update(
    memberId: string,
    dto: UpdateMemberProfileDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member-profile.update.record', memberId);
    // §F&A-3:update 回显同 findOne 分级(无 read.sensitive 见掩码 documentNumber / mobile)。
    const masked = !(await this.authz.can(currentUser, 'member-profile.read.sensitive', {
      type: 'member',
      id: memberId,
    }));
    return this.prisma.$transaction(async (tx) => {
      // 1. 校验 member 存在
      await this.findMemberOrThrow(memberId, tx);

      // 2. 找 profile(notDeleted)
      const profile = await tx.memberProfile.findFirst({
        where: notDeletedWhere({ memberId }),
        select: { id: true },
      });
      if (!profile) throw new BizException(BizCode.MEMBER_PROFILE_NOT_FOUND);

      // 3. 校验提供了的字典字段
      await this.assertAllDictCodes(dto, tx);

      // 4. 构造 update data — 只写入提供的字段(Prisma 跳过 undefined)
      const data: Prisma.MemberProfileUpdateInput = {};
      if (dto.realName !== undefined) data.realName = dto.realName;
      if (dto.genderCode !== undefined) data.genderCode = dto.genderCode;
      if (dto.birthDate !== undefined) data.birthDate = normalizeDateOnly(dto.birthDate);
      if (dto.documentTypeCode !== undefined) data.documentTypeCode = dto.documentTypeCode;
      if (dto.documentNumber !== undefined) data.documentNumber = dto.documentNumber;
      if (dto.ethnicityCode !== undefined) data.ethnicityCode = dto.ethnicityCode;
      if (dto.politicalStatusCode !== undefined) data.politicalStatusCode = dto.politicalStatusCode;
      if (dto.isVeteran !== undefined) data.isVeteran = dto.isVeteran;
      if (dto.maritalStatusCode !== undefined) data.maritalStatusCode = dto.maritalStatusCode;
      if (dto.educationCode !== undefined) data.educationCode = dto.educationCode;
      if (dto.major !== undefined) data.major = dto.major;
      if (dto.workNatureCode !== undefined) data.workNatureCode = dto.workNatureCode;
      if (dto.residenceArea !== undefined) data.residenceArea = dto.residenceArea;
      if (dto.workArea !== undefined) data.workArea = dto.workArea;
      if (dto.mobile !== undefined) data.mobile = dto.mobile;
      if (dto.landline !== undefined) data.landline = dto.landline;
      if (dto.email !== undefined) data.email = dto.email;
      if (dto.qq !== undefined) data.qq = dto.qq;
      if (dto.wechat !== undefined) data.wechat = dto.wechat;
      if (dto.heightCm !== undefined) data.heightCm = dto.heightCm;
      if (dto.weightKg !== undefined) data.weightKg = dto.weightKg;
      if (dto.bloodTypeCode !== undefined) data.bloodTypeCode = dto.bloodTypeCode;
      if (dto.eyesight !== undefined) data.eyesight = dto.eyesight;
      if (dto.medicalNotes !== undefined) {
        data.medicalNotes = dto.medicalNotes as unknown as Prisma.InputJsonValue;
      }
      if (dto.hasVehicle !== undefined) data.hasVehicle = dto.hasVehicle;
      if (dto.vehicleType !== undefined) data.vehicleType = dto.vehicleType;
      if (dto.exerciseFrequencyCode !== undefined)
        data.exerciseFrequencyCode = dto.exerciseFrequencyCode;
      if (dto.exerciseSportCode !== undefined) data.exerciseSportCode = dto.exerciseSportCode;
      if (dto.exerciseMethods !== undefined) data.exerciseMethods = dto.exerciseMethods;
      if (dto.firstAidKnowledgeCode !== undefined)
        data.firstAidKnowledgeCode = dto.firstAidKnowledgeCode;
      if (dto.firstAidSkills !== undefined) data.firstAidSkills = dto.firstAidSkills;
      if (dto.otherSkills !== undefined) data.otherSkills = dto.otherSkills;
      if (dto.joinedDate !== undefined) data.joinedDate = normalizeDateOnly(dto.joinedDate);
      if (dto.joinSourceCode !== undefined) data.joinSourceCode = dto.joinSourceCode;
      if (dto.noCriminalRecordSigned !== undefined)
        data.noCriminalRecordSigned = dto.noCriminalRecordSigned;
      if (dto.privacyConsentSigned !== undefined)
        data.privacyConsentSigned = dto.privacyConsentSigned;
      if (dto.privacyConsentSignedAt !== undefined) {
        data.privacyConsentSignedAt = normalizeDateOnly(dto.privacyConsentSignedAt);
      }
      if (dto.volunteerNo !== undefined) data.volunteerNo = dto.volunteerNo;

      const updated = await tx.memberProfile.update({
        where: { id: profile.id },
        data,
        select: memberProfileSafeSelect,
      });
      return presentMemberProfile(updated as MemberProfileResponseDto, masked);
    });
  }
}
