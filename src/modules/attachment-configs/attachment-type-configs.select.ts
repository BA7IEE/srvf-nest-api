import { Prisma } from '@prisma/client';

// V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig select 集中定义。
//
// 沿 D7 v1.0 §4.2 + dictionaries / RbacRole 范式:
// - 永不选 deletedAt(Q2 v1.0 拍板:外部不感知软删字段;查询通过 notDeletedWhere 过滤,
//   findById 软删后统一返 13020,沿 v1 §10 信息泄漏防御)
// - 必须与 AttachmentTypeConfigResponseDto 同步维护(新增 / 删除字段时同步两边)
export const attachmentTypeConfigSelect = {
  id: true,
  code: true,
  displayName: true,
  description: true,
  ownerTable: true,
  defaultMaxSizeBytes: true,
  defaultMimeWhitelist: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AttachmentTypeConfigSelect;
