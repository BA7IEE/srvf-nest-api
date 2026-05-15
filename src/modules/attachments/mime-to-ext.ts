// V2.x C-7.5 Provider 选型实施 PR #10:MIME 类型 → 文件扩展名映射(沿 §6.4.2 + Q-10-4 拍板 A)
//
// 用途:upload-url 生成 key 时按 MIME 推断 ext;`attachments/<env>/<yyyy>/<mm>/<dd>/<random>.<ext>`
// 不从 originalName 推断 ext(沿 Q-10-4 + 防 PII 风险扩散到 Provider key)。
// 未命中表 → fallback `.bin`(沿 Q-10-4)。
//
// 覆盖范围:沿 D7-attachments §6.1 启用场景 1-4(队员证件 + 证书 + 活动现场照 + 活动封面)
// 典型 MIME:
// - 图片:image/jpeg / image/png / image/webp / image/gif / image/heic
// - 文档:application/pdf
// - 文本:text/plain
// 其他 MIME 走 fallback;实际可上传与否由 attachment_mime_configs 控制(沿 D7 §6.6)

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  // images
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  // docs
  'application/pdf': '.pdf',
  // text
  'text/plain': '.txt',
};

export function mimeToExt(mime: string): string {
  const lower = mime.toLowerCase();
  return MIME_TO_EXT[lower] ?? '.bin';
}
