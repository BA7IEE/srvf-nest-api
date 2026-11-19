# T40 正式前端交付

**正式业务仓已收到 Draft PR #172，原生必需检查 verify 已通过。** HEAD 为 eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64，与 T39 隔离服务器验收的提交完全相同。独立审查可直接读取这个 SHA。[正式 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [原生 CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44561763088/job/135692656191)

## 六项同提交复审材料

1. **交付对象。** 维护者 t20u 已明确授权向现有公开业务仓提交。正式分支为 fix/simple-published-activity-review，base/main 为 6375148a61445972e792ce37cb401fd8e5162538。业务仓 GitHub compare 确认 ahead 2、behind 0，依次为 40ec9d7c0bc77cb6dc4a849071c081479e3cf055 和 eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64。沿用原始提交，无需变基或重写。操作使用独立 checkout；本机业务仓主工作树的 main 位于 6ec75ec4，本轮前后 git status 一致，原有未跟踪目录 .agents/、.codex/ 均保留。[正式仓固定差额](https://github.com/BA7IEE/srvf-admin-web/compare/6375148a61445972e792ce37cb401fd8e5162538...eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64)
2. **实际改动与影响。** 八个文件覆盖活动详情、已发布活动负责人变更、独立审核、API 适配和服务器浏览器回归。审核页检查冻结指标集及各项定义的摘要。负责人可以申请改标题或说明，审核人看到原值和新值，文本以外的未知差异阻止批准。继续使用后端已有的版本确认、判权和事务。GitHub 源码树、隔离验收树和 GitHub 当前 PR 合并预览树均为 43fbfef8080b7958d3a0ea448b521f749ac258a8。完整文件清单在 changed-files.tsv。仓库设置、AGENTS、workflow 和保护规则均无修改。[固定前端源码](https://github.com/BA7IEE/srvf-admin-web/tree/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64)
3. **本轮新增验证。** 正式业务仓 ci.yml 按 pull_request 事件运行。required check verify 返回 SUCCESS，gh run watch --exit-status 退出 0。守护自测、结构巡检、文档预算、冻结依赖安装、lint、格式零漂移、typecheck、build 全部通过。已从业务仓 Git 对象取回服务器驱动，应用 T39 的固定测试补丁，node --check 和逐字节比对均通过。所得 SHA256 为 d3abfc8445c52e74577e36bff559042ebafb21b585ba830ef8692a585f08f18c。T39 的五类组合扩展仍在原测试证据路径；业务仓工作流没有执行服务器 Chromium。[正式 CI 步骤](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44561763088) · [T39 回归补丁](https://github.com/BA7IEE/srvf-test-archive/tree/a9fa1c71f65c03d8b1d3c4278007cef619c619b2/t39)
4. **可复用的验收与复审。** 同一前端和后端已在隔离服务器用普通发起人与独立审核人验证 not_required、单必填布尔及五类必填的标题与说明变更。过期确认 409/20255，未配置指标 400/20174，审核人代提拒绝，残缺定义拦截批准。未配置负例沿用 T37；T38/T39 的两字段结果仅覆盖对应模板。本轮业务源码和联测产物均未变，复用已有证据。#172 正式仓独审待串行执行，开发会话未代审。[T37 实测](https://github.com/BA7IEE/srvf-nest-api/tree/f1e409d481a25dc9225cf84c2d18a6962e950b02/docs/ops/runtime-acl/t37) · [T38 实测](https://github.com/BA7IEE/srvf-nest-api/tree/805ccde613f808ba4fa2ab18e63eb687e7be35d8/docs/ops/runtime-acl/t38) · [T39 独审](https://github.com/BA7IEE/srvf-nest-api/blob/8902162a959e43cb442e044e500543fc3e2af507/docs/ops/runtime-acl/t39/independent-review.md)
5. **后端与门禁。** #1444 HEAD 复核为 713d3416830d897852929731ff7f9b638038ab7c。四项必需检查 Lint / Typecheck / E2E、Docker image build、Diff guards、Red-zone (trusted) 全部成功。实际运行的 14 项检查均成功，含五个 Contract + E2E 分片。单列的 Red-zone trusted approval 作业为 SKIPPED，不能作为人工批准。两份 PR 查询时均无待处理 review thread。后端审核详情按已授权申请读取 frozenMetricSets，Simple 提审在活动锁内比较 expectedDraftHash。单项批准条件仍取决于该操作的仓库和维护者门禁。[后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [固定后端源码](https://github.com/BA7IEE/srvf-nest-api/tree/713d3416830d897852929731ff7f9b638038ab7c)
6. **配对、回退与未运行项。** 已在 srvf 用既有只读脚本复核新静态清单、隔离镜像、当前公网镜像、四处上游、回退配置副本及 OpenResty 配置自检，exit 0。实测前端清单 SHA256 为 c8fd30a91ef5e37032afb47ceb188bf6b75c203bd37de894c07b4f82571cbb2d，后端镜像为 sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75。回退配对仍为前端 b7f3dac00a860e32c0cbc220f29da0755bce024b 和后端 108feebb84b85c7e4955c5af8bbfc016702e4529。公网业务、切换与回退演练、真实用户开放、供应商投递为 NOT_RUN。共享候选本轮新增 GRANT=0。[配对与回退顺序](https://github.com/BA7IEE/srvf-nest-api/blob/805ccde613f808ba4fa2ab18e63eb687e7be35d8/docs/ops/runtime-acl/t38/PAIR.md)

## 时间、地点与容量的具体缺口

当前正式 PR 的发布后表单和 API 适配器只生成标题与说明。下面列的是后端当前合同、前端需要接通的内容，以及尚待运行的页面验收。

| 字段 | 现行合同与需接通的操作 | 正反验收及状态 |
|---|---|---|
| 起止时间 | activityPatch.startAt/endAt 接收 ISO 时间。完整提案单列 sessions 和 positions。审核页需明确原、新活动时间与涉及的场次、签到签退窗口。草稿编辑器的同步布局有独立实现。 | 合法调整由负责人提交、审核人对照后批准，并读回活动和场次。开始不早于结束应按 400/20015 拒绝；场次越出活动边界按 400/20134 拒绝。发布后正反页面均 NOT_RUN。 |
| 地点 | activityPatch.location 表示活动主地点文本。场次 locationText 单列；冻结的 activityPlaces 包含结构化地点及可见范围。改主地点文本不会自动表达场次、坐标和签到地点的修改意图。 | 页面需标出实际改动层次；批准后分别读回活动文本、场次地点与冻结地点。要覆盖缺字段或未展示关联地点差异时的拒批。发布后正反页面均 NOT_RUN。 |
| 容量 | capacity 允许正整数或 null，省略表示沿用。根活动、场次、岗位名额和已占用桶要分别核实；服务端投影会拒绝低于实际占用的目标。 | 合法调整需覆盖有界与不限的区别、批准和各层读回；低于已占用需有真实占用夹具，核实失败时无半写。T39 已验证浏览器发现额外容量差异会阻止批准；真正提案的批准与占用冲突页面均 NOT_RUN。 |

以上依据为后端 ChangeReviewDto、UpdateAppManagedActivityDto、ActivityPublishProposalV2Service.assertProposalValid 及 ActivityCapacityBucketProjector，以及前端 src/api/srvf-activity-publish-review.ts、simple/published-change.vue 和 workbench/publish-review/state.ts。后续可以沿完整提案入口补齐，不需要放宽现有差异检查。[后端提案实现](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activities/activity-publish-proposal-v2.service.ts#L4887) · [前端冻结差异检查](https://github.com/BA7IEE/srvf-admin-web/blob/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64/src/views/srvf/workbench/publish-review/state.ts#L112)
