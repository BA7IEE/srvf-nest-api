# attachments — 文件与内部 owner 边界

配置三表归 attachment-configs，保留 override-with-default 和独立读点，不合并或另抽配置 facade。
规格见 `docs/attachment-config-boundary.md`；provider 归 storage。不顺手大拆 attachments.service。

- AttachmentContentValidator 是对象/buffer 内容校验唯一入口，复用 attachment-validation 黑名单
  和 attachment-signature。对象链核对存在、实际大小、黑名单及最多12字节魔数；
  buffer 链同样覆盖证件照/签名/证书/OCR裁剪和转发。JPG/PNG/WEBP/GIF/PDF 不符13016，
  黑名单13033，表外 Office MIME 维持契约；不信 COS Content-Type，不把 readObjectPrefix 当全量下载。
- 所有写路径经过校验与 attachment-audit-recorder。key 唯一，访问先检查 expireAt，
  expireAt<=now 不签发 URL，公开 content 列表也过滤过期附件。
- 注册表新 owner 必须同时核对 INTERNAL_ONLY_ATTACHMENT_OWNER_TYPES 与 lockActiveUploadOwner switch，
  后者漏项可能只在 finalize 以“owner不存在”报错，编译检查不够。
- certificate owner scope 一次 collect IDs/findMany/Map，不能退化为逐行查询；
  list/listByOwner 的 ownership 全量过滤后内存分页是当前接受的边界，不顺手重构。

## 内部上传

四阶段统一边界：事务外校验/规范化与 key → 调用方锁内复核/prepare intent →
事务外 provider put+HEAD → 第二次锁内原子 Attachment+AVAILABLE ledger+attachment.upload audit。
只接受 branded 句柄，阶段间不可复用；不让通用接口绕过调用方领域不变量。

- registration-upload-session 使用 attachment_legacy，固定 JPEG/PNG/WebP/PDF、10MiB。
  完成上传仅保持 active；canonical command 同事务复核 activity/member/Form/session/AVAILABLE/唯一附件，
  先建不可变 RegistrationFormAnswer，再转为 registration-form-answer owner、绑定 attachmentId、
  session consumed。失败整体回滚，不留半转绑/已 consumed。
- user-avatar/member-official-portrait 只走 AttachmentVisualIdentityUploadService。
  落库服务端规范化 JPEG，不是原始上传字节；入口声明 MIME/size 仅作闸控。
  AttachmentImageNormalizer 负责解码、多帧拒收、EXIF方向、只缩不放、宽高比/像素上限、
  白底压平并回读确认元数据清空。规格常量单一来源；改标准照用新 uniform-portrait-v2，
  不修改 v1 数值或绕过 DB spec_version 约束。
- 视觉身份两个 owner 的通用 create/list/detail/update/delete/upload-url/confirm 一律
  ATTACHMENT_NOT_FOUND，不以“类型非法”泄露存在性。
  registration-upload-session/form-answer 同样拒绝通用 Admin 路径，列表不泄露 total，
  不签 URL，不暴露 key/owner/tokenHash/locator。

## 读取例外

默认不返回完整 signed URL 或其他 L3 字段。唯一既定内容例外：
content-image/content-file 可在 open/app contents 读面返回短 TTL accessUrl，
但必须先通过文章对应可见级（公开还须 published+public）。
这不扩展到 member/certificate/activity；内容写路径仍检查 attachment 粗粒度权限。
历史 GET /me/uploaded 已删除，listMyUploaded 只是未来 App building block，不自行恢复端点。

改内部 owner 跑对应 generic-api-fail-closed 和上传阶段测试；
改签名/过期/读取范围覆盖 content validator、对象确认与对应 owner 的越权用例。
