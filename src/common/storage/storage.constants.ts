// V2.x C-7.5 Provider 选型实施 PR #7:StorageProvider DI token(沿 Q-88-2 拍板 A)
//
// 使用 Symbol 而非 string:
// - 沿 NestJS 推荐范式;避免跨模块字符串 token 冲突
// - 模块边界更清晰(无法被字符串 typo 影响)
//
// PR #7 注册:`{ provide: STORAGE_PROVIDER, useExisting: LocalStorageProvider }`
// PR #8 切换:改 useFactory + 读 storage_settings.providerType 选 Local / COS
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
