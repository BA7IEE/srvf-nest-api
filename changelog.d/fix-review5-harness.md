### Fixed(第五轮 review · Harness 机器层六连 R5-02/03/04/05/06/08)

- `docs:counts` 九提取器由词法 regex 改 TypeScript AST 真源计数:注释 / 字符串 / 模板字面量中的形似代码不再误计,`@Controller (` / 同行 union / 双引号字面量等合法书写不再漏计;`EXPECTED_ROUTES` 含 spread 时显式报错不静默漏计;权限码新增与 `check-rbac-map` 镜像正则的双口径交叉校验,分歧 exit 2;九项计数现值不变(R5-02)
- **行为变更** `pnpm changelog:merge` 新增 fragment 拒收清单:非 UTF-8 / 空或纯空白 / 含一级或二级 heading(fragment 只允许 `###` 及以下,code fence 内不算)→ exit 1 且 CHANGELOG 与 changelog.d/ 均不动;先写 CHANGELOG 成功后才删源,任何失败不删(R5-03)
- **行为变更** linked worktree 的 e2e 测试库名由 `app_test_<slug>` 改为 `app_test_<slug>_<仓路径哈希前 6 位>`(空 slug 亦带哈希,linked worktree 永不回落 `app_test`):slug 折叠 / 40 字符截断导致的跨 lane 共库、全非拉丁目录名回落主测试库均不再发生;主仓与 CI 恒 `app_test` 零变化(R5-04)
- 恒读协议三处互冲表述统一对齐 `AGENTS.md §0`(恒读三件套 = 根 AGENTS → current-state → process §2/§3):current-state §6 / CLAUDE.md 头行 / ai-harness README 头行(R5-05)
- CI Docs guards 步骤补挂 `docs:codemap:check` + `docs:rbacmap:check`(四守护全上 CI,与 ai-harness README §2 声明对齐);CODEMAP 六处 service 精确 LOC true-up(activities 1241 / activity-registrations 1603 / attendances 1781 / dictionaries 521 / role-bindings 872 / users 972)(R5-06)
- **行为变更** `pnpm agent:preflight` lane 模式必须带显式 lane 名(`--lane <name>` / `--lane=<name>` / `SRVF_LANE=<name>`;无名、纯数字或 false 类值 exit 1,未知参数拒);lane 模式检测到 E 档 bump 特征(package.json 与 apply-swagger.ts 同时脏/暂存)硬拒并要求 global(R5-08)
- 新增可执行回归自测:`pnpm tsx scripts/harness-guards.selftest.ts`(R5-02/03/04 报告全部绕过样例)+ `bash scripts/agent-preflight.selftest.sh`(R5-08)
