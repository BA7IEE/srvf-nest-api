// v1 极简版定义"写入 / 删除"两组动作所需类型;
// C-7.5 实施 PR #5 沿 F5 + Q5 新增"upload / download signed URL + head"类型
// (详见 docs/批次7_provider选型_API前评审.md §7.4)。
//
// 命名铁律:文件标识必须叫 `key`,不叫 path / filename / url(详见 §7.2 + CLAUDE.md §3)。

export type StorageBody = Buffer | NodeJS.ReadableStream;

export interface PutObjectInput {
  key: string;
  body: StorageBody;
  contentType?: string;
  metadata?: Record<string, string>;
}

// size 可选:stream 场景未必提前知道字节数;由具体 Provider 决定是否回填。
// etag 可选:S3 兼容 Provider 一般会返回;本地实现可省略。
export interface StoredObject {
  key: string;
  size?: number;
  contentType?: string;
  etag?: string;
}

// === C-7.5 v1.0 锁:upload-url 类型(沿 Q5a / Q5b / Q5c / Q6 / §7.4)===

// upload signed URL 输入(key 由 Service 后端生成;沿 Q6a + Q17)
export interface GenerateUploadUrlInput {
  key: string;
  contentType: string; // MIME 类型(沿 Q6d 校验后传入)
  sizeBytes?: number; // 可选;Content-Length pinning 留 v1.1 评估
  expiresIn: number; // Q5a:秒数;Service 层保证 > 0
}

// upload signed URL 输出(Service → Controller → 客户端)
export interface UploadUrlResult {
  url: string;
  method: 'PUT' | 'POST'; // Q5c:联合保留;v1.0 全返 'PUT';'POST' 留未来 multipart
  headers: Record<string, string>; // Q5b:必填;LocalProvider 返 {} / COS 返 { 'Content-Type', ... }
  expiresAt: Date; // 不变式:必 > Date.now()
}

// === C-7.5 v1.0 锁:download-url 类型(沿 Q5a / Q8 / §7.4)===

export interface GenerateDownloadUrlInput {
  key: string;
  expiresIn: number; // Q5a:秒数(典型 300;沿 Q8 默认)
  contentDisposition?: string; // 可选;`attachment; filename="..."`
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: Date;
}

// === C-7.5 v1.0 锁:headObject 类型(沿 §7.4)===

// confirm-upload 后端用:验文件已上传 + 拿 size / etag / contentType 做一致性校验
export interface HeadObjectResult {
  exists: boolean;
  size?: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
}
