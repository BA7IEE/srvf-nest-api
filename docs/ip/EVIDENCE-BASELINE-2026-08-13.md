# 证据基线快照 —— 2026-08-13

> **本文件是"证据快照",不是"知识产权确权证书"。**
> 它记录 2026-08-13 这一时点上,可由 Git 与公开仓库信息客观核验的状态,供后续比对与追溯。
> 权利口径见 [`COPYRIGHT.md`](../../COPYRIGHT.md);来源链见 [`PROJECT-ORIGIN.md`](./PROJECT-ORIGIN.md)。

---

## 1. 快照锚点

| 项 | 值 |
|---|---|
| 快照日期 | **2026-08-13**(采集时刻本机时间 12:15–12:40 CST;UTC 时间戳 `2026-08-13T04:40:42Z`) |
| 仓库 | `BA7IEE/srvf-nest-api`(PUBLIC) |
| **main HEAD** | **`8edfc59e403e2b5b72e0b8833119fbf466749a79`** |
| main HEAD 提交时间 / 标题 | 2026-08-13 10:56:53 +0800 · `feat(governance): complete phase two boundary records (#986)` |
| `package.json#version` | **0.66.0** |
| 默认分支 | `main` |
| GitHub `pushed_at` | 2026-08-13T04:13:31Z |

> 本地 `git rev-parse origin/main` 与 `gh api repos/BA7IEE/srvf-nest-api/branches/main` 两侧独立取值一致。

## 2. 开发历史统计

| 指标 | 值 | 复核命令 |
|---|---|---|
| commit 总数(main) | **1001** | `git rev-list --count origin/main` |
| 已合并 PR 数 | **957** | `gh api 'search/issues?q=repo:BA7IEE/srvf-nest-api+is:pr+is:merged'` → `total_count` |
| tag 数 | **66**(`v0.2.0` → `v0.66.0`) | `git tag \| wc -l` |
| GitHub Release 数 | **66** | `gh release list --limit 200 \| wc -l` |
| 时间跨度 | 2026-05-05 → 2026-08-13(约 101 天) | `git log --reverse` / `git log -1` |
| 月度分布 | 2026-05:293 · 06:213 · 07:396 · 08(至 13 日):99 | `git log --date=format:'%Y-%m' --format='%ad' \| sort \| uniq -c` |

**版本状态注记**:最新 tag `v0.66.0` 在 GitHub 上标记为 **Pre-release**;`v0.65.0` 为 Latest。这与 [`docs/current-state.md`](../current-state.md) §1 中"该 tag 永久不代表可部署"的记载一致,属于工程发布状态,与权利归属无关。

## 3. 作者与贡献者统计

**git author(main,共 1001)**:

| git 身份串 | commit 数 |
|---|---|
| `David 老灯 <32892836+BA7IEE@users.noreply.github.com>` | 957 |
| `tungwerl <tungwerl@gmail.com>` | 41 |
| `David 老灯 <tungwerl@gmail.com>` | 3 |

**git committer(main,共 1001)**:

| git 身份串 | commit 数 | 性质 |
|---|---|---|
| `GitHub <noreply@github.com>` | 957 | GitHub 平台 squash 合并写入的提交人身份,**非代码作者** |
| `tungwerl <tungwerl@gmail.com>` | 41 | 直接提交 |
| `David 老灯 <tungwerl@gmail.com>` | 3 | 直接提交 |

**GitHub contributors API**:`srvf-nest-api` 唯一贡献者 `BA7IEE`(1001);`u-nest-api-starter` 唯一贡献者 `BA7IEE`(88)。两仓均无匿名贡献者、无其他账号。

**结论**:依据当前 Git author 记录与 GitHub contributors API,**未发现 BA7IEE 账号之外的其他可识别自然人贡献者**;在同一记录范围内,亦未发现以 bot 身份作为 author 的 commit。本仓库文档只建立 **邓旺 ↔ BA7IEE** 的公开身份关联,git 身份串到自然人的完整对应由开发者在仓库外的身份声明中确认。

## 4. root commit(两仓)

| 项 | `srvf-nest-api` | `u-nest-api-starter` |
|---|---|---|
| root commit SHA | `c35d98021f213e3b077941487518144356311a63` | `b64af2fa759b214d368025935609060e13807c74` |
| tree | `0beb808f10f28c3680294445c36e218ea3b81f03` | `577d21c0e25044c19678bf90cea5a73152f55046` |
| parent 数 | **0** | **0** |
| author / committer | `tungwerl <tungwerl@gmail.com>`(两者相同) | `tungwerl <tungwerl@gmail.com>`(两者相同) |
| 时间 | 2026-05-05 00:00:15 +0800 | 2026-05-02 16:53:48 +0800 |
| message 首行 | `chore: initial commit` | `chore: 第一阶段 — 项目初始化骨架` |
| 引入文件数 | 120 | 15(共 6,028 行) |

本仓 root commit message 正文写明:"派生自 u-nest-api-starter v0.1.6,作为深圳公益救援队(SRVF)系统 API 的起点。"

```bash
git cat-file commit c35d98021f213e3b077941487518144356311a63
```

## 5. 派生点比对结果(摘要)

模板仓 `v0.1.6` 树 ↔ 本仓 root commit 树,整目录逐文件比对:

- 模板仓 119 个文件 / 本仓 120 个文件
- **逐字节一致:114 个**
- 内容有差异:5 个(`README.md`、`package.json`、`CHANGELOG.md`、`docs/deployment.md`、`docs/docker-smoke-test.md`)
- 仅本仓新增:1 个(`.github/workflows/docker-smoke.yml`);仅模板仓有而本仓缺失:0 个

详细方法与复现命令见 [`PROJECT-ORIGIN.md`](./PROJECT-ORIGIN.md) §3.2。

## 6. 当前工作树状态

| 项 | 值 |
|---|---|
| 证据采集时刻 | `git status --porcelain` **输出为空**(工作树 clean,零改动) |
| 本次文档固化后 | 仅新增 4 个此前不存在的文件:`COPYRIGHT.md`、`docs/ip/PROJECT-ORIGIN.md`、`docs/ip/EVIDENCE-BASELINE-2026-08-13.md`、`docs/ip/THIRD-PARTY-NOTICES.md` |
| 已跟踪文件修改 | **0 个**(`git diff --stat` 为空) |
| Git 历史 | **未改动**:无 commit、无 tag、无 rebase / squash / force push |
| 依赖与业务代码 | **未改动**:`package.json`、`pnpm-lock.yaml`、`prisma/**`、`src/**`、`test/**` 均未修改 |

## 7. 当前 LICENSE 状态

| 项 | `srvf-nest-api` | `u-nest-api-starter` |
|---|---|---|
| LICENSE / COPYING / NOTICE 文件 | **无** | **无** |
| GitHub 识别到的 license | **null** | **null**(license API 返回 404) |
| `package.json#license` | `UNLICENSED` | `UNLICENSED` |
| `package.json#private` | `true` | `true` |
| `package.json#author` | **无该字段** | 同(未设置) |

本项目未授予开源软件许可。源代码公开可见不代表授予公众自由复制、修改、分发或商业使用的许可;GitHub 平台服务条款依法/依约产生的平台使用权限除外。完整口径见 [`COPYRIGHT.md`](../../COPYRIGHT.md) §2。

## 8. 项目成果规模(快照时点)

用于说明成果范围与体量,**不是权利认定**。计数口径见 [`docs/current-state.md`](../current-state.md) 生成计数块与下列命令。

| 类别 | 数量 |
|---|---|
| 受跟踪文件总数 | 1,634 |
| 业务与基础模块(`src/modules/`) | 37 |
| Controller / Endpoint | 94 / 498 |
| Prisma model / enum | 109 / 36 |
| 数据库 migration | 85(SQL 共 9,059 行) |
| 权限码 / 内建角色 / 审计事件 | 234 / 15 / 138 |
| 业务错误码(BizCode) | 428 |
| 单元测试 spec / E2E spec | 202 / 278 |
| 源码行数(`src/**`,不含 `*.spec.ts`) | 149,913 |
| 测试代码行数(`src` 内联 spec + `test/`) | 52,852 + 174,017 |
| 工程脚本(`scripts/`) | 26 个文件 / 14,097 行 |
| 文档(Markdown) | 331 个文件(`docs/` 90,063 行 + 根目录 103,385 行) |

**须与手写源码区分的生成物**(有 check 脚本守护):`docs/handoff/openapi.json`、`test/contract/__snapshots__/*.snap`、`CODEMAP.md`、`docs/ai-harness/ROUTE_AUTHZ.md`、`harness/architecture-debt.json`、`pnpm-lock.yaml` 等。后续准备软件著作权登记材料时,建议优先选取能够清晰体现本项目自主开发内容的源程序;生成物是否纳入,根据届时登记材料要求和申报策略另行确定。

**不属于个人权利主张范围**(见 [`COPYRIGHT.md`](../../COPYRIGHT.md) §4):SRVF / 深圳公益救援队名称与标识、组织架构真实数据、队伍业务数据。基线 commit 的受跟踪文件树中未见 Logo 等图像资产(二进制资产扫描 0 命中,见 §9)。

## 9. 知识产权风险检索结果

**检索范围**:**基线 commit `8edfc59e403e2b5b72e0b8833119fbf466749a79` 的受跟踪文件树**(共 1,634 个文件),排除 `pnpm-lock.yaml` 与生成的 OpenAPI / 契约快照文件。下列结果**仅对应该 commit 的文件树**,不代表此后的工作树状态或后续提交。

| 检索项 | 结果 |
|---|---|
| `copyright` | **0 命中** |
| `SPDX` | **0 命中** |
| 许可证标识全词匹配(MIT / BSD / GPL / AGPL / LGPL / MPL / Apache) | **2 处命中,均非许可证声明**:`docs/archive/handoff/v0.12.0.md:283` 与 `docs/archive/handoff/v0.13.0.md:314`,内容为 macOS BSD 与 GNU 命令行工具行为差异的注记 |
| `derived from` / `based on` / `copied from` / `adapted from` | 仅命中本项目自述其来源的语句,未发现第三方来源声明 |
| 第三方版权头 / 外部模板遗留版权信息 | 未发现 |
| vendored 代码目录 / `git submodule` | 未发现(基线树中无 `.gitmodules`) |
| 二进制资产(图像 / 字体 / 压缩包) | 0 个 |

**复核命令(显式钉在基线 commit 上,不扫描当前或未来工作树)**:

```bash
B=8edfc59e403e2b5b72e0b8833119fbf466749a79

git grep -in 'copyright' "$B" -- ':!pnpm-lock.yaml' ':!*openapi*'
git grep -n  'SPDX'      "$B" -- ':!pnpm-lock.yaml' ':!*openapi*'
git grep -nwE '(MIT|BSD|MPL|AGPL|LGPL|GPL|Apache)' "$B" -- ':!pnpm-lock.yaml' ':!*openapi*' ':!CHANGELOG.md' ':!CODEMAP.md'
git grep -inE 'derived from|based on|copied from|adapted from' "$B" -- ':!pnpm-lock.yaml' ':!*openapi*'

git ls-tree -r --name-only "$B" | grep -c '\.gitmodules'   # → 0
git ls-tree -r --name-only "$B" | grep -icE '\.(png|jpe?g|gif|svg|ico|webp|ttf|otf|woff2?|eot|pdf|zip)$'   # → 0
git ls-tree -r --name-only "$B" | wc -l                    # → 1634
```

> 方法注记:首轮检索曾因 macOS 平台的 `git grep -E '\b'` 不支持词边界而产生假阴性,已改用可移植写法(`-w` 与 POSIX 字符类)全部重跑后取数。

## 10. 调查方法

1. **只读优先**:第一阶段全程未修改任何文件;第三阶段仅新增本组文档,未触碰业务代码、测试、数据库、依赖与 Git 历史。
2. **双源交叉验证**:关键事实同时取自本地 Git 与 GitHub API(如 main HEAD、contributors、PR 数),两侧一致才采信。
3. **文件级比对而非文本描述**:派生关系用 `git archive` 解包后 `diff -rq` 整目录比对得出,而非依赖 README 的自述。
4. **许可证取自锁定版本的安装包元数据**:见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) §1 方法说明。
5. **原始输出留存**:所有命令的原始输出存入仓库外私人证据包 `SRVF-IP-EVIDENCE-2026-08-13/`(与仓库同级目录,**刻意不纳入 Git**),含两仓完整 Git bundle、GitHub API 原始 JSON、许可证扫描原始结果、派生点比对结果与 SHA-256 校验清单。

## 11. 关键复核命令

```bash
# 快照锚点
git rev-parse origin/main                     # → 8edfc59e403e2b5b72e0b8833119fbf466749a79
node -p "require('./package.json').version"   # → 0.66.0
git rev-list --count origin/main              # → 1001

# 作者 / 贡献者
git shortlog -sne origin/main
gh api 'repos/BA7IEE/srvf-nest-api/contributors?per_page=100&anon=1'

# root commit
git rev-list --max-parents=0 origin/main
git cat-file commit $(git rev-list --max-parents=0 origin/main)

# tag / release
git tag --sort=creatordate | head -3
gh release list --limit 200 | wc -l

# LICENSE 状态(仓库文件侧同样钉在基线 commit 上)
gh api repos/BA7IEE/srvf-nest-api/license      # → 404 Not Found
git ls-tree -r --name-only 8edfc59e403e2b5b72e0b8833119fbf466749a79 \
  | grep -iE '^(LICENSE|COPYING|NOTICE)'       # → 无匹配

# 工作树状态
git status --porcelain
git diff --stat
```

## 12. 后续基线的建立方式

如需在未来某个时点重建同类快照,应更新本文件的锚点(日期 + main HEAD + version)并重新执行 §11 命令,另存为 `EVIDENCE-BASELINE-<日期>.md`,**不覆盖本文件** —— 快照的价值在于可比对的时间序列。

---

*快照生成:2026-08-13 · 对应 main HEAD `8edfc59e403e2b5b72e0b8833119fbf466749a79` · 本文件不构成权属认定*
