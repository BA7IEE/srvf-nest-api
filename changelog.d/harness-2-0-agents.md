### Harness 2.0 · PR4 AGENTS 重写与 reference 拆分(#TBD)

- `AGENTS.md` 由 621 行 / 45,395 字符重写为 **2.0 形态 10,487 字符**(读取协议与权威冲突表唯一副本 §0 / 铁律速查 §1 / 决策锁与行为冻结索引 §2 / 红区与触发即停 §3 / lane 协议摘要 §4 / 流程指针 §5 / reference 索引与 v1 节号重定向表 §6);**决策语义零放宽**,教学细则逐字搬家至新 `docs/reference/` 九篇(唯一机械改写=相对链接前缀),v1 全文可在 `archive/harness-v1/` 找回
- `CLAUDE.md` 重写为 1,037 字符纯入口;`docs:readtax:check` 三文件全部翻 `enforced=true`(恒读层 45,395+89,108+3,521 → **10,487+3,085+1,037 字符,合计 -89%**)
- ARCHITECTURE / baseline / V2 红线顶部各加 3 行内背景层横幅(正文不动;V2 红线仍滚动维护)
- 全仓活跃文档旧节号引用清扫 ~40 处(security / development / NEXT_TASKS / RBAC_MAP / CODEMAP / api-surface-migration-plan / V2 红线 / 6 个模块级 CLAUDE.md / prisma CLAUDE.md / docs-counts 头注);`src/**` 与 `test/**` 代码注释内引用**刻意不动**(0 改 src 红线;经 AGENTS §6 重定向表一跳可解析,沿"动到再顺手校准"惯例)
