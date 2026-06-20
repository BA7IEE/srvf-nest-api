// F2(#399)e2e helper:生成符合服务端派生格式的合规 attachment key。
//
// create()(模式 A)自 F2 起校验 `dto.key` 必须匹配
//   attachments/<envPrefix>/<yyyy>/<mm>/<dd>/<base64url(≥16)><.ext>
// (见 src/modules/attachments/attachment-key-format.ts;与 generateAttachmentKey 同源)。
// e2e cfg.env='test' 且不 seed storageSettings → envPrefix 落 'test'。
//
// 计数器(非 RNG)保证跨调用唯一(key @unique),且确定性、无 flaky。
let attachmentKeySeq = 0;

export function conformingAttachmentKey(envPrefix = 'test'): string {
  attachmentKeySeq += 1;
  // 'key' + 13 位序号 = 16 字符,全部 base64url 合法字符。
  const random = `key${String(attachmentKeySeq).padStart(13, '0')}`;
  return `attachments/${envPrefix}/2026/05/15/${random}.bin`;
}
