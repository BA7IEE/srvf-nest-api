## Changed

- SMS、WeChat、Storage、Realname 四类运行时设置改为每次直读 PostgreSQL 当前已提交 singleton，移除 60 秒进程缓存与 `invalidate()` 正确性链；写事务提交后任一实例的下一次 settings 读取直接获得新事实，provider Effect 使用其当前边界实际消费的一份配置快照。
- WeChat、COS、实名 OCR 与既有 SMS route 均把单次 Effect 绑定到一份已解析配置快照；Storage pinned locator 继续固定 provider/bucket/region，仅凭证使用当前代。
- WeChat access token 进程缓存按不透明配置 generation 隔离，配置切换后的下一 delivery 不复用旧 token，同一 delivery 的 token-invalid refresh/retry 不跨代混用。
- Storage `enabled` 行为保持现状：pinned locator 与 production bootstrap 执行开关检查，legacy non-pinned 调用尚未统一执行；全局关闭语义留给后续 Storage 生命周期 D 切片。

## Tests

- 增加四类 settings live-read 单元测试、provider snapshot/token-generation mutation tests，以及双 Nest app/双 Prisma pool 的 committed cutover、事务可见性、最终 SDK/fetch facade 与在途 Effect barrier E2E 探针。
