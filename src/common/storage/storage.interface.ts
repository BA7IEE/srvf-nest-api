import type { PutObjectInput, StoredObject } from './storage.types';

// v1 storage 抽象仅承诺两个最稳定的动作:写入 / 删除。
// 详见 ARCHITECTURE.md §3 + §4 + 附录第 10 步 + CLAUDE.md §1。
//
// **v1 刻意不实现任何 Provider**(本地 / OSS / R2 / S3 / 阿里云 OSS 等),
// 也不定义注入 token,不注册 StorageModule。第一个产品需要文件上传时,
// 按 §9 升级路径在 src/common/storage/providers/ 下落地具体 Provider,
// 届时再补 storage.module.ts 与注入 token。
//
// 刻意不收录的方法(留待 Provider 设计时定调):
// - get / getStream:下载流,牵涉权限 / range / content-disposition
// - exists:可由业务查 DB 或 Provider 自行决定,不必作为基础接口强约束
// - getUrl / getSignedUrl:公开访问 URL / 签名 URL / 过期时间 / 权限策略
export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
}
