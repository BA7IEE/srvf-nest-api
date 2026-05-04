// v1 仅定义最稳定的"写入 / 删除"两组动作所需的类型;
// 不引入签名 URL / 公开访问 URL / 流式下载 / 范围请求等概念,
// 留待后续 Provider 接入时(详见 ARCHITECTURE.md §9)再扩展。
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
