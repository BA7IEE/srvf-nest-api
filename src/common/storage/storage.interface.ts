import type {
  PutObjectInput,
  StoredObject,
  GenerateUploadUrlInput,
  UploadUrlResult,
  GenerateDownloadUrlInput,
  DownloadUrlResult,
  HeadObjectResult,
} from './storage.types';

// StorageProvider 接口(C-7.5 v1.0 锁;沿 F5 / Q5 + §7.4)
// 详见 ARCHITECTURE.md §3 + §4 + 附录第 10 步 + CLAUDE.md §1
//      + docs/批次7_provider选型_API前评审.md §7.4
//      + docs/批次7_provider选型_V2x立项记录.md §二.2
//
// **本 PR(C-7.5 实施 PR #5)仅扩展接口 + 类型,不实装任何 Provider**:
// - 不新建 providers/local.provider.ts(留 PR #7)
// - 不新建 providers/cos.provider.ts(留 PR #8)
// - 不新建 storage.module.ts / 不定义 DI token(留 PR #7-8 接通时一起)
// - 不引入 cos-nodejs-sdk-v5(留 PR #8)
// 0 runtime impact / 0 callsite / 0 module wiring。
//
// Q5 锁定 3 子项(沿 §7.4):
// - Q5a:expiresIn = number(秒);不接受 Date / Duration 字符串
// - Q5b:UploadUrlResult.headers 必填(可空对象);LocalProvider 返 {} / COS 返 { 'Content-Type': mime, ... }
// - Q5c:UploadUrlResult.method = 'PUT' | 'POST' 联合保留;v1.0 全返 'PUT'(沿 Q19 / Q13);
//        'POST' 路径留未来 multipart upload 启用时再实施
//
// 仍不收录的方法(留 v1.1+ 评审):
// - getStream / range:走 signed URL 直下(沿 F2)
// - copyObject / moveObject:本批次不实装
// - getMultipartUploadId / completeMultipartUpload:Q13 锁不实施(单文件 ≤ 5GB 走 PUT signed URL)
export interface StorageProvider {
  // === v1 已有(沿用)===
  putObject(input: PutObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;

  // === C-7.5 v1.0 新增(沿 F5 / Q5 / §7.4)===
  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult>;
  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult>;
  headObject(key: string): Promise<HeadObjectResult>;
}
