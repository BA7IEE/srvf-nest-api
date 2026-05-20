import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-7 App /api/app/v1/my/certificates 列表项出参。
// 沿 docs/app-api-p2-7-my-certificates-review.md §5.1 v0.1 字段集**恰好 12 项**;
// §5.2 默认锁定**不返回** memberId / verifiedBy / verifier / supersededByCertId /
// supersededBy / replacedCertificates / updatedAt / deletedAt / expireNotifyDueAt。
//
// **严禁**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
// admin `CertificateResponseDto` / `CertificateListItemDto`(沿 D-P2-7-3 + Phase 0.6 §1.3
// + Phase 0.7 §2.2)。物理隔离于 src/modules/certificates/dto/app/。
//
// 字段语义:
// - `certNumber`:L1 对本人完整可见(沿 §5.1 第 5 行 + Phase 0.6 §2.4 / §5.4)
// - `verifyNote`:L1 对本人可见(沿 §5.1 第 10 行 + D-P2-7-5 命名沿 admin;前端可显示为
//   "拒绝原因 / 审核备注";**不**改名 `rejectionReason`)
// - `verifiedAt`:L1 对本人可见(沿 §5.1 第 11 行 + 与 verifyNote 同等级)
// - `certStatusCode`:**只返**持久态(沿 D-P2-7-6;**不**在 service 内根据 expiredAt < now()
//   实时映射 `expired`,过期推进由后台任务 / 管理流程维护,避免双权威源漂移)
// - `expiredAt`:NULL = 终身有效(沿 Prisma schema CT-7 Q-S4)
//
// 绝对禁止返回(沿 §5.3 snapshot 触发即拒合并):
// - L3 凭据:passwordHash / refreshToken / tokenHash / accessToken
// - 任何 audit context:requestId / ip / ua / actorUserId / actorRoleSnap
// - 任何 verifier Member 字段(verifier.realName / documentNumber / mobile / memberNo 等)
// - 任何 Member.* L2 字段(mobile / documentNumber / medicalNotes / bloodTypeCode)
// - supersededBy 关联 row 完整字段集
//
// 明确不返(沿 §5.2 默认锁定):
// - memberId(AppSelf scope 下所有 row 都属 currentUser,本人已知 via /me/account.linkedMemberId)
// - verifiedBy / verifier:避免泄露审核人身份(沿 Phase 0.6 §6.5;审核人是另一名 Member,L2 跨 member 信息)
// - supersededByCertId / supersededBy / replacedCertificates:替代关系链路 App 侧不暴露(沿 Phase 0.6 §6.5)
// - updatedAt:admin housekeeping(沿 §5.2)
// - deletedAt:软删 row 已被 where 过滤,不暴露
// - expireNotifyDueAt:后台任务字段(沿 Prisma schema HK-1)
export class AppMyCertificateDto {
  @ApiProperty({ description: '证书主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '证书大类字典 code(cert_type)', example: 'first_aid' })
  certTypeCode!: string;

  @ApiPropertyOptional({
    description: '证书子类型 / 等级字典 code(cert_sub_type;NULL 表示无子类型)',
    nullable: true,
  })
  certSubTypeCode!: string | null;

  @ApiProperty({ description: '颁发机构(自由文本)', example: '深圳市红十字会' })
  issuingOrg!: string;

  @ApiPropertyOptional({
    description: '证书编号(中敏感;本人完整可见)',
    nullable: true,
  })
  certNumber!: string | null;

  @ApiProperty({ description: '颁发日期(ISO 8601)' })
  issuedAt!: Date;

  @ApiPropertyOptional({
    description: '到期日(ISO 8601;NULL = 终身有效)',
    nullable: true,
  })
  expiredAt!: Date | null;

  @ApiProperty({
    description:
      '核验状态字典 code(cert_status;4 态闭集 pending / verified / expired / rejected;只返持久态,不做 expiredAt<now() 实时映射)',
    example: 'verified',
  })
  certStatusCode!: string;

  @ApiProperty({ description: '是否本会颁发' })
  isInternal!: boolean;

  @ApiPropertyOptional({
    description: '审核备注 / 拒绝原因(L1 对本人可见;字段名沿 Prisma schema)',
    nullable: true,
  })
  verifyNote!: string | null;

  @ApiPropertyOptional({
    description: '核验时间(L1 对本人可见;待核验态为 NULL)',
    nullable: true,
  })
  verifiedAt!: Date | null;

  @ApiProperty({ description: '创建时间(排序参考)' })
  createdAt!: Date;
}
