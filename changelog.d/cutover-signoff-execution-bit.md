### 切换前签字登记表补上执行位 —— 判据先收编进 selfGuard,再接进 `Diff guards`(此前「签字与机器读数矛盾即红」只是散文)

昨天建了签字机制、今天签满 10 条,而立项当天实测:`cutover:check` 在**全部 workflow 里 0 命中**,
`scripts/cutover-check.ts` 也不在 `harness/redzone.json` 的 selfGuard 内(那份 glob 是
`scripts/check-*.ts` 等**具名清单**,它一个都不匹配)。
⇒ 登记表是一份 `.md`,只改它的 PR **恰恰就是 docs-only**,`fast` 的 Lint / Typecheck / Build /
Run unit tests 四步全带 `if: docs_only != 'true'`,`slow` / `journeys` 是 job 级 `if` 整个跳过
⇒ **`scale-tiers-passing` 这类对拍值,任何 PR 都能改成任意数字而 CI 一片绿。**

维护者 2026-08-26 拍板「收进去」。红区/执法层动 **3 条**,三条都已发令牌:
`harness/redzone.json` · `.github/workflows/ci.yml` · `scripts/harness-guards.selftest.ts`。

⚠️ **第三条是开工清单里漏掉的**,由实施途中的机器读数逼出来:redzone.json 每新增一条 glob,
`F4 glob 覆盖闭环` 就要求它在 `harness-guards.selftest.ts` 的 `GLOB_EXPECTATIONS` 里有正反样例
(实测 registry 68 条 / 表里 67 条 ⇒ `uncovered = ["scripts/cutover-check.ts"]`),
而那张表就在受保护文件里。**「凭记忆开授权清单这个动作本身就是错的」在本刀又验证一次。**
(`scripts/cutover-check.ts` 本身在 base 的 registry 里还不受保护,趁它还在自由区先改的头注;
合入后它才进保护面。)

#### 顺序只有一个方向:先收编,后接闸

1. `harness/redzone.json` 的 `enforcement-layer` 新增 **具名一条** `scripts/cutover-check.ts`;
2. `.github/workflows/ci.yml` 的 `Diff guards`(job `redzone-scan`)在「Frozen drafts ledger gate」
   之后新增一步 **`Cutover sign-off ledger gate`** → `pnpm cutover:check:signoff`;
3. `scripts/harness-guards.selftest.ts` 同 PR 补 `F4` 正反样例 + 两条**禁止型**接线断言(见下)。

🔴 **反过来做当场红**:`P4a ci-guard-coverage` 会报「以下脚本被 CI/检查链引用却不在 selfGuard,
可在同一 PR 内被改松而不被察觉」—— 那正是 2026-07-29 跨模型评审 BLOCKER-1 的形状,
上一条 lane 就是这样被拦下并**整段撤回**的(撤回是对的)。
⚠️ P4a 拿正则扫 `ci.yml` **全文,注释也算** ⇒ 收编之前连把命令**写在注释里**都会判红。

#### 为什么是具名一条,不是整个 `scripts/`;为什么不改名

- **具名**:2026-07-28 把 selfGuard 从 `scripts/**` 收窄的理由一字未变 —— 全量收编会让每新增一个
  普通脚本都要授权一次,**授权沦为例行公事就不再是拍板**。判别式仍是「是不是裁判」,
  而本文件的 `--signoff` 从今天起是 CI 的一道门。
- **影响面**:此后改 `scripts/cutover-check.ts` 与改其它裁判同价 —— 要维护者发令牌;
  `harness:needs` 对它从「不需要授权」翻成「需要授权」。
- **不改名**:搬成 `scripts/check-cutover.ts` 能自动落进既有 glob、省掉这条 glob,
  但该路径被 `docs/ops/activity-batch-worker-runbook.md` 点名,而那份 runbook 的 sha256
  正是 ⑦-c 签字的对拍锚(`worker-runbook-sha256-12`)⇒ **改名会让 ⑦-c 当场过期**。
  省一条 glob 不值得让一条已签字的结论失效。

#### 为什么挂 `Diff guards`(逐 job 实测触发条件,不是凭印象挑落点)

| job | job 级 `if` | 带 `docs_only` 的 step |
|---|---|---|
| `fast`(Fast checks) | — | Lint · Typecheck · Build · Run unit tests |
| `slow`(Contract + E2E) | `docs_only != 'true'` | — |
| `journeys`(Golden journeys) | `docs_only != 'true'` | — |
| `harness-selftest` / `harness-replay` | — | — |
| **`redzone-scan`(Diff guards)** | **—** | **—** |

`redzone-scan` **无 job 级 `if`、无 `needs`、每一步都不带 `docs_only`** ⇒ docs-only 的 PR 上照跑;
而 required context `Lint / Typecheck / E2E`(job `gate`)的 `needs` 含 `redzone-scan`、
`scan != success` 时逐字拒绝放行 ⇒ **这一步红,PR 就合不进来**。
接线**不带 `|| true`**(带上等于把刚接的执行位当场拆掉 —— 被 `|| true` 兜住的脚本根本不会失败)。

⚠️ 全量 `pnpm cutover:check` **仍然不接**:十条里今天还有必不过的(9a 尚有 `it.todo`、
⑩ 要部署侧产物),接了等于全仓永久红,而「闸红了没人消费 = 没有执法」是本仓已记录的事故形状。
接 CI 的只有 `--signoff` 这个**子集**;`assertSubIdsClosed()` 仍只在全量里跑。

#### 变异对拍读数(两维各自成一个控制项)

**① 执行位真的通了 —— 改签字里的对拍值 ⇒ 那一步红**(CI 该步跑的就是这条命令,本机逐字复刻):

```
基线                                   pnpm cutover:check:signoff  → EXIT=0(1.9s)
把 ⑨-b 的 `scale-tiers-passing` 从
  `30,500,2000` 改成 `30,500`          pnpm cutover:check:signoff  → EXIT=1
    ✗ 签字登记表完整性 + 逐条对拍
        · 9b:❗签字与机器读数矛盾:「scale-tiers-passing」签字当时记 30,500,机器现读 30,500,2000
    ✓ 机器现读非退化            ← 未被牵连
    ✓ ⑨-c 规模档登记表闭合       ← 未被牵连
还原                                   pnpm cutover:check:signoff  → EXIT=0
```

**② 收编真的生效了 —— 改 `scripts/cutover-check.ts` 而不带授权 ⇒ 被拦**
(令牌里只有 `harness/redzone.json` 与 `.github/workflows/ci.yml` 两条,没有它):

```
收编前  Edit scripts/cutover-check.ts        → exit 0(放行)
收编后  Edit scripts/cutover-check.ts        → exit 2 ⛔ 执法层(裁判保护)· 命中规则 enforcement-layer
收编后  Bash perl -pi … scripts/cutover-check.ts → exit 2(bash-write-guard 同拦,绕道无效)
反面   Edit scripts/changelog-merge.ts       → exit 0(同目录非裁判脚本仍自由 ⇒ 不是一律 fail-closed)
反面   Edit scripts/cutover-checks.ts        → exit 0(多一个字母的近名 ⇒ 这条 glob 是具名精确,不是前缀)
正面   Edit harness/redzone.json             → exit 0(有令牌 ⇒ 授权通路本身没坏)
```

**③ 顺序控制项(复刻 `P4a ci-guard-coverage` 的判据体)**:

```
ci.yml 已接闸 + redzone 已收编(本 PR 终态)  unprotected = []
ci.yml 已接闸 + redzone 未收编(顺序反了)    unprotected = ["scripts/cutover-check.ts"]  ← 上一条 lane 被拦的那条读数
```

#### 🔴 光「接上」不够 —— 还要防它被悄悄拆掉

P4a 只判「被 CI 引用的裁判必须受保护」,对**反方向**结构性失明:把 ci.yml 那一步删掉
⇒ 没人引用 ⇒ `unprotected = []` ⇒ **P4a 照样全绿**,而登记表当场回到零执行位。
这与本仓同日已逮到的两例同类(`#1184` 豁免名单指着已删文件、`#1195` 腐烂检测改成恒返回空):
**检查只管「有没有做错」,不管「有没有被拆掉」。**
故在 `harness-guards.selftest.ts` 另立两条**禁止型**断言(步骤必须在 · 不得带 `|| true`)。

⭐ 第二条刻意**不**写成债务棘轮那种 `line !== undefined && !line.includes('|| true')`:
那种形状下「删掉步骤」会把两条一起打红、红集相交,「加了 `|| true`」这一维的判别力观测不到
(「加了但恒不失败」比整步删掉更隐蔽 —— 空开关)。改成「不存在同时含命令与 `|| true` 的行」后,
删步骤时它空真为绿 ⇒ **两维各红各的**:

```
mutation 生效自证: M1 长度差=83  M2 长度差=8   (0 = 变异没写进去,读数作废)
基线(本 PR 终态)              断言① 已接进 CI = 绿    断言② 无 || true = 绿
M1 删掉 ci.yml 那一步          断言① 已接进 CI = 红    断言② 无 || true = 绿
M2 给那一步加上 `|| true`      断言① 已接进 CI = 绿    断言② 无 || true = 红
```

#### 🔴 诚实标注

- **「step 红 → job 红 → gate 拒」这一环是读 workflow 定义确认的,不是观测到的真 CI run**
  (变异 commit 不能与交付分支共用 SHA —— 会作废红区批准,且有被 cancel 顶成 BLOCKED 的事故在案)。
- **权威红区裁判 `redzone-trusted.yml` 跑 base 定义** ⇒ 本 PR 它只标 `redzone.json` + `ci.yml`,
  **不标 `scripts/cutover-check.ts`**(base registry 里还没有它)。这是预期,收编自**下一个** PR 起对 trusted 侧生效。
- 本机未跑 `harness:selftest` / `harness:replay` / e2e;P4a / F4 / 禁止型两条**全部复刻取证**,
  最终裁决交 CI 的 `Harness selftests` job。

#### 顺带清掉的四处「散文与机器矛盾」

`CUTOVER_SIGNOFF.md` §3.1(「今天没有执行位」→ 现状 + 当天实测留档)·
`docs/ai-harness/README.md` 两处(`Diff guards` 那行写死的「**三条**」改成不写死数字 +
§4 那格的「🔴 它今天没有执行位」)· 上一刀的 fragment `cutover-scale-gate.md` 两处
(否则归并进 CHANGELOG 时会发出一句假话)· `scripts/cutover-check.ts` 头注那句
「哪天把它接进 CI 必须同步写进 selfGuard」——**趁它还在自由区先改**,收编后本地就写不动了。
