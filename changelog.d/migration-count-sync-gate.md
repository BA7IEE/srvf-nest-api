### 「加一条 migration 打挂 N 份 e2e 计数 spec」类闸 —— 把本机零反馈区补上执行位

2026-08-25 `#1186` 加了第 96 条 migration。6 份**冷库重放型** e2e 里各自手写的
`const CURRENT_MIGRATION_COUNT = 95;` 当场全部过期,而本机 lint / typecheck / 全量 unit /
十余条静态判据**全绿零症状** —— 唯一会红的地方是 CI 的 e2e 分片,也就是最贵、最晚、
最容易被读成 flake 的那一格。同形状此前已复发过两次(`#1048` / `#1055`)。

#### ⭐ 零反馈区是**实测出来的**,不是推演

在把 6 份常量全改回 95(= `#1186` 修复前 main 的真实状态)之后跑既有守护:

| 判据 | 读数 |
|---|---|
| `scripts/check-codemap.ts` 的 `migration-count-matches` | **`[PASS]` 96 migration(s);prisma/CLAUDE.md 声明一致** |
| `check-codemap.ts` 整体 | `0 FAIL, 2 WARN, 1 INFO, 5 PASS` |

⇒ 全仓唯一守 migration 计数的那条判据只比**一对**(`prisma/migrations/` 实际数 ↔ `prisma/CLAUDE.md` 声明),
对「6 份 spec 的常量过期」**结构性失明**。`CURRENT_MIGRATION_COUNT` 在
`scripts/` / `harness/` / `.github/` 三处命中数**实测为 0**,只出现在那 6 份 spec 自己
与 CHANGELOG / NEXT_TASKS / archive 三处**散文**里。

#### ⚠️ 刻意**不**把那个常量改成「从磁盘现取」

理由与 `EXPECTED_ROUTE_COUNT` 是同一条:**自动取数 = 判据永远同意自己**。
那 6 份 spec 断言的是「冷库从零重放后 `_prisma_migrations` 里的成功记录数 = 我(人)声明的期望值」;
期望值一旦改成运行时读目录,这条断言就退化成「Prisma 把它自己数出来的文件都跑了」。
本刀守的是「**那个手写的数有没有跟上**」,不是取消手写。两句话是不同的:

- spec:**数据库里**真的跑成功了 N 条(要 Postgres,只在 CI e2e 分片有)
- 本闸:那个 N 与 `prisma/migrations/` 目录数一致(纯文件解析,秒级,恒跑)

#### 交付:`scripts/check-migration-count-sync.ts`(短名 `pnpm docs:migcount:check`)

三条断言,**全部走 TypeScript 语法树、不用正则**(insurance 那份的头注里两个被搜的名字都出现过,
正则版会把注释当成声明):

| # | 断言 | 防什么 |
|---|---|---|
| A | 每处 `const CURRENT_MIGRATION_COUNT = N;` 必须 = `prisma/migrations/` 目录数 | 本体缺陷 |
| B | 钉子份数有**地板**(不是「恰 6 份」),并打印「扫了几份 / 发现几份」 | 扫描面塌了而不自知 |
| C | 凡引用了冷库重放辅助函数 `successfulMigrationCount` 的测试文件,都必须用 `CURRENT_MIGRATION_COUNT` 这个名字 | `#1048`/`#1055` 的原形:裸 `toBe(90)` 逃出「按常量名 grep」 |

⭐ **地板不是等号**:第 7 份 spec 出现时**自动纳管**,不需要改判据里的任何数字 ——
写死「恰 6 份」的判据在那一天会静默漏掉它,那正是本刀要消灭的缺陷形状。
另有三条仪器自证(migration 数地板 / 扫描文件数地板 / 常量初始化值静态读不出来时**一律算红** ——
「判不了」不等于「没漂移」)。

#### 变异对拍(纯静态判据,本机跑;每条都验了红集精确到文件)

| # | 变异 | 读数 |
|---|---|---|
| 1 | 1 份改回 95 | exit 1,**只**点名那 1 份:`…allocation-mode…:27 — 声明 95,实际 96(差 1)` |
| 2 | 两份各错不同的量(95 / 90) | exit 1,点名 2 份且**差值各自正确**(差 1 / 差 6);同文件里的历史世代基线 `81` 未被误报 |
| 3 | 6 份全改回 95(= `#1186` 修复前的真实状态) | exit 1,点名全部 6 份 |
| 4 | 新建第 7 份「数了 migration 但用裸字面量」的文件 | exit 1,断言 C 点名它 |
| 5a | 那第 7 份改成用统一常量名且同步 | **exit 0**,且报数自动变 **7 份 / 351 份 .ts**(证明 6 不是写死的) |
| 5b | 只让那第 7 份过期 | exit 1,红集**恰是它一份** |
| 6 | 把扫描面缩到 `test/journeys`(模拟扫描面塌) | exit 1,自证报「只扫到 5 份、地板 200」+「只发现 0 份钉子、地板 6」——**不是「全绿 0 处」** |
| 反向 | 全部还原 | **exit 0**,`96 个 / 6 份 spec / 6 处声明 / 扫描 350 份 .ts`(证明不是恒红) |

⚠️ **没有**去 `prisma/migrations/` 下造假 migration 目录来做第 7 种变异:那是红区且本刀无授权。
把 6 份常量整体改回 95 与「实际数 +1」在被测的那条比较上等价,故用前者复现。

#### 接执行位:挂 `fast` job 内**无 `if`** 的那一档

⚠️ 挂点是**读 workflow 逐字定出来的**,不是凭印象:

| `fast` job 的步骤 | 触发条件 |
|---|---|
| Lint / Typecheck / Build / **Run unit tests** | `if: needs.changeset.outputs.docs_only != 'true'` ⇒ 纯 `.md` 变更时**一次都不跑** |
| Docs guards / Ops required / Architecture governance / Service size | **无 `if`,恒跑** |

⇒ 判计数/文档类的闸挂在 `pnpm test` 那一档会被 docs_only 短路;本闸与后四步同列。
`fast` job 自身无 job 级 `if`(只有 `needs: changeset`),且在 `gate`(required context
`Lint / Typecheck / E2E`)的 `needs` 里 ⇒ 红了合不了。
**单列一步**不并进 `&&` 链(同 `ops:required:check` 的理由:链式下前面挂掉它就不跑、归因不清)。

#### 🔴 有脚本名是**必需的**,不是顺手

`docs:migcount:check` 这个名字让本闸落在 `pnpm docs:refresh` 的射程内 ——
`scripts/refresh-generated-docs.ts` 的自证①(登记表 ↔ `package.json` 的 `docs:*:check` 全集双向比对)
会强制它登记。实测:先加 `package.json` 脚本名、不登记 ⇒ `pnpm docs:refresh --dry-run`
**当场退 1** 并点名 `docs:migcount:check`;补上 `refresh: null` 行(纯判据,**且刻意不该有生成物**)后退 0。
对照组 `scripts/check-frozen-drafts-ledger.ts` **没有脚本名**,那份自证对它结构性失明
(它另有执行位:`ci.yml` 的 `redzone-scan` 直接 `tsx` 调用它)。

#### 刻意不做

- **不判 `prisma/CLAUDE.md` 的声明数** —— 那一格已有唯一主人(`check-codemap.ts` 的
  `migration-count-matches`)。再判一遍会造出第二份真相,两边措辞一漂移就永远说不清听谁的。
- **不读也不改任何 spec 的断言**,只读它们的常量声明;6 份 spec 本次**零改动**(变异全部逐字节还原,`git status` 为证)。
- **不连库、不起 Nest**,故可留在无 Postgres 的 `fast` job。
