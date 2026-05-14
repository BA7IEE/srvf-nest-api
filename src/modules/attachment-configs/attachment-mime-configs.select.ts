import { Prisma } from '@prisma/client';

// V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig select 集中定义。
//
// 沿 D7 v1.0 §4.3 + PR #3 attachment-type-configs.select 范式:
// - 永不选 deletedAt(Q2 v1.0 拍板:外部不感知软删字段;查询通过 notDeletedWhere 过滤,
//   findById 软删后统一返 13022,沿 v1 §10 信息泄漏防御)
// - 嵌套 typeConfig 摘要(Q2 v1.0 拍板:list / response 含 typeConfig: { id, code, displayName };
//   后台 UI 需要展示类型归属)
// - 必须与 AttachmentMimeConfigResponseDto 同步维护(新增 / 删除字段时同步两边)
export const attachmentMimeConfigSelect = {
  id: true,
  typeConfigId: true,
  mime: true,
  status: true,
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
} as const satisfies Prisma.AttachmentMimeConfigSelect;
