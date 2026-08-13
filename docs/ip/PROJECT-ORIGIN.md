# 项目来源与派生链(PROJECT ORIGIN)

> **文件性质**:事实记载。所有结论均标注可复核证据(commit SHA / 文件路径 / 可复跑 Git 命令)。
> **重要限制**:**Git 记录能够证明项目历史和开发账号来源,但不能单独完成法律上的最终权属认定。**
> 权利口径见根目录 [`COPYRIGHT.md`](../../COPYRIGHT.md)。

---

## 1. 结论(一句话)

```
u-nest-api-starter (BA7IEE)
        │  v0.1.6  ——  2026-05-03
        │
        ▼  文件级派生(拷贝文件后另起独立 Git 历史,非 GitHub fork)
        │  声明派生日期 2026-05-04
        │
srvf-nest-api (BA7IEE)
           root commit c35d9802 —— 2026-05-05
```

两仓同属 GitHub 账号 **BA7IEE** 名下。派生点上,模板仓 v0.1.6 的 **119 个文件中有 114 个与本仓首个 commit 逐字节一致**。

## 2. 两个仓库的身份对照

| 项 | `srvf-nest-api`(本仓) | `u-nest-api-starter`(来源) |
|---|---|---|
| GitHub 全名 | `BA7IEE/srvf-nest-api` | `BA7IEE/u-nest-api-starter` |
| 可见性 | PUBLIC | PUBLIC |
| `fork` 标志 | **false** | **false** |
| `parent`(上游 fork 源) | 无 | **无** |
| `is_template` | false | **true** |
| GitHub 创建时间 | 2026-05-09T07:54:57Z | 2026-05-02T13:33:43Z |
| 默认分支 | `main` | `main` |
| LICENSE(GitHub 识别) | **null(无)** | **null(无)** |
| `package.json#license` | `UNLICENSED` | `UNLICENSED` |
| root commit | `c35d98021f213e3b077941487518144356311a63` | `b64af2fa759b214d368025935609060e13807c74` |
| root commit 时间 | 2026-05-05 00:00:15 +0800 | 2026-05-02 16:53:48 +0800 |
| root commit 的 parent | **0 个** | **0 个** |
| commit 总数 | 1001(截至 2026-08-13) | 88(最后推送 2026-05-17) |
| GitHub contributors | 仅 `BA7IEE`(1001) | 仅 `BA7IEE`(88) |

> 复核:`gh api repos/BA7IEE/srvf-nest-api`、`gh api repos/BA7IEE/u-nest-api-starter`、
> `gh api 'repos/<仓>/contributors?per_page=100&anon=1'`。原始 JSON 已存入仓库外私人证据包。

## 3. 派生链证据(逐条可复核)

### 3.1 首个 commit 自带来源声明(非事后追认)

本仓 root commit `c35d9802` 的 commit message 正文即写明派生关系:

```
chore: initial commit

派生自 u-nest-api-starter v0.1.6,作为深圳公益救援队(SRVF)系统 API 的起点。
```

```bash
git cat-file commit c35d98021f213e3b077941487518144356311a63
```

同一 commit 内的文件也已带声明:

- [`package.json`](../../package.json) `description`:"深圳公益救援队(SRVF)系统 API — 派生自 u-nest-api-starter v0.1.6"
- [`README.md`](../../README.md) 第 7 行:"**Derived from `u-nest-api-starter` `v0.1.6`**(派生日期 2026-05-04)"

```bash
git show c35d98021f213e3b077941487518144356311a63:package.json | head -6
git show c35d98021f213e3b077941487518144356311a63:README.md | head -10
```

### 3.2 派生点文件级比对:119 个文件中 114 个逐字节一致

把模板仓 `v0.1.6` 的树与本仓 root commit 的树各自解包后整目录比对:

| 指标 | 值 |
|---|---|
| 模板仓 v0.1.6 文件数 | 119 |
| 本仓 root commit 文件数 | 120 |
| **逐字节完全一致** | **114** |
| 内容有差异 | 5:`README.md` · `package.json` · `CHANGELOG.md` · `docs/deployment.md` · `docs/docker-smoke-test.md` |
| 仅本仓新增 | 1:`.github/workflows/docker-smoke.yml` |
| 仅模板仓有、本仓缺失 | **0** |

5 个差异文件的改动集中在项目改名(`u-nest-api-starter` → `srvf-api`)、来源声明与部署文档调整,合计约 96 处行级差异;完整 unified diff 见私人证据包 `raw/derivation-differing-files.diff`。

```bash
# 复现方式(需先克隆模板仓)
mkdir -p /tmp/cmp-starter /tmp/cmp-srvf
git -C <starter 克隆> archive v0.1.6 | tar -x -C /tmp/cmp-starter
git archive c35d98021f213e3b077941487518144356311a63 | tar -x -C /tmp/cmp-srvf
diff -rq /tmp/cmp-starter /tmp/cmp-srvf
```

### 3.3 两仓在 Git 对象层没有共享历史

派生方式是**拷贝文件后另起全新 Git 历史**,不是 GitHub fork,也不是 `git clone` 保留历史:

- 本仓 root commit `c35d9802` 的 **parent 数为 0**;模板仓 root commit `b64af2fa` 的 parent 数同样为 0
- 模板仓的 root commit 对象在本仓对象库中**不存在**
- GitHub 两仓的 `fork` 均为 false、`parent` 均为空

```bash
git rev-list --max-parents=0 origin/main          # → c35d9802…(唯一 root)
git cat-file -e b64af2fa759b214d368025935609060e13807c74^{commit}   # → fatal: Not a valid object name
```

模板仓 `README.md` 提供的下游派生方式正是 GitHub "Use this template"(其 `is_template=true`),该方式产出的新仓库即为**无共享历史的独立仓库**,与上述观测一致。

### 3.4 版本号与 CHANGELOG 的接续关系

本仓 [`CHANGELOG.md`](../../CHANGELOG.md) 保留了模板期的 `v0.1.0` → `v0.1.6` 共 7 条条目(文件末尾段落),本仓自身版本自 `v0.2.0`(2026-05-09)起接续编号,当前为 `v0.66.0`。

```bash
grep -n '^## v0\.1\.' CHANGELOG.md      # → 7 条模板期条目
git log -1 --date=iso --format='%H | %ad | %s' v0.2.0
```

### 3.5 时间线自洽

| 时间 | 事件 | 证据 |
|---|---|---|
| 2026-05-02 16:53:48 +0800 | 模板仓 root commit | `b64af2fa` |
| 2026-05-03 19:23:04 +0800 | 模板仓 v0.1.6 对应 commit | `ff2a7a5f`(annotated tag 对象 `86496d2`,19:26:25) |
| 2026-05-04 | 本仓 README 声明的派生日期 | `README.md:7` |
| 2026-05-05 00:00:15 +0800 | 本仓 root commit | `c35d9802` |
| 2026-05-09 07:54:57Z | 本仓 GitHub 建仓 | repo API `created_at` |
| 2026-05-10 14:41:19 +0800 | 模板仓 v0.1.7 后进入 freeze | 模板仓 `README.md` |

### 3.6 工程契约命名沿用(旁证)

本仓 CI、Dockerfile、docker-compose 至今沿用模板的 `u-nest-api-*` 命名,并在 [`README.md`](../../README.md) 中明确记为"稳定的工程契约,不要改名";[`docker-compose.yml`](../../docker-compose.yml) 第 4 行注释亦记载了派生事实。

```bash
git grep -n "u-nest-api-starter" -- ':!CHANGELOG.md' ':!CODEMAP.md'
```

## 4. 来源仓库 `u-nest-api-starter` 自身的来源调查

对模板仓完整克隆(88 个 commit)所做的调查:

- **无上游 fork**:`fork=false`、`parent` 为空;root commit `b64af2fa` **无 parent**
- **root commit 内容**:2026-05-02 16:53:48 +0800,15 个文件、共 6,028 行(工程配置、规范文档与应用入口骨架)。完整文件清单见私人证据包 `raw/starter-root-commit.txt`,或 `git diff-tree --root --name-only -r b64af2fa`
- **建仓节奏**:同日以"第一阶段"~"第十四阶段"系列 commit 逐步搭建(Docker Compose、Prisma 数据层、公共基础件、健康检查、Swagger、JWT 登录、用户管理、seed、E2E 测试骨架等),2026-05-02 当日形成 v0.0.1 基线,2026-05-03 达 v0.1.6
- **LICENSE**:无 LICENSE 文件;GitHub license API 返回 404;`package.json#license` 为 `UNLICENSED`
- **第三方来源声明:未发现**。检索基准为模板仓 HEAD `a4ccaaa2bd9ea55a7ddf918f603638066b0117fb`(2026-05-17,88 个 commit)的受跟踪文件树;检索 `copyright`、许可证标识(全词匹配 MIT / BSD / GPL / AGPL / LGPL / MPL / Apache)、`derived from|based on|copied from|adapted from`,除其自身 README 中说明"如何派生下游项目"的章节外,**零命中**
- **贡献者**:GitHub contributors 仅 `BA7IEE`(88 次);git author 身份为同一账号的两个身份串(`tungwerl@gmail.com` 51 + 2,`32892836+BA7IEE@users.noreply.github.com` 30 + 5)

```bash
git clone --mirror https://github.com/BA7IEE/u-nest-api-starter.git
git -C u-nest-api-starter.git rev-list --max-parents=0 HEAD
git -C u-nest-api-starter.git shortlog -sne HEAD
```

## 5. 贡献者与开发账号

**本仓 git author 身份分布(main,共 1001 个 commit)**:

| git 身份串 | commit 数 | 说明 |
|---|---|---|
| `David 老灯 <32892836+BA7IEE@users.noreply.github.com>` | 957 | GitHub 账号 BA7IEE 的 noreply 邮箱(内嵌账号名与数字 ID) |
| `tungwerl <tungwerl@gmail.com>` | 41 | 直接提交 |
| `David 老灯 <tungwerl@gmail.com>` | 3 | 同一邮箱,显示名不同 |

**自动化身份(平台机制,非代码贡献者)**:957 个 commit 的 committer 为 `GitHub <noreply@github.com>`,即 GitHub 平台执行 squash 合并时写入的提交人身份,与已合并 PR 数(957)一致。在当前 git author 记录中,**未发现以 bot 身份作为 author 的 commit**。

**结论与边界**:

- 依据当前 Git author 记录与 GitHub contributors API,**未发现 BA7IEE 账号之外的其他可识别自然人贡献者**
- 本文件在仓库层面建立的公开身份关联是:**邓旺 ↔ GitHub 账号 BA7IEE**
- git 身份串到自然人的完整对应关系,由开发者在**仓库外**的身份声明中确认;本仓库不保存身份证件等敏感身份材料

```bash
git shortlog -sne origin/main
git log origin/main --format='%cn <%ce>' | sort | uniq -c | sort -rn
```

## 6. 已知来源边界(本文件**不能**证明什么)

诚实列出限制,避免过度解读:

1. **Git 只能证明"最早可证明的开发记录点"**,即模板仓 2026-05-02 那个无 parent 的 root commit;它不能证明此前不存在其他载体上的工作。
2. **不因两仓 owner 相同就推定"全部原创"**。本文件陈述的是可观测事实:依据 Git 记录,两仓 commit 均由同一账号完成;在 §7 所列检索范围内,未发现第三方版权声明或来源声明。
3. **与 NestJS 生态项目的结构相似性**属于使用该框架的通用范式;框架本身以包依赖方式引入,仓库内**无框架源码副本**(见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md))。
4. **未做与外部代码库的相似度比对**(需专门工具);本次调查的检索面是本仓与模板仓的全部受跟踪文件。
5. **法律权属不由 Git 决定**。是否存在职务作品、委托开发等法律关系,须依法认定;本文件不作结论。

## 7. 复核命令清单

```bash
# 本仓基础事实
git rev-parse origin/main
git rev-list --max-parents=0 origin/main
git rev-list --count origin/main
git cat-file commit $(git rev-list --max-parents=0 origin/main)

# 来源仓
git clone --mirror https://github.com/BA7IEE/u-nest-api-starter.git
git -C u-nest-api-starter.git rev-list --max-parents=0 HEAD
git -C u-nest-api-starter.git log --oneline --reverse | head -20

# 派生点比对(见 §3.2)
# GitHub 元数据
gh api repos/BA7IEE/srvf-nest-api
gh api repos/BA7IEE/u-nest-api-starter
gh api 'repos/BA7IEE/srvf-nest-api/contributors?per_page=100&anon=1'

# 全仓知识产权风险检索 —— 必须显式钉在基线 commit 上,不扫描当前或未来工作树
# 结果与判读见 EVIDENCE-BASELINE-2026-08-13.md §9
B=8edfc59e403e2b5b72e0b8833119fbf466749a79
git grep -in 'copyright' "$B" -- ':!pnpm-lock.yaml' ':!*openapi*'
git grep -nwE '(MIT|BSD|MPL|AGPL|LGPL|GPL|Apache)' "$B" -- ':!pnpm-lock.yaml' ':!*openapi*' ':!CHANGELOG.md' ':!CODEMAP.md'
```

## 8. 关联文件

- 权利声明:[`COPYRIGHT.md`](../../COPYRIGHT.md)
- 第三方依赖与许可证:[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)
- 证据基线快照:[`EVIDENCE-BASELINE-2026-08-13.md`](./EVIDENCE-BASELINE-2026-08-13.md)

---

*最后更新:2026-08-13(对应 main HEAD `8edfc59e403e2b5b72e0b8833119fbf466749a79`)*
