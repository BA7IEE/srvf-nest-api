### Added

- **队员视觉身份资产终态升级 —— sharp 地基 + 可信 facade(issue #1055 T2)**。
  本刀仍**零 HTTP 端点**:把 T3(App 账号头像)/ T4(Admin 队员标准照)要踩的地基铺好并证明可用。
  - **`AttachmentImageNormalizer`(sharp 0.35.3 / libvips 8.18.3)**:解码 → 多帧拒收 →
    EXIF 方向修正 → 只缩不放 → 宽高比判定 → 居中裁 → **白底压平** → JPEG 重编码 →
    **回读复核元数据已清空**。补齐 issue §6.2 要求而签名表证明不了的那部分。
  - **`AttachmentVisualIdentityUploadService`**:`user-avatar` / `member-official-portrait`
    两个 internal-only owner 的唯一入口。四阶段 branded 句柄,与
    `registration-upload-session` 同构:事务外校验+规范化 → 锁内备 intent →
    **事务外** Provider put+HEAD → 锁内原子落库。句柄一次性,顺序错 / 重放 / 跨阶段都拿不到 state。
  - 5 个 BizCode(13035–13039)。**刻意不复用 13016** —— 那条只核 12 字节签名
    (「像不像 JPEG」),这五条要求真解码出一张图。一码多义正是 13033 当初被从 13012 切出来的原因。
  - 两套图片规格各只有一处定义:`uniform-portrait-v1`(goal §2 T4 冻结:5:7 ±1% ·
    826×1158 · 最低同尺寸 · JPEG q90 · 纯白底)与 `account-avatar-v1`(512×512 · q85 ·
    短边 ≥512;**这组数不在 goal 冻结范围内**,按 App 展示位推得,维护者 2026-08-20 确认)。

### 一条对安全有实义的性质

**落库的不是用户上传的字节,而是服务端规范化产出的那份。** 客户端声明的 mime / size
只用来闸控入口,不进 storage identity。于是:落库 mime 恒 `image/jpeg`、体积是重编码后的体积、
**EXIF/GPS 一定不在**。一张队员在家自拍的头像,原图 EXIF 会精确到门牌号 ——
这条链上任何一环忘了清,那个坐标就跟着照片进了队员档案。

清除**不靠** sharp 的默认行为兜底:normalizer 在返回前重新读一次输出的 metadata 并断言
exif/icc/xmp 确已消失,结果作为 `metadataStripped` 返回;facade 见到 false 直接整条链失败,
不静默放行。

### Changed

- `attachment-upload.service.ts` 的 `lockActiveUploadOwner` 登记两个新 owner
  (`user-avatar:User` / `member-official-portrait:Member`),finalize 时对 owner 行
  `FOR UPDATE` 并断言未软删。
  ⚠️ 这是仓内**第二份**「新增 owner type 必须同步」的手写清单,且**没有任何编译期约束**:
  漏登时前三个阶段全部正常,只在 finalize 失败,错误信息还说「owner 不存在」(owner 明明存在)。
  本刀是被它咬了一次才发现的 —— 已写进 `src/modules/attachments/CLAUDE.md` 的踩雷区。
- **Dockerfile 裁掉 17.8 MB 永远加载不了的 glibc 版 sharp 二进制**。镜像基于 alpine(musl),
  而 pnpm 在 `--ignore-scripts` 下会把两种 libc 的预编译包一并装进来。
  容器内实测:`@img` 35.8 M → **18.0 M**。

### 验证

- 图片层 14 条单测 + **6 类变异全部被抓**(去掉方向换轴 / 去掉白底压平 / 去掉多帧闸 /
  放宽比例容差 / `centre→attention` / `centre→entropy`)。
  ⚠️ 「确定性」那条用例的第一版是**假绿**:用纯色图只能证明「不随机」,证明不了「裁在哪」。
  改成三色带图后 `attention` 会混进 101376 个红像素,判据才咬得住。
- fail-closed 负面用例 16 条(7 个通用面 × 2 owner + 2 条反向对照);
  把两个 owner 从 internal-only 名单移除后 **15/16 变红**,唯一保持绿的正是反向对照。
- facade Storage E2E 5 条(真 DB + 真 Provider,四阶段逐段驱动)。
- **正式镜像内实跑**:裁剪后的生产镜像里,用**应用自身的编译产物**规范化出 826×1158 JPEG、
  `metadataStripped=true`,拒收闸(13037)也照常工作。
