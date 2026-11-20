# T59 真正独立只读审查

**总判定：NOT_ACCEPTED（流程缺口／未验收）。** #1448 于 2026-11-20 19:17:50 北京时间合并。合并前只有开发主会话内的 `review_convention` 核对，缺少未参与实现的独立会话对当时 PR head 出具的结论。本次由 `01a1f37a` 在合并后审查，时间顺序不能补回。就内容而言，六项约定均能在正文定位，两张 Issue 均有按自身范围标记 completed 的依据，另 46 项仍开放。[PR #1448](https://github.com/BA7IEE/srvf-nest-api/pull/1448) · [当前流程缺口记录](process-gap.md)

## 合并、检查与审查身份

独立工作区 HEAD 为 `dede3ec9c43ac76a50e57426250dc8b060b595f4`。GitHub 返回的两个父提交为原 main `abeca9a9de857ba414dcda4e0c117bd2f576aa5d` 和 PR head `cfb53e8b4b6750634f694c441f7362e3173eb24e`。PR head 与合并提交的 tree 同为 `2fd66883f2c7b6ed9433679afc21e06e7421023d`。相对原 main，实际只改两份 Markdown，增加 11 行、删除 1 行。[合并提交与差异](https://github.com/BA7IEE/srvf-nest-api/commit/dede3ec9c43ac76a50e57426250dc8b060b595f4)

PR 检查绑定 `cfb53e8b`，四个必需检查成功，单独的 `Red-zone trusted approval` 为 SKIPPED。GitHub 的 PR reviews 列表为空；关于同会话核对的归属，另有开发落地记录和调度的缺口记录相互印证。合后 run `44726436000` 由 push 到 main 触发，绑定 `dede3ec9`，5 项成功、3 项跳过。开发落地记录、处置表末段和开发 lastmsg 中的“独审通过”均不能作为合并前真独审的凭据。[PR head CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44726011004) · [合后 main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44726436000) · [开发落地记录](/private/tmp/srvf-t59-t35-convention-landing.md)

## t35 六项约定

逐项比对原调度要求与固定版本 `docs/process.md`。六项均已写入当前正文，`docs/WORKING-STATE.md` 第 5 行指向同一章节。[原要求](/Users/dengwang/Documents/srvf-handoff-evidence/srvf-codex-resume-t59-t35-issuepr-prompt-20261120.txt) · [流程正文第 17–22 行](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/docs/process.md#L17-L22) · [交接入口](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/docs/WORKING-STATE.md#L3-L8)

| 行 | 对照结果 |
|---|---|
| 17 | 每项有范围、完成条件和一位跟到集成收尾的负责人，后续消息默认补充原目标。 |
| 18 | 独立任务可按收益并行，先查依赖、在跑任务、负载及限额。主、子会话合计并发，代码用独立工作树，共享资源有唯一写入负责人。 |
| 19 | 锁限于登记的任务和资源，先核持有者并保留在跑任务。生产只读核查优先，确认独立的清单与方案工作可以并行。 |
| 20 | 连续工作复用原会话，交接保留目标、版本、决定依据、未验项及下一步，大日志给出位置。 |
| 21 | 自测后由未参与实现者按精确版本看差异与行为，复核失败时保留断言。正文表达了独立性，但没有明写“同一开发主会话换名不算、结论不得预写”，也未要求在合并前留下可核对的独审记录；本批正好暴露了这个执行缺口。 |
| 22 | 集成负责人固定配对、补验受影响流程及所需现场行为，分别登记代码、合并、部署和验收。延期须有负责人、原因与恢复条件。 |

在所查仓库当前流程、交接入口与本机有效检查点中，未见仍要求“全项目单 Codex 串行”的规则。现场两份互斥文件逐字节相同，复核时 `do_not_start_second_codex=false`，并已分别登记 T59 审查与 T60 任务。开发记录里的旧布尔值属于较早时点。[本机互斥状态](/private/tmp/srvf-mac-mutex-checkpoint.json) · [当前交接记录](/Users/dengwang/Documents/coding/srvf-nest-api/tmp/srvf-handoff-checkpoints/current/t58-t35-execution-landing.md)

## 两张已关 Issue

**#1419：支持 completed，限默认 JSON 解析器超限错误。** 原单是向 `POST /api/admin/v1/contents` 发送约 1 MB 时得到 500/50000，要求超限按客户端错误处理。#1420 已进入运行过的 `108feebb84b85c7e4955c5af8bbfc016702e4529` 及本次合并树。两版的全局解析配置、异常过滤器分别具有相同的 Git blob。单独放宽至 32 MiB 的解析器只覆盖两个更正写入路径；原 contents 与探针 auth/login 都走默认解析。过滤器单测覆盖超限映射及未知异常仍返 500，PR 原生日志有该 spec 的 PASS。[原单](https://github.com/BA7IEE/srvf-nest-api/issues/1419) · [解析器范围](https://github.com/BA7IEE/srvf-nest-api/blob/108feebb84b85c7e4955c5af8bbfc016702e4529/src/bootstrap/apply-global-setup.ts#L13-L45) · [映射与负例](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/src/common/filters/all-exceptions.filter.spec.ts#L23-L53)

T21 宿主桥接回执记录同一探针路径 102,504 字节 → **413/40000**，49 字节 → **404/40400**。本地两份探针脚本 SHA-256 与固定回执相符。脚本捕获 HTTP 错误后正常退出，故判断取自状态码和业务码，单看 exit 0 无法区分成功与失败。小包 404 也只证明绕过了大小拒绝。本次未重发原 contents 请求，没有该路由约 1 MB 的逐请求现场回执；足以关闭的是默认解析层缺陷，未验收内容写入或新版部署。GitHub 读回 19:17:10 CLOSED/COMPLETED，早于文档 PR 合并。[固定桥接回执](https://github.com/BA7IEE/srvf-nest-api/blob/0411a4ecd0348f5311228cca4fb17c7f446e8e9e/docs/ops/verification/t21/1419-public.json) · [关单回执](close-1419.json)

**#1109：支持 completed。** 原单限定纯文档 PR 漏跑读取文档的五个单测。现行工作流的 Unit tests 直接执行 `pnpm test`。我读取了纯文档 PR #1448 的原生 job `136253572232` 步骤和日志，Cold lint、Typecheck、Build 跳过，Unit tests 成功，以下五个 spec 逐条出现 PASS。GitHub 读回 19:18:15 CLOSED/COMPLETED。证据直接覆盖 CI 的缺陷，不涉及部署验收。[原单与五个文件](https://github.com/BA7IEE/srvf-nest-api/issues/1109) · [工作流](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/.github/workflows/ci.yml#L95-L100) · [原生 job](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44726011004/job/136253572232) · [关单回执](close-1109.json)

- `activity-business-overhaul-acceptance`
- `notification-canonical-docs`
- `cos-production-sop`
- `activity-v11-outward-list-pagination`
- `activity-v11-coordinate-negative`

## 48 项处置及生产边界

按仓库、条目类型、编号和原始 URL 重算，T58 的 49 项仅减去 19:08:54 已合并的 #1442，恰为表中 48 个唯一条目。2 个 must-close、20 个 defer、26 个 retain。直接与 GitHub 开放集合核对，后端 27 Issue、17 PR，Admin 2 PR，Mobile 0 项，46 个 URL 全部吻合。两张关闭回执的编号、时间和原因也与 GitHub 一致。[T58 起始清单](/private/tmp/srvf-t58-issue-pr-inventory.json) · [48 项处置表](issue-pr-disposition.md) · [#1442](https://github.com/BA7IEE/srvf-nest-api/pull/1442)

逐行均有后续归口、处置原因、证据与复核说明。已关两项写关闭依据；其余 46 项写了触发条件或待补的验收证据。部分延期项只给验收条件：例如 #929 写待补失败留痕、防篡改及留存的端到端证明，没有单列何时启动。抽查中，#1430 明确到“主干 2,000 人用例再失败一次”，#1416/#1417 仍待目标环境相应分支回执，#934 保留迁移恢复演练，Admin #171 保留与真实接口联验。未见把待部署事项关成 completed。[#929](https://github.com/BA7IEE/srvf-nest-api/issues/929) · [#1430](https://github.com/BA7IEE/srvf-nest-api/issues/1430) · [#1416](https://github.com/BA7IEE/srvf-nest-api/issues/1416) · [#1417](https://github.com/BA7IEE/srvf-nest-api/issues/1417) · [#934](https://github.com/BA7IEE/srvf-nest-api/issues/934) · [Admin #171](https://github.com/BA7IEE/srvf-admin-web/pull/171)

T58 对合并窗口线上版本的强证仅及 **API 仍为旧镜像、Admin 已核入口未变**。Worker 在线版本、H5 在窗口内是否变化均为 **UNKNOWN**。PG 的 156 项来自当时目标库采样。#1448 两份文档和两次 GitHub 关单均未授予生产 DB 写入、共享 GRANT/B130、部署、开闸或公网切流权限。本审查只读 Git、GitHub 和既有材料，仅写本报告；生产连接、业务请求、迁移、授权、部署与切流均为 **NOT_RUN**。[人工边界](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/AGENTS.md#L53-L61) · [T58 证据](https://github.com/BA7IEE/srvf-nest-api/tree/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58)
