# recruitment — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);敏感字段三问、App/Open surface 与职责边界分别沿其 §18.4、§19.7/§21 及 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件只记录招新模块内的高风险本地约束。

## 文件入口

- 主证件照、申请人签名图、证书图、OCR 返回的裁剪图，以及无状态 recognize 转发 OCR 的图片，都必须在 OCR 或 storage 写入前经过 attachments 模块导出的 `AttachmentContentValidator.validateFromBuffer()`。
- 继续保留各调用方现有数量、大小和 MIME 白名单;统一 validator 只承接系统黑名单与受支持 MIME 的前 12 字节签名核对。内容与声明不符复用 `ATTACHMENT_CONTENT_TYPE_MISMATCH=13016`,黑名单复用 `ATTACHMENT_SYSTEM_MIME_BLOCKED=13033`。
- 校验失败不得调用付费 OCR、不得写对象、不得写 attachment key;OCR 裁剪图也不能因为来自上游响应而跳过校验。
- 禁止在 recruitment 内复制 MIME 黑名单、文件签名表或魔数判断;新增文件入口必须复用同一 validator。

## 敏感数据与流程

- 证件图、签名图、OCR 字段与裁剪图均按 L3/PII 既有分级处理,不得写日志、audit、fixture 明文或公开响应。
- Admin 敏感读取必须显式传 `AuditMeta` 并 fail-closed 落 `audit_logs`:普通查询完成后审计再返回;CSV 在返回 generator 前审计;证件照/证书图在任何 `generateDownloadUrl` 前审计。extra 只允许 operation、filterFields/maskLevel、字段名与安全计数,绝不写姓名/手机号/身份证号、原始 filter、object key、URL 或自由文本。
- 不因文件校验收口改变既有 OCR 六分流、验证码消费、报名状态机、证书审核状态或留存/清理语义。
- batch promote 在全部读取/排序/skip 分区、bcrypt、VOL 校验成功后且进入业务 transaction 前,按发号序逐条 fail-closed 删除 promotable 的 `idCardCropImageKey`;promote-single 同样紧贴 transaction 前删。skip 行、`idCardPortraitImageKey`/avatar 不删,禁止 `Promise.all`;删除异常统一安全 500 且 transaction 不进入,不得记录 raw key/provider 消息。删除成功后 DB 失败允许 key 暂指向 absent 对象,重试依赖 provider 幂等,不恢复 blob/不加 ledger。
- batch promote 与 promote-single 必须把 `notification.targeted@1` intent 与发号/建档/清敏/audit 放在同一 PostgreSQL transaction；eventKey 绑定 recruitment application id，enqueue 失败必须整个业务回滚。
- 新 mobile/open DTO 不得从 Admin DTO 派生;Open 入口只做已冻结公开契约内的能力,不得顺手扩大 surface。
