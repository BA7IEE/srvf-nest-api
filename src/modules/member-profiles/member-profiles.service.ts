import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
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
// - audit:findOne / update 调 A2 / A3-占位 hook;create 是首次写入,不打 read.other

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
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // Slow-4 T2(2026-06-11,评审稿 §3.2 / D-S4-8):RBAC 判权(沿 P0-F assertCanOrThrow 范式)。
  // 每个 public 方法第一条语句调用——先判权后查资源,保持与原 Guard 前置语义一致。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
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

  // 把 ISO 8601 字符串规范化为 UTC 00:00:00.000(纯日期语义,B 路径)。
  // 草案 §6 决议:不落 @db.Date,业务层统一规范化处理。
  private normalizeDateOnly(input: string): Date {
    const d = new Date(input);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
  ): Promise<MemberProfileResponseDto | null> {
    await this.assertCanOrThrow(currentUser, 'member-profile.read.record');
    await this.findMemberOrThrow(memberId);

    auditPlaceholder('profile.read.other', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
    });

    const profile = await this.prisma.memberProfile.findFirst({
      where: notDeletedWhere({ memberId }),
      select: memberProfileSafeSelect,
    });
    return profile as MemberProfileResponseDto | null;
  }

  // ============ create ============

  // 批次 1 不打 A3 update.self / A4 update.review hook(无 USER 自助接口、不实现审批流)。
  // Slow-4 T2:currentUser 仅用于 rbac 判权,不改 audit 行为。
  async create(
    memberId: string,
    dto: CreateMemberProfileDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member-profile.create.record');
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
        birthDate: this.normalizeDateOnly(dto.birthDate),
        documentTypeCode: dto.documentTypeCode,
        documentNumber: dto.documentNumber,
        mobile: dto.mobile,
        email: dto.email,
        joinedDate: this.normalizeDateOnly(dto.joinedDate),
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
        data.privacyConsentSignedAt = this.normalizeDateOnly(dto.privacyConsentSignedAt);
      }

      return this.runWithUniqueConstraintGuard(() =>
        tx.memberProfile.create({
          data,
          select: memberProfileSafeSelect,
        }),
      ) as Promise<MemberProfileResponseDto>;
    });
  }

  // ============ update ============

  async update(
    memberId: string,
    dto: UpdateMemberProfileDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member-profile.update.record');
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
      if (dto.birthDate !== undefined) data.birthDate = this.normalizeDateOnly(dto.birthDate);
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
      if (dto.joinedDate !== undefined) data.joinedDate = this.normalizeDateOnly(dto.joinedDate);
      if (dto.joinSourceCode !== undefined) data.joinSourceCode = dto.joinSourceCode;
      if (dto.noCriminalRecordSigned !== undefined)
        data.noCriminalRecordSigned = dto.noCriminalRecordSigned;
      if (dto.privacyConsentSigned !== undefined)
        data.privacyConsentSigned = dto.privacyConsentSigned;
      if (dto.privacyConsentSignedAt !== undefined) {
        data.privacyConsentSignedAt = this.normalizeDateOnly(dto.privacyConsentSignedAt);
      }
      if (dto.volunteerNo !== undefined) data.volunteerNo = dto.volunteerNo;

      const updated = await tx.memberProfile.update({
        where: { id: profile.id },
        data,
        select: memberProfileSafeSelect,
      });
      return updated as MemberProfileResponseDto;
    });
  }
}
