import { Prisma } from '@prisma/client';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):Attachment select 集中定义。
//
// 沿 D7-attachments v1.0 §5.4.4 + PR #3-#5 范式:
// - 主表硬删除(无 deletedAt;沿 D6 Q5 B);因此本 select 不涉及 deletedAt 过滤
// - **不选 checksum / etag**(Q6 v1.0 拍板:内部字段,不进普通出参 DTO;
//   后续 admin / debug 专属接口若需可见,另起 select)
// - accessUrl 是 Service 层 toResponseDto 时附加的占位字段(Provider 接通前恒返 null;
//   沿 D7 v1.0 §5.5),**不是** DB 字段,因此本 select 不包含
// - **必须与 AttachmentResponseDto 同步维护**(沿 v1 §11)
export const attachmentSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  key: true,
  originalName: true,
  mime: true,
  size: true,
  uploadedBy: true,
  uploadedAt: true,
  ownerType: true,
  ownerId: true,
  description: true,
  accessLevel: true,
  tags: true,
  originalUploaderName: true,
  expireAt: true,
} as const satisfies Prisma.AttachmentSelect;
