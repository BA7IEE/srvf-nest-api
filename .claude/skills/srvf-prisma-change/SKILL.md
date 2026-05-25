---
name: srvf-prisma-change
description: SRVF Nest API 项目内所有 Prisma / 数据模型 / migration / seed / enum / index / 不可逆数据变更任务的 D 档降速流程。当任务涉及 `prisma/schema.prisma`、`prisma/migrations/**`、`prisma/seed.ts`、`Role` / `Permission` / `UserStatus` 等 enum、unique / index / 外键 / cascade / default、soft-delete / partial unique / `P2002`、历史数据兼容或不可逆数据变更时使用。
---

# srvf-prisma-change

## Purpose

用于 SRVF Nest API 项目中所有 Prisma / 数据模型 / migration / seed 相关任务的 D 档降速流程。

本 skill **不复制**权威源原文,只编排"何时触发、如何降速、哪些动作禁止、如何验证、如何报告"。权威源:

- [`prisma/CLAUDE.md`](../../../prisma/CLAUDE.md) — Prisma 模块铁律
- [`AGENTS.md`](../../../AGENTS.md) §0 / §1 永久铁律 / §10 / §11 / §12 / §13 / §19
- [`docs/process.md`](../../../docs/process.md) §3 PR 分级、§4 D 档降速规则
- [`docs/current-state.md`](../../../docs/current-state.md) — 当前事实

## When to use

任务涉及以下任一情况即启用:

- 修改 `prisma/schema.prisma`
- 新增 / 删除 / 重命名 model / enum / field / relation
- 新增或修改 `prisma/migrations/**`
- 修改 `prisma/seed.ts`(尤其 `SUPER_ADMIN` / Permission seed / RolePermission 映射)
- 修改 `unique` / `index` / 外键 / `onDelete` / `default`
- 触及 `P2002` / partial unique / 软删除唯一性预检查语义
- 涉及历史数据兼容或不可逆数据变更
- 涉及 `Role` / `Permission` enum 调整
- 涉及鉴权、审计、报名、考勤、附件、存储等与 DB 状态强耦合的业务逻辑

按 `docs/process.md §4`,上述全部**默认 D 档**。

## Authority

冲突时按以下优先级:

1. 用户本轮明确指令
2. `prisma/CLAUDE.md`
3. `AGENTS.md`(尤其 §0 / §1 永久铁律 / §10 / §19)
4. `docs/process.md`
5. `docs/current-state.md`
6. 实际代码 / migration / CI 结果

规则冲突时**停止并报告**,不自行调和。

## Required workflow

### 1. 只读影响面扫描

先**只读**调研,不动任何文件。必须确认并记录:

- 涉及哪些 model / enum / relation
- 是否已有 migration 覆盖 / 是否需新增 migration
- 是否触发 seed 调整(SUPER_ADMIN / Permission code / RolePermission)
- 是否影响 DTO / service / e2e / OpenAPI snapshot / contract test
- 是否触及 soft-delete / partial unique / `P2002` 路径
- 是否不可逆 / 是否影响历史数据
- 是否需要新增或复用 `BizCode`(沿 `AGENTS.md §10` 段位)

### 2. 风险表(编辑前)

输出固定风险表,逐项给结论:

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` |  |
| 是否新增 / 改动 migration |  |
| 是否修改 `prisma/seed.ts` |  |
| 是否影响现有数据 |  |
| 是否不可逆 |  |
| 是否影响 OpenAPI / contract snapshot |  |
| 是否影响鉴权 / Permission seed / 审计 |  |
| 是否需要新增 `BizCode` |  |
| 是否需要用户拍板 |  |

任一格涉及 schema / migration / seed / 不可逆数据 → **必须先得到用户明确授权**再进入第 3 步。

### 3. 编辑红线

仅在用户明确授权后才能修改相关文件。**永远禁止**自动执行(沿 `prisma/CLAUDE.md` + `AGENTS.md §0 / §1`):

- `prisma migrate dev`
- `prisma db push`
- `prisma migrate reset`
- `--force-reset` / `--accept-data-loss` 任何变体
- 修改已合入历史的 `prisma/migrations/**/migration.sql`
- 修改生产数据
- 引入 Prisma 全局软删中间件 / client extension
- 把改动顺手扩散到本 PR 白名单之外的 service / controller / test / docs(D 档"禁止顺手做")

migration 命名必须沿 `prisma/CLAUDE.md`:`YYYYMMDDHHMMSS_<下划线分隔可读描述>`;不允许 `auto` / `tmp` / `wip`。

### 4. 验证

按影响范围选择,不要刷全量:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:contract`(OpenAPI / 响应结构变化时)
- 相关 e2e
- 如有 migration:**只说明** migration 文件名 + SQL 影响面 + 是否破坏性,不自行起本地 DB 执行

如需本地 dry-run,先与用户确认数据库目标和回滚方案。

### 5. 收尾报告

提交前必须列出:

- 修改文件清单
- schema / migration / seed 变化摘要
- 数据兼容性判断(可向前 / 不可逆 / 需脚本回填)
- 验证命令与结果
- 风险与回滚方式
- 是否需联动文档更新(`docs/current-state.md` / 模块 `CLAUDE.md` / handoff)

## Hard stops

下列情况**立即停止并报告**,不绕过、不自行决策:

- 用户未授权但任务需要修改 schema / migration / seed
- migration 与 `schema.prisma` 不一致(drift)
- seed 改动可能破坏现有登录账号或测试基线数据
- 需要删除字段 / 表 / enum value(数据丢失风险)
- 需要 `migrate reset` / `db push` / `--force-reset` / `--accept-data-loss`
- `P2002` / partial unique / 软删除唯一性预检查语义无法明确(沿 `AGENTS.md §10`)
- 发现 `docs/` 与代码 / schema 冲突且无法判断权威源
- 任务超出本 PR 白名单(D 档"禁止顺手做")
- 用户提到的 BizCode 段位 / 命名违反 `AGENTS.md §10`
