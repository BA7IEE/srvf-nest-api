import { Injectable } from '@nestjs/common';
import { AttachmentAccessLevel, MembershipType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import type { ResolvedResource, ResourceRef, ResourceSensitivityLevel } from './authz.types';

// 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.1):ResourceResolver(资源归属解析)。
//
// 职责:按 resourceType 分发,把业务资源解析成统一的 ResolvedResource(归属组织 / 祖先链 / 属主 /
// 活动 / 状态 / 敏感级)。**只读现有列,无新外键**;不判权(判权在 AuthzService)。
//
// fail-close 红线(§5.1 表末):资源不存在 / 已软删 / 未知 resourceType / attachment 委派链断裂
// → 返 null → 授权侧 deny(resource_not_found)。防枚举(他人资源统一 404)由业务消费者沿仓内惯例处理。
//
// 逐类口径(§5.1 逐资源解析表):
// - organization:          org = 自身;status = organization.status
// - activity:              org = activity.organizationId;activityId = 自身
// - activity_publish_review:org 经 activity;extra = {requestType,submittedByUserId,directPublish}
// - attendance_sheet:      org 经 activity;extra = {submitterUserId,lastSubmittedByUserId,reviewerUserId}
//                          (自审 / 同人复核约束用)
// - attendance_record:     org 经 sheet→activity;owner = record.memberId
// - activity_registration: org 经 activity;owner = reg.memberId
// - member:                org = 该 member 的 active PRIMARY membership(可 null);ownerUserId = member.user?.id
// - member_profile:        org 经 member(PRIMARY membership);sensitivityLevel='sensitive'(PII)
// - certificate:           org 经 member(同上);owner = cert.memberId
// - team_join_application: org = selectedOrganizationId ?? null(候选在 extra.targetOrganizationIds)
// - recruitment_application: org=null / owner=null(D-R-1 报名行无 Member FK;仅 GLOBAL / 中央绑定可达);sensitive
// - notification:          directed → org 经 recipientMemberId 的 PRIMARY membership,owner=recipientMemberId;
//                          department 广播 → org=null(可见部门数组进 extra.visibleOrganizationIds;
//                          「任一覆盖即可」的多组织 covers 属消费面迁移〔PR12 通知面〕时扩展,本刀 fail-close 收窄为仅 GLOBAL)
// - attachment:            按 ownerType 委派 member / certificate / activity 对应 resolver(ownerId);
//                          organizationId / ownerMemberId / activityId 取被委派资源;sensitivityLevel ← attachment.accessLevel;
//                          其余 ownerType(content-image / content-file 等 CMS 码族)本刀不映射 → null(fail-close;
//                          content 面到 PR12 迁移时再决定其归属语义)
//
// 链上父资源(activity / sheet / member)自身软删**不**阻断解析:存在性只看目标资源的 deletedAt,
// 归属字段照读(资源仍真实存在,其组织归属是事实属性);scope org 的 ACTIVE/软删闸门在 AuthzService.covers()。

const SENSITIVITY_BY_ACCESS_LEVEL: Record<AttachmentAccessLevel, ResourceSensitivityLevel> = {
  [AttachmentAccessLevel.PUBLIC]: 'public',
  [AttachmentAccessLevel.INTERNAL]: 'internal',
  [AttachmentAccessLevel.SENSITIVE]: 'sensitive',
};

@Injectable()
export class ResourceResolverService {
  constructor(private readonly prisma: PrismaService) {}

  // 统一入口:未知类型 → null(fail-close)。
  async resolve(ref: ResourceRef): Promise<ResolvedResource | null> {
    switch (ref.type) {
      case 'organization':
        return this.resolveOrganization(ref.id);
      case 'activity':
        return this.resolveActivity(ref.id);
      case 'activity_publish_review':
        return this.resolveActivityPublishReview(ref.id);
      case 'attendance_sheet':
        return this.resolveAttendanceSheet(ref.id);
      case 'attendance_record':
        return this.resolveAttendanceRecord(ref.id);
      case 'activity_registration':
        return this.resolveActivityRegistration(ref.id);
      case 'member':
        return this.resolveMember(ref.id);
      case 'member_profile':
        return this.resolveMemberProfile(ref.id);
      case 'certificate':
        return this.resolveCertificate(ref.id);
      case 'team_join_application':
        return this.resolveTeamJoinApplication(ref.id);
      case 'recruitment_application':
        return this.resolveRecruitmentApplication(ref.id);
      case 'notification':
        return this.resolveNotification(ref.id);
      case 'attachment':
        return this.resolveAttachment(ref.id);
      default:
        return null;
    }
  }

  // ============ 逐类 resolver ============

  private async resolveOrganization(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!row) return null;
    return {
      resourceType: 'organization',
      resourceId: row.id,
      organizationId: row.id,
      organizationPath: await this.organizationPath(row.id),
      ownerMemberId: null,
      ownerUserId: null,
      activityId: null,
      statusCode: row.status,
      sensitivityLevel: null,
    };
  }

  private async resolveActivity(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.activity.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, organizationId: true, statusCode: true },
    });
    if (!row) return null;
    return {
      resourceType: 'activity',
      resourceId: row.id,
      organizationId: row.organizationId,
      organizationPath: await this.organizationPath(row.organizationId),
      ownerMemberId: null,
      ownerUserId: null,
      activityId: row.id,
      statusCode: row.statusCode,
      sensitivityLevel: null,
    };
  }

  private async resolveActivityPublishReview(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.activityPublishReview.findUnique({
      where: { id },
      select: {
        id: true,
        activityId: true,
        requestType: true,
        status: true,
        submittedByUserId: true,
        directPublish: true,
        activity: { select: { organizationId: true } },
      },
    });
    if (!row) return null;
    return {
      resourceType: 'activity_publish_review',
      resourceId: row.id,
      organizationId: row.activity.organizationId,
      organizationPath: await this.organizationPath(row.activity.organizationId),
      ownerMemberId: null,
      ownerUserId: null,
      activityId: row.activityId,
      statusCode: row.status,
      sensitivityLevel: null,
      extra: {
        requestType: row.requestType,
        submittedByUserId: row.submittedByUserId,
        directPublish: row.directPublish,
      },
    };
  }

  private async resolveAttendanceSheet(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.attendanceSheet.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        activityId: true,
        statusCode: true,
        submitterUserId: true,
        lastSubmittedByUserId: true,
        reviewerUserId: true,
        activity: { select: { organizationId: true } },
      },
    });
    if (!row) return null;
    return {
      resourceType: 'attendance_sheet',
      resourceId: row.id,
      organizationId: row.activity.organizationId,
      organizationPath: await this.organizationPath(row.activity.organizationId),
      ownerMemberId: null,
      ownerUserId: null,
      activityId: row.activityId,
      statusCode: row.statusCode,
      sensitivityLevel: null,
      extra: {
        submitterUserId: row.submitterUserId,
        lastSubmittedByUserId: row.lastSubmittedByUserId,
        reviewerUserId: row.reviewerUserId,
      },
    };
  }

  private async resolveAttendanceRecord(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.attendanceRecord.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        memberId: true,
        attendanceStatusCode: true,
        sheet: { select: { activityId: true, activity: { select: { organizationId: true } } } },
      },
    });
    if (!row) return null;
    return {
      resourceType: 'attendance_record',
      resourceId: row.id,
      organizationId: row.sheet.activity.organizationId,
      organizationPath: await this.organizationPath(row.sheet.activity.organizationId),
      ownerMemberId: row.memberId,
      ownerUserId: null,
      activityId: row.sheet.activityId,
      statusCode: row.attendanceStatusCode,
      sensitivityLevel: null,
    };
  }

  private async resolveActivityRegistration(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.activityRegistration.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        memberId: true,
        statusCode: true,
        activityId: true,
        activity: { select: { organizationId: true } },
      },
    });
    if (!row) return null;
    return {
      resourceType: 'activity_registration',
      resourceId: row.id,
      organizationId: row.activity.organizationId,
      organizationPath: await this.organizationPath(row.activity.organizationId),
      ownerMemberId: row.memberId,
      ownerUserId: null,
      activityId: row.activityId,
      statusCode: row.statusCode,
      sensitivityLevel: null,
    };
  }

  private async resolveMember(id: string): Promise<ResolvedResource | null> {
    // 队员账号闭环 v2:User.memberId 改一对多(partial unique,仅 DB 层保证至多 1 条
    // live),`users` 查询显式收窄 `deletedAt: null` + `take: 1` 取当前 live 关联账号,
    // 与 v1 行为等价(软删账号从不可能是 currentUser,不影响任何 self-scope 判定结果)。
    const row = await this.prisma.member.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        status: true,
        users: { where: { deletedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!row) return null;
    const organizationId = await this.primaryMembershipOrgId(row.id);
    return {
      resourceType: 'member',
      resourceId: row.id,
      organizationId,
      organizationPath: await this.organizationPath(organizationId),
      ownerMemberId: row.id,
      ownerUserId: row.users[0]?.id ?? null,
      activityId: null,
      statusCode: row.status,
      sensitivityLevel: null,
    };
  }

  private async resolveMemberProfile(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.memberProfile.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, memberId: true },
    });
    if (!row) return null;
    const organizationId = await this.primaryMembershipOrgId(row.memberId);
    return {
      resourceType: 'member_profile',
      resourceId: row.id,
      organizationId,
      organizationPath: await this.organizationPath(organizationId),
      ownerMemberId: row.memberId,
      ownerUserId: null,
      activityId: null,
      statusCode: null,
      sensitivityLevel: 'sensitive',
    };
  }

  private async resolveCertificate(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.certificate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, memberId: true, certStatusCode: true },
    });
    if (!row) return null;
    const organizationId = await this.primaryMembershipOrgId(row.memberId);
    return {
      resourceType: 'certificate',
      resourceId: row.id,
      organizationId,
      organizationPath: await this.organizationPath(organizationId),
      ownerMemberId: row.memberId,
      ownerUserId: null,
      activityId: null,
      statusCode: row.certStatusCode,
      sensitivityLevel: null,
    };
  }

  private async resolveTeamJoinApplication(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.teamJoinApplication.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        memberId: true,
        statusCode: true,
        selectedOrganizationId: true,
        targetOrganizationIds: true,
      },
    });
    if (!row) return null;
    const organizationId = row.selectedOrganizationId ?? null;
    return {
      resourceType: 'team_join_application',
      resourceId: row.id,
      organizationId,
      organizationPath: await this.organizationPath(organizationId),
      ownerMemberId: row.memberId,
      ownerUserId: null,
      activityId: null,
      statusCode: row.statusCode,
      sensitivityLevel: null,
      extra: { targetOrganizationIds: row.targetOrganizationIds },
    };
  }

  private async resolveRecruitmentApplication(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.recruitmentApplication.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, statusCode: true },
    });
    if (!row) return null;
    return {
      resourceType: 'recruitment_application',
      resourceId: row.id,
      organizationId: null,
      organizationPath: null,
      ownerMemberId: null,
      ownerUserId: null,
      activityId: null,
      statusCode: row.statusCode,
      sensitivityLevel: 'sensitive',
    };
  }

  private async resolveNotification(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.notification.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        statusCode: true,
        audienceType: true,
        recipientMemberId: true,
        visibleOrganizationIds: true,
      },
    });
    if (!row) return null;
    const organizationId = row.recipientMemberId
      ? await this.primaryMembershipOrgId(row.recipientMemberId)
      : null;
    return {
      resourceType: 'notification',
      resourceId: row.id,
      organizationId,
      organizationPath: await this.organizationPath(organizationId),
      ownerMemberId: row.recipientMemberId,
      ownerUserId: null,
      activityId: null,
      statusCode: row.statusCode,
      sensitivityLevel: null,
      extra: { audienceType: row.audienceType, visibleOrganizationIds: row.visibleOrganizationIds },
    };
  }

  // attachment:按 ownerType 委派(§5.1 表末行)。Attachment 是硬删模型(无 deletedAt),
  // findUnique 不到即不存在;委派目标不存在 / 已软删 / ownerType 未映射 → 整体 null(fail-close)。
  private async resolveAttachment(id: string): Promise<ResolvedResource | null> {
    const row = await this.prisma.attachment.findUnique({
      where: { id },
      select: { id: true, ownerType: true, ownerId: true, accessLevel: true },
    });
    if (!row) return null;

    let delegate: ResolvedResource | null = null;
    if (row.ownerType === 'member') {
      delegate = await this.resolveMember(row.ownerId);
    } else if (row.ownerType === 'certificate') {
      delegate = await this.resolveCertificate(row.ownerId);
    } else if (row.ownerType === 'activity') {
      delegate = await this.resolveActivity(row.ownerId);
    }
    if (!delegate) return null;

    return {
      resourceType: 'attachment',
      resourceId: row.id,
      organizationId: delegate.organizationId,
      organizationPath: delegate.organizationPath,
      ownerMemberId: delegate.ownerMemberId,
      ownerUserId: delegate.ownerUserId,
      activityId: delegate.activityId,
      statusCode: null,
      sensitivityLevel: row.accessLevel ? SENSITIVITY_BY_ACCESS_LEVEL[row.accessLevel] : null,
      extra: { ownerType: row.ownerType, ownerId: row.ownerId },
    };
  }

  // ============ 共享 helpers ============

  // member 的授权归属组织 = active PRIMARY membership(冻结稿 §5.1 member 行;partial unique 保证至多一条)。
  // 无 active PRIMARY 归属 → null(该资源仅 GLOBAL / SELF〔owner 匹配〕可达)。
  private async primaryMembershipOrgId(memberId: string): Promise<string | null> {
    const row = await this.prisma.memberOrganizationMembership.findFirst({
      where: {
        ...MembershipTermStateMachine.effectiveWhere(new Date()),
        memberId,
        membershipType: MembershipType.PRIMARY,
      },
      select: { organizationId: true },
    });
    return row?.organizationId ?? null;
  }

  // 祖先链(closure 反查):root 在前、自身在后(closure 自环行 depth=0,PR1 起恒在)。
  // covers(ORGANIZATION_TREE) 即「scopeOrgId ∈ organizationPath」,与 EXISTS closure(ancestor, descendant) 等价。
  private async organizationPath(organizationId: string | null): Promise<string[] | null> {
    if (!organizationId) return null;
    const rows = await this.prisma.organizationClosure.findMany({
      where: { descendantId: organizationId },
      select: { ancestorId: true },
      orderBy: { depth: 'desc' },
    });
    return rows.map((r) => r.ancestorId);
  }
}
