### 生成物刷新顺序:把口口相传的口诀换成**实测出来的依赖图** + 一次性全刷入口(P2-18)

2026-08-24 一天之内,同一形态复发 **7 次** —— 改了源、只刷了一部分生成物,剩下的到 CI 才红:

| # | 触发 | 当时的读数 |
|---|---|---|
| ① | 改 catalog 一行中文字符串 | 两份生成物过期 |
| ② | 改 DTO 文案只刷了 openapi | 三份过期 |
| ③ | 刷完 contract 快照没刷下游 | 三份过期 |
| ④ | v0.68.0 发版脚本刷版本号 | 两份过期 |
| ⑤ | PR 8 刷完生成物又改 catalog | authz 过期 |
| ⑥ | 改 `src/modules/**/CLAUDE.md` | 当时判成 authz 过期 |
| ⑦ | v0.69.0 发版脚本刷版本号 | 两份过期(这次是预判到的,不是被 CI 抓到) |

顺序既不在机器里、也不在文档里,只活在每次简报的口头提醒里:「顺序是 openapi → clients → authz → codemap」。
本刀先把那句口诀**当成待验假设去测**,而不是当成规格去实现。

#### 🔴 那句口诀经实测有**两处错**

1. **`docs:authz` 与 `docs:codemap` 根本不在 openapi 的下游。** 实测把 `docs/handoff/openapi.json`
   改坏,这两条守护纹丝不动 —— 只有 `docs:openapi:check` 与 `docs:feclient:check` 变红。
   它们之所以常常跟着一起红,是因为**它们和 openapi 共用上游 `src/`**:同源,不是串联。
2. **④/⑦ 的归因错了。** 发版刷版本号动的是 `src/bootstrap/apply-swagger.ts` 的 `.setVersion(...)`,
   而 `generate-authz-manifest.ts` 的 `inputDigest` 覆盖 `src` 下全部 `.ts` ⇒
   **它红是因为 `src/` 变了,不是因为 openapi 变了。**(这一条是起草方自己先怀疑、本刀实测坐实的。)

🔴 固化一个错的顺序比没有入口更糟:它让人以为「跑了这个就齐了」,而漏刷的那份要到 CI 才发现且更难归因。

#### 实测出的图形状:不是一条链,是**一棵共源的树**,只有一条真边

```
                    ┌──────────────┐
       src/  ──┬───▶│ docs:openapi │──▶ openapi.json ──▶ docs:feclient ──▶ clients/
               │    └──────────────┘        ⭐ 全仓唯一一条生成物→生成物的边
               ├───▶ docs:authz    ──▶ ROUTE_AUTHZ.md + authz-assertion-patterns.json
               ├───▶ docs:codemap  ──▶ CODEMAP.md
               ├───▶ docs:rbacmap  ──▶ RBAC_MAP.md 生成段
               └───▶ docs:counts   ──▶ current-state.md 计数块
```

六个刷新器里,**只有 `docs:feclient` 读别人的产物**(实测它一个 `src/` 文件都不读,只读 `openapi.json`)。
其余五个共用上游 `src/`,**彼此无序**。
⇒ **真缺陷不是「顺序记错」,是「改了 `src/` 却只刷了一部分」** —— 该做的是「一次性全刷」而不是「按序刷」。

#### ⭐ 那条唯一的边为什么会咬人:**上游没刷时下游守护是假绿**

改一个 DTO 字段,逐段实测读数:

| 阶段 | `docs:openapi:check` | `docs:feclient:check` |
|---|---|---|
| 只改了 `src` 的 DTO | **红** | 绿 ← ⭐ **假绿** |
| 跑完 `pnpm docs:openapi` | 绿 | **红** ← 这时才看得见 |
| 再跑 `pnpm docs:feclient` | 绿 | 绿(clients 实际改了 23 行) |

⇒ **「把全部 `docs:*:check` 跑一遍、把红的刷掉」在一趟里必然漏一轮** —— 这不是谁不小心,
是结构使然:feclient 在 `openapi.json` 刷新前**不可能**看见源码改动。7 次复发的机制就是这个。

#### 两种新鲜度机制(混为一谈会误判)

- **字节 digest 型**(`docs:authz`):`src` 下任一 `.ts` 改一个字节就红,**哪怕产物根本不会变**。
- **重生成比对型**(其余五个):产物真的会变才红。

实测对照:同一文件**加一行**注释 ⇒ authz 红 + codemap 红;**等行数**原地改注释文字 ⇒ **只有 authz 红**。

#### 顺带否掉两个说法

- ❌ **「`.md` 躺在 `src/` 里照样进 `inputDigest`」** —— `sourceFiles()` 只收 `.ts`。
  实测给 `src/modules/members/CLAUDE.md` 追加一行 ⇒ **八条守护全绿**。⑥ 那次的归因要另找。
  (`src` 下的 `CLAUDE.md` 确实被 `docs:readtax:check` 与 `check-codemap.ts` 读,但前者只量字符预算、后者只查存在性。)
- ❌ **「`*.spec.ts` 也算」** —— 实测给 `member-grade.spec.ts` 追加一行 ⇒ 全绿。

#### ⚠️ 顺带钉住一条边界:**一致性 ≠ 正确性**

全部 `docs:*:check` 判的都是「生成物与源同步没同步」,**不是「源里该不该有这东西」**。
源里多一个假字段、而生成物正确地跟着更新了 ⇒ **八条守护一条都不会红**。
⭐ 尤其阴的形状是**给 DTO 加一个可选字段**:不改端点数、不改权限码、不改路由,
`docs:counts` 的 9 个计数 / `ROUTE_AUTHZ` 端点数 / `EXPECTED_ROUTES` **没有一个会动**(假 controller 会被端点数抓到,这个不会)。

⇒ 方法论上收敛成一句:**变异对拍的最后一步不是「把读数记下来」,是「确认树回到了变异前」** ——
读数与还原是两件事;且多 lane 并行下,探针在树里的那段窗口别人也看得见
(本刀实测踩过:总控在 M2/M3 阶段查树抓到了正在生效的探针,脚本收尾时已逐字节还原,
事后全仓 `grep -ri` 命中 0、两个 commit 全路径 diff 命中 0)。

#### 交付:`scripts/refresh-generated-docs.ts`(短名 `pnpm docs:refresh`)

刻意**不是**「把口诀写成脚本」:

- 刷新集合从 `package.json` **现算**,不在脚本里维护第二份名单;
- 只登记**实测出来的那一条**边(`docs:feclient` after `docs:openapi`),其余不排先后;
- **不跑任何 `docs:*:check`** —— 刷新与校验是两件事,刷完再校验必绿是同义反复;
- **不刷 contract 快照**(要连库起 Nest,且盲 `-u` 在 deny 清单里)、**不刷 service 尺寸基线**(棘轮,整体重算会自动放宽上限);
- **不接 CI** —— 执法恒是 Fast checks 里的 `docs:*:check`。

两条自证(**树是干净的时候也照样能失败**),各做过变异对拍:

| 自证 | 防什么 | 变异 | 读数 |
|---|---|---|---|
| ① 登记表 ↔ `package.json` 双向比对 | 新加一条 `docs:*:check` 却忘了登记 | 删掉 `docs:counts:check` 那一行 | exit 1,点名 `docs:counts:check` |
| ② 跑两趟,第二趟必须零改动 | 存在没登记的依赖边(下游先于上游跑) | 删掉 `after` 边并把 feclient 排到 openapi 前 + 一个真会传播的 src 改动 | exit 1,点名 4 份 client 文件 |

反向对照(边补回来 + **同一个** src 改动)⇒ exit 0,且探针字段确实进了 `clients/admin/types.ts`(证明不是空变异)。
干净树上整跑 **32.7s**(含两趟),`git status` 零改动。

#### 取证方法(三法交叉;单用一种会漏)

1. **运行期 fs 追踪** —— `--require` 预加载包住 `fs.*` / `child_process.*`,记录每个生成器**真正打开**了哪些文件。唯一能穷举输入面的一种。
2. **扰动矩阵** —— 逐类改一个输入(`src` 的 `.ts` / `.spec.ts` / `.md`、生成物本身),八条守护逐条记红绿。
3. **读常量** —— 读每个生成器的 `OUT` / `CONTRACT` / `sourceFiles()` 定义。
   ⚠️ **只用第 3 种会失败**:多数 `readFileSync` 读的是变量(起草方先前试过 `grep readFileSync`,推不出来)。

顺带订正两处旧读数:`docs:*` 的刷新器是 **6 个不是 7 个**(`docs:boundaries` 是报告态,实测 WRITE 0 条、不产出任何生成物);
`generate-openapi.ts` 头注自称「零数据库」**属实** —— 它的 `DATABASE_URL` 默认值指向 `127.0.0.1:1`,
本机 Postgres 正在 5432 上跑的情况下 `--check` 照样通过。

图与取证方法登记在 [`docs/ai-harness/README.md`](docs/ai-harness/README.md) §1.7。
