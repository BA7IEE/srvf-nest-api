import { randomBytes } from 'crypto';

// F2(#399)e2e helper:生成符合服务端派生格式的合规 attachment key。
//
// create()(模式 A)自 F2 起校验 `dto.key` 必须匹配
//   attachments/<envPrefix>/<yyyy>/<mm>/<dd>/<base64url(≥16)><.ext>
// (见 src/modules/attachments/attachment-key-format.ts;与 generateAttachmentKey 同源)。
// e2e cfg.env='test' 且不 seed storageSettings → envPrefix 落 'test'。
//
// 计数器(非 RNG)保证同一模块实例内跨调用唯一(key @unique),且确定性、无 flaky。
//
// ⚠️ Harness 3.0 P1 并行化:jest 为**每个测试文件**重建模块注册表,计数器会从 0 重来;
// 而 STORAGE_LOCAL_ROOT 只隔离到 worker(tmp/storage-w<N>),整个 run 内不重置。
// 只有计数器 → 同一 worker 内先后跑的两个 spec 文件必然生成同名 key 与同一落盘路径,
// 于是「断言文件不存在」这类反向断言会被上一个 spec 的残留文件翻面(假红/假绿)。
// 因此在计数器之外补一段 per-模块实例的随机前缀:文件内仍确定性递增,跨文件/跨 worker
// 恒不相撞。key 长度与字符集(base64url,≥16)不变,服务端格式校验照旧通过。
const keyNamespace = randomBytes(3).toString('hex'); // 6 字符 [0-9a-f]
let attachmentKeySeq = 0;

export function conformingAttachmentKey(envPrefix = 'test'): string {
  attachmentKeySeq += 1;
  // 'k' + 6 位命名空间 + 9 位序号 = 16 字符,全部 base64url 合法字符。
  const random = `k${keyNamespace}${String(attachmentKeySeq).padStart(9, '0')}`;
  return `attachments/${envPrefix}/2026/05/15/${random}.bin`;
}
