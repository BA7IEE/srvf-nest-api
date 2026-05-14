import { Prisma } from '@prisma/client';

// V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig select 集中定义。
//
// 沿 D7 v1.0 §4.4 + PR #3 / PR #4 select 范式:
// - 永不选 deletedAt(Q2 PR #3/#4 v1.0:外部不感知软删字段;查询通过 notDeletedWhere 过滤,
//   findById 软删后统一返 13026,沿 v1 §10 信息泄漏防御)
// - 嵌套 typeConfig 摘要(Q4 v1.0 拍板:新建独立 AttachmentSizeLimitConfigTypeConfigSummaryDto,
//   不复用 mime 的 summary DTO;避免跨表 DTO 耦合)
// - **本表无 status 字段**(沿 D7 v1.0 §4.4 schema 现状;Q1 v1.0:不加 status)
// - 必须与 AttachmentSizeLimitConfigResponseDto 同步维护
export const attachmentSizeLimitConfigSelect = {
  id: true,
  typeConfigId: true,
  maxSizeBytes: true,
  remark: true,
  createdAt: true,
  updatedAt: true,
  typeConfig: {
    select: {
      id: true,
      code: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.AttachmentSizeLimitConfigSelect;
