### Added

- **App 账号头像闭环(issue #1055 T3)**:三个端点 `GET / POST / DELETE /api/app/v1/me/avatar`,
  准入 `LoginScoped{admission: app-member, scopes: [self]}`,**不要任何 `attachment.upload.*` 通用权限码**
  —— 那是给通用附件面用的,而 `user-avatar` 恰恰在通用面上恒 fail-closed(T2 已装)。
  - 上传走 **multipart 直传服务端**:服务端解码 → 修正 EXIF 方向 → 居中裁成正方形 →
    512×512 → **清除 EXIF/GPS** → JPEG q85 → 落 `user-avatar` Attachment → 指针写入
    `User.avatarAttachmentId`,旧头像 durable delete。
  - 清空幂等;**幂等空转不写审计**(沿 `wecom.clear.by-admin` 既有口径 —— 什么都没变还记一笔,
    审计流水会被空转淹没)。
  - 读取返 `AccountAvatarDto { attachmentId, accessUrl, expiresAt }`,**不再返 raw storage key**。

### 为什么是三个端点而不是 issue §7.1 写的四个

维护者 2026-08-20 拍板。§7.1 描述的是「客户端拿签名 URL 直传 storage,confirm 时服务端校验
规范化结果」—— 但**服务端要规范化就必须看见字节**。直传形状下服务端只能在 confirm 时把字节
拉回来、规范化、再传一次:双倍传输,而且**未规范化的原图(带 EXIF/GPS)会先落进 storage
并停留一段时间** —— 正是整套视觉身份设计要防的那个泄露。

10 MB 以内的头像,省下的那点带宽换不来这个代价。形状取 multipart,与仓内既有的
`registration-upload-session` 可信 facade 逐字同形。upload-url 与 confirm-upload 合成一次 POST。

### Changed

- `AccountAvatarDto` 取代 raw key。旧契约把 `User.avatarKey`(一个裸 storage key)直接吐给客户端,
  于是任何拿到它的人都掌握了一个**永不过期、与鉴权无关**的对象引用。现在给的是短 TTL 签名 URL;
  客户端要长期引用就存 `attachmentId`,每次显示时重新取。
- `PATCH /api/app/v1/me/profile` 的白名单从 `{nickname, avatarKey}` 收窄为 `{nickname}`。
- 可信 facade 补两个受控出口(签名 URL / durable delete),users 模块因此**只依赖一个面** ——
  `AttachmentAccessService` 与 `AttachmentStorageOrchestrator` 都没有导出,拿不到它们正是
  internal-only 边界的一部分。
- 路由足迹计数收成单一常量 `EXPECTED_ROUTE_COUNT`,用例标题改插值。
  动它之前标题写着「精确为 532」而断言是 537 —— **有人 bump 了数字没 bump 标题,标题从此说谎**。

<!-- contract-breaking
operation: GET /api/app/v1/me
reason: 响应删除 avatarKey。它是裸 storage key,给出去等于发放一个永不过期、与鉴权无关的对象引用;头像改由 GET /api/app/v1/me/avatar 提供短 TTL 签名 URL。
impact: 依赖 data.avatarKey 的调用方会拿到 undefined。srvf-admin-web 与小程序当前均未投用该字段(维护者 2026-08-20 确认前端尚未真正用起来),故不做兼容层。
migration: 重新 codegen(docs/handoff/clients/** 已随本 PR 更新),头像显示改调 GET /api/app/v1/me/avatar 取 accessUrl;需长期引用则保存 attachmentId 而不是 URL。
rollback: 真回滚为 revert 本 PR —— 恢复 AppMeResponseDto.avatarKey 字段与其映射。changelog 文件本身不是回滚手段。
-->

<!-- contract-breaking
operation: GET /api/app/v1/me/profile
reason: 同上,响应删除 avatarKey;profile 面不再承载任何头像字段,头像自成一条端点。
impact: 依赖 data.avatarKey 的调用方会拿到 undefined;profile 的其余字段逐字不变。
migration: 重新 codegen 后,profile 页的头像改调 GET /api/app/v1/me/avatar。
rollback: 真回滚为 revert 本 PR —— 恢复 AppSelfProfileDto.avatarKey 与 app-profile.service 的映射。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/me/profile
reason: 请求白名单收窄为 {nickname},响应同步删除 avatarKey。客户端塞一个 storage key 进来就能改头像,这条路径无法证明该对象存在、属于本人、是图片、尺寸合规 —— 头像因此改走 multipart + 服务端规范化。
impact: 请求体里带 avatarKey 会被 ValidationPipe 以 400 拒绝(此前会被接受并写库);响应不再含 avatarKey。
migration: 前端把「改头像」从 PATCH /me/profile 拆出来,改调 POST /api/app/v1/me/avatar(multipart,字段名 file);只改昵称的调用无需变更。
rollback: 真回滚为 revert 本 PR —— 恢复 UpdateAppSelfProfileDto.avatarKey 与 AppSelfProfileDto.avatarKey。
-->

### 验证

- 12 条 e2e:上传 / 替换 / 清空 / 幂等 / 审计 extra 闭集 / 读取 / 四条拒收面 / §7.2 契约收窄
- **EXIF+GPS 那条先钉前提**:断言来图确实带 GPS(0x8825 是 TIFF 的 GPS IFD 指针标签),
  否则「清干净了」可能只是因为它本来就没有
- 替换那条配了**反向对照**:旧附件必须没了、**新附件必须还在** ——
  少了后半句,一个「把两张都删了」的实现也会全绿

### 交付中被咬到的一处

`prepareDelete` **只落删除意图**,返回一个 eventKey;真正的 Provider 调用与 Attachment 行删除
在 `executeEventKey` 里原子完成。第一版 facade 只调了前半截,现象是**替换成功、指针也对,
只有旧行永远不走** —— 表面上一切正常。通用删除端点(`attachment-write.service.ts:362-367`)
本来就是这对调用配对出现的,照抄它即可。e2e 的「旧附件被清理」那条把它抓了出来。
