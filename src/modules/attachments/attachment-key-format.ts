// F2(全仓 review #399):派生 attachment key 格式校验。
//
// 模式 A(`POST /api/admin/v1/attachments` → create())此前直收客户端 raw key
// (`CreateAttachmentDto.key`,仅 `@MaxLength(256)`)并 `resolveAccessUrl(key)` 签 URL
// → IDOR:持 upload 权者可对**命名空间外任意 COS 对象**签发 signed URL。
//
// 本校验把 key 绑定到「attachment 命名空间 + 当前 envPrefix + 服务端派生格式」,关闭
// "任意路径"攻击面。残余(命名空间内、且已知其完整随机段的 key)= owner-绑定,留 P3
// (模式 A 弃用 / 全量改走模式 B upload-url + HMAC uploadToken)。
//
// **格式必须与 `attachments.service.ts` 的 `generateAttachmentKey` 产物一致**(改一处须同步;
// `attachment-key-format.spec.ts` + e2e 正例守一致性):
//   attachments/<envPrefix>/<yyyy>/<mm>/<dd>/<base64url(≥16)><.ext(小写 alnum)>
// - envPrefix:管理员可配(charset 不定)→ 正则前转义,且必须**精确等于**当前活动 envPrefix;
// - 随机段:`randomBytes(12).toString('base64url')`(16 字符;charset [A-Za-z0-9_-]);宽容到 ≥16;
// - 扩展名:`mimeToExt` 产物,均小写 alnum(jpg/png/webp/gif/heic/heif/svg/pdf/txt/bin)。
//
// 锚定 `^...$` + 随机段不含 `/`/`.` → 同时挡路径穿越(`../`)与命名空间逃逸。

const KEY_FORMAT_TAIL = String.raw`/\d{4}/\d{2}/\d{2}/[A-Za-z0-9_-]{16,}\.[a-z0-9]+$`;

export function buildDerivedAttachmentKeyRegex(envPrefix: string): RegExp {
  const escaped = envPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^attachments/${escaped}${KEY_FORMAT_TAIL}`);
}

export function isDerivedAttachmentKey(key: string, envPrefix: string): boolean {
  return buildDerivedAttachmentKeyRegex(envPrefix).test(key);
}
