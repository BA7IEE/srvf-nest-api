# docs/handoff — 前后端交接层(派生 · 指针优先 · 双向)

> **这是给 AI / 人看的"对接说明",不是契约副本;本目录是全部前端(admin 后台 / 小程序 / 招新 H5)对接文档的唯一家(canonical)。**
> 后端是 SRVF 各前端的 API 真相源;本目录把"契约表达不了的东西"补上,并把前端的需求/缺口反向登记回来。
> 前端各仓只留指针、不各自维护对接事实(§5);历史上姊妹仓自建 guide 靠人肉同步常遗漏,2026-07-17 起归一至此。

---

## 0. 一条铁原则(否则这层会变成会烂的第三事实源)

**机器能自校验的东西,永远以后端生成物为准,本目录只引用、不手抄:**

| 你要什么 | 权威源(live / 机器校验) | 本目录做什么 |
|---|---|---|
| 端点清单 / 入参出参 / 字段 | **`/api/docs-json`**(live)· `test/contract/openapi.contract-spec.ts` 的 `EXPECTED_ROUTES` | 不复制;只在能力图里引用端点名 |
| RBAC 权限码(总数见 [`current-state.md §1`](../current-state.md)) | [`docs/ai-harness/RBAC_MAP.md`](../ai-harness/RBAC_MAP.md) · 各端点 `[rbac: x]` summary | 不复制;能力图里写"用哪个码门" |
| 当前版本 / surface 状态 / 债务 | [`docs/current-state.md`](../current-state.md) | 不复制 |

**本目录只放契约表达不了的这几样**(需要人/AI curate、且不会被 contract 测出来的):
1. **任务→端点图**(capability-map):某个页面/任务该调哪几个接口、按哪条轴下钻;
2. **踩坑表**(gotchas):登录几步走、令牌双计时器、贡献值别裸 SUM、字段以 docs-json 为准等对接陷阱;
3. **缺口台账**(gap-ledger):前端缺什么、是否已出 goal、是否已发——双向请求簿。
4. **契约版本回执**([`contract-version-registry.md`](contract-version-registry.md)):各端**编译时**用的是哪一版契约。
   这项后端**自己查不到**(四个前端在别的仓库、别的部署),只能由各端回执 —— 正是「契约表达不了」的典型。

> 字段级真相永远是 live `/api/docs-json`。本目录若与之冲突,**以 live 为准**,并回来修本目录。

---

## 1. 文件与读者

| 文件 | 给谁 | 内容 |
|---|---|---|
| [`admin-web.md`](admin-web.md) | `srvf-admin-web`(PC 管理后台,Vue3 + pure-admin,私有仓) | 轴模型 + 任务→端点图 + 踩坑(§3;**登录/令牌接线 §3.1 为全端通用节**)+ 缺口台账 + IA 建议 |
| [`miniapp.md`](miniapp.md) | 小程序前端(仓未建,占位)+ **招新 H5(`srvf-h5`,消费其中 `open/v1` 招新链)** | App surface(`/api/app/v1/*`)模型 + 能力图 + H5 无账号链 + 缺口台账 |
| `openapi.json` | 离线/版本审查用 | 从 live 导出的**便利快照**(非真相;真相是 live `/api/docs-json`) |
| [`contract-version-registry.md`](contract-version-registry.md) | 维护者 + 各前端仓 | 合同 §16.1 ⑤「五端同一 contract version」的**回执落点**:各端填自己编译所用版本,`cutover:check` 5b 据此点名谁没回执 / 谁对不上 |

刷新 openapi 快照:**`pnpm docs:openapi`**(离线生成 —— 在进程内建 Nest 应用直接导出文档,
**不监听端口、不连数据库**,约 8 秒)。新鲜度由 `pnpm docs:openapi:check` 在 CI 守护:
契约改了而本快照没刷新 → CI 红,并打印新增/消失的路径。

> 旧命令 `pnpm docs:handoff:openapi` 已删除。它是 `curl http://localhost:3000/api/docs-json`,
> 要求先手动把 dev server 跑起来 —— 于是 :3000 被别的 worktree 的旧 server 占着时,
> 会**悄无声息地导出另一个分支的契约**(HTTP 200、JSON 合法、文件看着正常)。
> 错误结果长得像正确结果,是最难发现的一类。
快照入 git 的好处:改契约的 PR 里 openapi.json 出 diff → reviewer 一眼看见契约变了。

**前端仓地图(谁读哪篇)**:`srvf-admin-web` → admin-web.md;`srvf-h5`(招新 H5:报名/身份证 OCR/进度/撤销)→ miniapp.md 的 `open/v1` 各行;小程序(未建仓)→ miniapp.md;规划仓 `SRVF/05·06` 两文件夹是人看的协调空间(已是指针页,不承载事实)。各前端仓入口文件(CLAUDE.md 等)应带"对接前必读 → 本目录对应篇"指针,指针的增补/纠偏由维护者线下做(本仓 AI 不写姊妹仓)。

---

## 2. 变更触发对照表(反漂铁律逐行版)

> 总则(已写进 [`AGENTS.md`](../../AGENTS.md) 权威源表):**改 API surface / RBAC / 契约 → 同一个 PR 内更新本目录受影响处,并刷新 `openapi.json`**。
> 下表把"后端改什么 → 必须动哪篇哪节"落到逐行;开契约类 PR 时照表自查,`srvf-fe-be-handoff` skill 会把会话引到这里。

| 后端改了什么 | 同 PR 必改(本目录) | 同 PR 另核(目录外,多有守护) |
|---|---|---|
| **auth 契约**(login / refresh / token 语义、auth 错误码) | [`admin-web.md §3.1`](admin-web.md)(登录/令牌接线,全端通用)+ §3 踩坑 #1(3-call);[`miniapp.md §1.1`](miniapp.md) | `reference/auth-jwt-refresh.md`(P0-E 冻结,动它先过决策锁);openapi.json |
| **RBAC 码 / 绑定语义**(新增、摘除、换绑、派生角色) | admin-web.md 受影响能力图行的 `[rbac:]` 标注 + §2.6 落地进度与提示文案;影响 App 能力时 → miniapp.md capabilities 相关行 | `RBAC_MAP.md`(`docs:rbacmap:check` 守护)+ current-state §1 计数(`docs:counts:check`);openapi.json(summary 变) |
| **新增 / 删除端点** | 对应能力图(admin-web §2.x / miniapp §2);若答某缺口 → 对应 gap-ledger 行标「已发」 | openapi.json 刷新;`EXPECTED_ROUTES` 显式登记(contract spec 自带断言) |
| **DTO 字段(additive)** | 仅当带对接语义(新开关 / 新展示口径 / 新过滤参数)才补对应行;纯字段不抄(字段真相在 docs-json) | openapi.json 刷新 |
| **DTO 字段(breaking)/ 行为变更** | 对应行加 **⚠️ 行为变更** 注记(旧客户端后果 + 适配点);admin / miniapp 两篇**都**查一遍(如 submit 收紧同时打 H5 与小程序) | openapi.json;CHANGELOG 置顶 ⚠️ 清单(process §3) |
| **BizCode 新增 / 语义变** | 对应能力图行的错误码提示(miniapp 失败码注记、admin 按钮文案分支如 22074/22075) | current-state §1 计数;openapi.json(错误枚举描述) |
| **App surface 准入 / scope 语义** | miniapp.md §1 模型五条 | `api-surface-policy.md`(红区文档,需授权) |
| **通知类型 / 字典项**(影响前端图标/文案分支) | admin-web.md §2.5 + miniapp.md 通知两行 | seed 字典走 D 档流程 |

release 收口(E 档,`srvf-release-closeout` 九阶段)末尾再统一核一次:**openapi 重导(`info.version` 须等于新版本号)+ gap-ledger 标"已发" + 按本表抽查**。

> **刷新记录(2026-07-28,v0.62.0 release true-up)**:`openapi.json` 已用 `pnpm docs:handoff:openapi` 从当前 live `/api/docs-json` 重导；`info.version=0.62.0`、314 paths / 416 operations。除版本号外，本次同步补齐当前代码已存在的 RoleBinding `scopeInactive` schema/required 契约及失效/不存在 scope 的 17031/11001 错误响应细节；同日 content signed URL 契约 true-up 将 `ContentAttachmentDto.url` 与 admin/read 的 4 个 `coverImageUrl` 从 nullable object 校准为 nullable string，运行时字段与行为不变；paths / operations 数均不变。

> **v0.59.0 基础设施说明(D-Throttle)**:10 个命名 throttler 的计数从每进程 Map 改为 PostgreSQL shared storage；IP/路由 key、阈值、TTL、blockDuration、42900 与无 header 契约逐字不变，前端无需适配；该交付切片因此没有单独产生 OpenAPI 契约差异。

---

## 2.5 生成的 TS client(`clients/`,派生物,禁手改)

> **字段真相仍以 live `/api/docs-json` 为准。** 本目录的 client 是从 `openapi.json` 快照派生的**便利产物**,
> 与 §0 铁原则一致:机器能自校验的东西以后端生成物为准,这里只生成、不手抄、不当第二事实源。

**六个 surface 全覆盖**(2026-08-30 Integration Foundation v1 PR6 true-up):部分生成 = 剩下那部分回到手写,
等于亲手制造第二份真相 —— 而消灭第二份真相正是本目录 §0 铁原则要的东西。

| 产物 | 内容 |
|---|---|
| [`clients/shared/`](clients/shared/) | 跨 surface 共用类型的**唯一定义处**:`ApiEnvelope<T>` / `PageResult<T>` / `FetchRequest` / `Fetcher` + 被 ≥2 个 surface 引用的 DTO |
| [`clients/admin/`](clients/admin/) | Admin 管理后台(`/api/admin/**`) |
| [`clients/app/`](clients/app/) | App 小程序(`/api/app/**`) |
| [`clients/auth/`](clients/auth/) | 登录 / 令牌(`/api/auth/**`)—— **admin 与 app 都引它**,不各自复制一份 |
| [`clients/system/`](clients/system/) | System 系统面(`/api/system/**`) |
| [`clients/open/`](clients/open/) | Open 无账号公开面(`/api/open/**`,招新 H5 消费) |
| [`clients/integration/`](clients/integration/) | Integration 外部系统面(`/api/integration/**`;产物不内置任何凭证) |

每个 surface 出 `types.ts` + `client.ts`,共用类型从 `../shared/types` 引入并再导出 ——
**消费方仍只需 import 一个 `./types`,但仓内每个类型只有一份定义**(零重复由 selftest 机核)。

**每份产物头部带 `// contractVersion: x.y.z`** —— 引入 client 的仓库在自己那边
`grep -r contractVersion` 就能答出「我编译在哪一版契约上」,不需要后端配合、不需要后端已部署。
该值**派生自** `openapi.json` 的 `info.version`(不是新的版本声明:真源恒为三处,见
`pnpm cutover:check` 的 5a),且 `info.version` 就在 `inputDigest` 的输入闭包里 ⇒
**戳与真源脱节在结构上不可能**:改了版本没重新生成,`docs:feclient:check` 当场逐字对不上。
各端把这个值填进 [`contract-version-registry.md`](contract-version-registry.md),
即为合同 §16.1 ⑤ 的回执。

刷新:**`pnpm docs:feclient`**;新鲜度由 `pnpm docs:feclient:check` 在 CI Docs guards 同链守护
(契约改了而 client 没刷新、或产物被手改 → 当场红)。

**产物边界(刻意很窄)**:

- 只有**类型与调用签名**。**不含 baseURL、不含令牌、不含任何鉴权逻辑** —— 传输层由消费方注入一个
  `Fetcher`,登录态怎么带、令牌怎么刷新全在前端仓自己手里(三步登录接线见 [`admin-web.md §3.1`](admin-web.md))。
- `code/message/data` envelope 与分页形状按仓内既有契约表达为 `ApiEnvelope<T>` / `PageResult<T>`。
- 头部带确定性 `inputDigest`,**不含时间戳/git SHA**(治理登记表元规范:时间戳会让逐字比对恒假红)。
- **六个 surface 全生成**,无手写补充面。`auth` 单独成一份而不是往 admin/app 各塞一份:
  它两边都要调,复制就是两份各自演化的定义。

用法示意(消费方自备 fetcher,凭证不经过本产物):

```ts
import { createAdminClient } from './clients/admin/client';

const client = createAdminClient(async (req) => {
  const res = await fetch(myBaseUrl + req.path + toQuery(req.query), {
    method: req.method,
    headers: { ...myAuthHeaders() },        // ← 令牌由前端仓自理,产物里没有它
    body: req.body ? JSON.stringify(req.body) : undefined,
  });
  return res.json();
});
const { data } = await client.getMe();
```

## 3. 双向怎么用

- **后端 → 前端**:改了能力 → 照 §2 对照表更新 admin-web/miniapp 能力图 + 刷 openapi;前端据此对接。
- **前端 → 后端**:前端发现"想做的任务后端没接口" → 在对应文件的 **gap-ledger 登记一行**(诉求 / 涉及任务 / 期望端点);维护者据此决定出不出 goal。goal 出了/发了 → 回来更新这行状态。
- **漏账警示**:前端仓文档里出现「后端缺口候选」而不回本台账登记 = 漏账(2026-07-17 归一即从 srvf-admin-web 蓝图 §10.4 补登 GAP-009/010,识别与登记之间漂了 11 天)。

## 4. 对接增量的生命周期

发版前的契约增量可先在本页挂「Unreleased 对接增量」节;**随发版把版本号钉上、内容并入两篇正文,不留常驻 Unreleased 节**(两篇正文内的历史 Unreleased 标注同理,应随发版 true-up 为版本号)。已流转完毕的增量:活动参与度量/批量审批(审计刀 5 → **v0.51.0**;见 admin-web §2.1–§2.3/§2.7、miniapp §2)· 活动评价 F2–F4(→ **v0.54.0**;见 admin-web §2.1、miniapp §2.3)。

## 5. 维护协议(谁在什么时候动这里)

| 角色 / 时机 | 动作 |
|---|---|
| 契约类 PR 作者(任何 lane) | 照 §2 对照表**同 PR** 更新受影响处;拿不准归哪行 → 宁可两篇都查 |
| release 收口会话(E 档) | 九阶段末尾统一核:openapi 重导 + `info.version` 对版本号 + gap-ledger 标"已发" |
| 前端各仓 | **只留指针不复制事实**;仓内手抄的后端快照数字(版本号/权限码数/路径数)一律视为过期装饰,以本仓 current-state 与 live docs-json 为准 |
| 维护者 | 跨仓指针的增补/纠偏线下做(本仓 AI 不写姊妹仓);前端反馈的缺口核入 gap-ledger 并决定出 goal |

本 README 自身只做索引 + 协议页,不承载能力图与契约事实。
