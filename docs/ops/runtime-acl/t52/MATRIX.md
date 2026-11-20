# 首发交付去向

盘点日期为 2026-11-20。GitHub 查询覆盖三个业务仓全部开放 PR、后端全部开放 Issue，以及 #1420 至当前 main 已合并的 12 个相关 PR。T51 本地草稿漏列了仍开放的 #926，本次补齐。分类“后续非阻断”仅描述本次隔离配对。生产 P0 仍由发布负责人逐项核验。

每个 PR 的完整提交、目标分支、原生 CI 作业链接、审查和去向见 [逐项快照](inventory.json)。历史独审只在注明的 SHA 或测试范围内有效。

## srvf-nest-api 开放 PR

| PR | 精确 HEAD | 分类 | CI | 责任人及剩余工作 |
|---|---|---|---|---|
| [#1446](https://github.com/BA7IEE/srvf-nest-api/pull/1446) | `4c8cba0af25abe4587533c513489729a5f219fbe` | 首发必需 | 14 SUCCESS / 1 SKIPPED | 后端、部署维护者。部署含账本的 H5 时须执行预检；含短信确认修复。与 #1445 分叉，合并顺序、生成文件及新组合 CI 见配对说明。 |
| [#1445](https://github.com/BA7IEE/srvf-nest-api/pull/1445) | `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` | 首发必需 | 15 SUCCESS | 后端维护者。首选 H5 Cookie、活动及签到组合。单 SHA 的红区成功；候选场景仍受部署合同约束。 |
| [#1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444) | `713d3416830d897852929731ff7f9b638038ab7c` | 已被组合替代待关 | 14 SUCCESS / 1 SKIPPED | 后端维护者。已在 #1445 祖先链。#1445 进入 main 后核目标树、草稿版本保护及回归记录，再决定是否关闭。 |
| [#1443](https://github.com/BA7IEE/srvf-nest-api/pull/1443) | `2a0fd5adbaddf01ee9cac5c16d49cfc21790aed7` | 未满足不得关 | 16 SUCCESS | 部署与权限维护者。受保护的三码恢复工具与预检。保留收据、映射和退役路径；其余创建目录与产品模板不在此工具内。 |
| [#1442](https://github.com/BA7IEE/srvf-nest-api/pull/1442) | `61d2f71171620d92c7d00a5f3b08510d1bd051a1` | 未满足不得关 | 10 SUCCESS / 1 FAILURE / 1 SKIPPED / 2 IN_PROGRESS | 运维证据维护者。含可执行预检、试验材料与历史快照；证据树可固定引用。合并整枝需要独立裁剪与解决材料分支失败检查。 |
| [#1441](https://github.com/BA7IEE/srvf-nest-api/pull/1441) | `a985743025783ef8e03e6cf6cdcdae7abfb6f92b` | 未满足不得关 | 14 SUCCESS / 2 FAILURE | 数据库与安全维护者。a9857430 为未来入口，保留既有审计；旧版单账号执行与当前工具分开，失败 CI 待作者处理。 |
| [#1439](https://github.com/BA7IEE/srvf-nest-api/pull/1439) | `479594029d46bb9ab0e00e01411368830e2e6a24` | 已被组合替代待关 | 15 SUCCESS | 后端维护者。Cookie 会话提交在 #1445 祖先链；目标 main 已含等价实现且测试保留后，才可决定关闭独立 PR。 |
| [#1437](https://github.com/BA7IEE/srvf-nest-api/pull/1437) | `0bdf65ca96c112bf0e0d871741420ff8bd696943` | 后续非阻断 | 15 SUCCESS / 1 SKIPPED | 测试基础设施。叠在 #1436；治理仓库测试策略。合入前核基线与守护，和 H5 发布分开。 |
| [#1436](https://github.com/BA7IEE/srvf-nest-api/pull/1436) | `fb05c7205307dd876aa8b185d1a15ca03f0a0f94` | 后续非阻断 | 14 SUCCESS / 2 FAILURE | 测试基础设施。测试表策略重构有失败检查，保留待修；不属于三个界面运行配对。 |
| [#1432](https://github.com/BA7IEE/srvf-nest-api/pull/1432) | `a11832ceca1390949feef72b03f6e87548d576f7` | 未满足不得关 | 8 SUCCESS / 1 SKIPPED / 6 FAILURE | 考勤维护者。叠在旧考勤退役分支；关联 #1408，需正式更正与历史数据兼容结论、恢复绿色检查。 |
| [#1415](https://github.com/BA7IEE/srvf-nest-api/pull/1415) | `89ec2a4aad212b73d94f9baa4efffc7934ea88da` | 未满足不得关 | 6 SUCCESS / 6 FAILURE | 考勤维护者。旧端点退役及汇总迁移有独立行为和红灯，不能由一次扫码签到验收代替。 |
| [#1414](https://github.com/BA7IEE/srvf-nest-api/pull/1414) | `07ed72a67edd41a3b44571c241bdd21451965066` | 仅文档 | 7 SUCCESS / 4 SKIPPED | 文档维护者。部署验收历史记录，核证据时点与版本再归档；不带入运行制品。 |
| [#1412](https://github.com/BA7IEE/srvf-nest-api/pull/1412) | `65ce51102c848d494bcaa0f57078c4b1de6b2444` | 未满足不得关 | 14 SUCCESS / 1 SKIPPED | 考勤维护者。旧打卡链被替代后的投影；需专门的更正链、重放回归。 |
| [#1411](https://github.com/BA7IEE/srvf-nest-api/pull/1411) | `fc2af7a80e7b2690cf531bd9e877580651e083f0` | 未满足不得关 | 14 SUCCESS / 1 SKIPPED | 反馈维护者。结算后的反馈资格另行验证；现有 H5 报名/签到证据不覆盖反馈。 |
| [#1410](https://github.com/BA7IEE/srvf-nest-api/pull/1410) | `f9aa7381884130f36a222f02d4cb528ef55af41e` | 未满足不得关 | 14 SUCCESS / 1 SKIPPED | 账本维护者。参与天数按当前已入账记录计数，与本人分录分页是两份合同。需核历史更正、重算。 |
| [#1409](https://github.com/BA7IEE/srvf-nest-api/pull/1409) | `85bce83795ef7cc4f20034a7efa81a697504ce93` | 仅文档 | 7 SUCCESS / 4 SKIPPED | 考勤文档维护者。单流程方向文档；确认与现行 #1408 的退役范围一致后处理。 |
| [#1407](https://github.com/BA7IEE/srvf-nest-api/pull/1407) | `120e85cbe85f923a7924da332b8ab7a0e7a6f495` | 后续非阻断 | 14 SUCCESS / 1 SKIPPED | 活动维护者。无资质规则详情的锁优化；按其基线独立核锁与详情回归。 |
| [#1406](https://github.com/BA7IEE/srvf-nest-api/pull/1406) | `fa4766637f17d32f836c30bee8c2feedd5bcb0dc` | 后续非阻断 | 18 SUCCESS | CI 维护者。保留已审查镜像的工作流，与运行代码配对分别维护。 |
| [#1405](https://github.com/BA7IEE/srvf-nest-api/pull/1405) | `08cb8b2d450c3ebc80eb38810755d0306c58b04d` | 未满足不得关 | 15 SUCCESS | 活动与权限维护者。冻结审核展示有局部覆盖；与 #1445 分叉，受限策略定义读面仍须逐项对照。 |
| [#1404](https://github.com/BA7IEE/srvf-nest-api/pull/1404) | `53d2de0d9d26341a9605fdb002a3fcab5fd7143e` | 未满足不得关 | 14 SUCCESS / 1 SKIPPED | 活动维护者。草稿确认已回移；原分支还包括镜像/不同基线变化，与 #1445 分叉。不能整 PR 宣称替代。 |
| [#1403](https://github.com/BA7IEE/srvf-nest-api/pull/1403) | `5816f06df04443e545cb5fc6ea587d3c5456e911` | 未满足不得关 | 15 SUCCESS | 更正与权限维护者。更正重放、角色升阶独立核验，普通 H5 写读链不覆盖。 |
| [#1392](https://github.com/BA7IEE/srvf-nest-api/pull/1392) | `12400ddee4b2e82b1418ca2bdfe2c160aa0ee178` | 后续非阻断 | 16 SUCCESS | CI 维护者。夜间任务分配及历史上下文，交 nightly 流程独立收尾。 |

## SRVFMobileWeb 开放 PR

| PR | 精确 HEAD | 分类 | CI | 责任人及剩余工作 |
|---|---|---|---|---|
| [#5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) | `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | 首发必需 | 2 SUCCESS | 移动端维护者。在 #4 上增加保险与签到；#5 的树含 #3/#4。冻结三层目标，保留顺序与原生 CI。 |
| [#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) | `5e5be8dc11daf86781cf648c8c35572b3e79df60` | 首发必需 | 2 SUCCESS | 移动端维护者。Cookie 会话及队员页面，base 是 #3 分支；接入后核目标基线再处理 #5。 |
| [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) | `ce14f84b5add85de11816136a0ef975a28ff7b7e` | 首发必需 | 2 SUCCESS | 移动端维护者。堆叠底座，base=main；准备同源传输。依序整合并复核下一层的 base。 |

## srvf-admin-web 开放 PR

| PR | 精确 HEAD | 分类 | CI | 责任人及剩余工作 |
|---|---|---|---|---|
| [#172](https://github.com/BA7IEE/srvf-admin-web/pull/172) | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | 首发必需 | 1 SUCCESS | 管理端维护者。Simple 发布审核页、冻结指标及发布后变更；面板其余业务按各入口单列。 |
| [#171](https://github.com/BA7IEE/srvf-admin-web/pull/171) | `7b6825c408ada2a3a4e5af36455989ee304e6b1b` | 未满足不得关 | 1 SUCCESS | 管理端与结算维护者。管理员结算工作台，与 #172 分叉；搭配后端 #1431 单独核真实审核页和读回，决定进入哪一批。 |
| [#170](https://github.com/BA7IEE/srvf-admin-web/pull/170) | `2ab02a346799bbed2cbe89b2e80e7fb516bc9aea` | 未满足不得关 | 1 SUCCESS | 管理端与成员维护者。成员建档与姓名展示，与 #172 分叉；API 建档回执不能代替该页面验收。两者配对前留开。 |

## 后端开放 Issue

| Issue | 分类 | 责任人及剩余依据 |
|---|---|---|
| [#1430 [暂停归档] D5/D6/D7 2000 人 prepare 偶发 P2028（60 秒预算）诊断跟踪](https://github.com/BA7IEE/srvf-nest-api/issues/1430) | 后续非阻断 | 性能维护者。按原暂停决定留存 2000 人超时诊断；首发试验样本不足以关闭。 |
| [#1419 超限 JSON body(~1MB)触发裸 500(应 413/40000)](https://github.com/BA7IEE/srvf-nest-api/issues/1419) | 未满足不得关 | API 维护者。main 已合 #1420；T21d 授权桥接 102504 字节→413/40000；模型未发包。本次无重复请求；维护者核原验收范围决定关单。 |
| [#1418 内容 publish 在 storage enabled=false 环境恒返 13034（零附件草稿同样被阻断）](https://github.com/BA7IEE/srvf-nest-api/issues/1418) | 未满足不得关 | 内容产品维护者。storage 关闭时空附件发布的语义未定；保留业务决定与 13034，发布流程无替代证据。 |
| [#1417 [prod-smoke] commit-jobs detail 查询不存在 ID 时未兜底,服务层抛 500](https://github.com/BA7IEE/srvf-nest-api/issues/1417) | 未满足不得关 | 更正链维护者。main 已合 #1420；T28 普通连接的 503/50300 有公网实测；合法受信身份的正向、缺失 ID 404 和跨对象仍缺成套证据。 |
| [#1416 [prod-smoke] submit-change-review 资源不存在时未兜底,抛 TypeError 500](https://github.com/BA7IEE/srvf-nest-api/issues/1416) | 未满足不得关 | 活动维护者。main 已合 #1420；隔离已测发布后变更、独立审核，最终配对公网目标仍待部署验收。 |
| [#1408 考勤去旧留新：v1.1 唯一业务链、旧 GPS/考勤单退役与历史兼容清理](https://github.com/BA7IEE/srvf-nest-api/issues/1408) | 未满足不得关 | 考勤维护者。去旧与历史兼容仍须验证，见 #1415/#1432。 |
| [#1332 🌙 Nightly E2E leaks 失败](https://github.com/BA7IEE/srvf-nest-api/issues/1332) | 后续非阻断 | CI 维护者。夜间泄漏失败留在原作业定位；PR 的绿色分片不结案。 |
| [#1109 CI docs-only 快路径跳过单测 —— 读 docs 的 5 个 spec 因此不设防,红会转嫁给下一个非 docs PR](https://github.com/BA7IEE/srvf-nest-api/issues/1109) | 后续非阻断 | CI 维护者。docs-only 快路径对读文档的规格是否充分，归独立 CI 事项。 |
| [#1055 [P1] 队员视觉身份资产终态升级：分离账号头像、队员标准照与身份证件影像](https://github.com/BA7IEE/srvf-nest-api/issues/1055) | 未满足不得关 | 成员与隐私维护者。区分照片与证件资产的保护和保留，用正式放行口径复核。 |
| [#947 [P1] 建立任务级 AI Coding Context Pack，降低 Harness 上下文成本](https://github.com/BA7IEE/srvf-nest-api/issues/947) | 后续非阻断 | 开发工具维护者。上下文包归长期工程，不影响本次三端定版。 |
| [#946 [P1] 建立 API、BizCode 与权限码长期治理门禁](https://github.com/BA7IEE/srvf-nest-api/issues/946) | 后续非阻断 | 契约维护者。长期治理 API、业务码和权限码；单版预检仅覆盖其自身合同。 |
| [#945 [P1] 清理架构文档与源码注释漂移，建立可验证的新鲜度门禁](https://github.com/BA7IEE/srvf-nest-api/issues/945) | 后续非阻断 | 文档维护者。持续治理文档新鲜度；本次归档不关闭长期门禁。 |
| [#944 [P1] 清零主 CI 的 Jest Worker 强制退出 Warning](https://github.com/BA7IEE/srvf-nest-api/issues/944) | 后续非阻断 | 测试基础设施。追查 Jest Worker 退出告警、保留 nightly 证据。 |
| [#942 [P1] PostgreSQL 控制平面治理：连接、锁、事务与容量可观测性](https://github.com/BA7IEE/srvf-nest-api/issues/942) | 后续非阻断 | 数据库运维。连接/锁/容量观测按治理项验收，与隔离实例撤权实验证据分列。 |
| [#941 [P0] 建立第二维护者独立接管能力与灾备演练](https://github.com/BA7IEE/srvf-nest-api/issues/941) | 未满足不得关 | 维护者与接任者。生产前独立接管与灾备演练仍需专门回执。 |
| [#940 [P0] 生产放行硬门总控：维持 loginEnabled/messageEnabled NO-GO 直至验收闭环](https://github.com/BA7IEE/srvf-nest-api/issues/940) | 未满足不得关 | 发布负责人。总放行项保持，生产登录、消息与真正开放由维护者单独决定。 |
| [#939 [P1] 引入 CodeQL、SBOM 与依赖漏洞扫描供应链门禁](https://github.com/BA7IEE/srvf-nest-api/issues/939) | 后续非阻断 | 安全工程。跟踪代码/依赖供应链门禁；按正式放行策略另审。 |
| [#937 [P1] CMS 内容状态迁移统一锁/CAS，修复并发竞态](https://github.com/BA7IEE/srvf-nest-api/issues/937) | 未满足不得关 | 内容维护者。CMS 状态迁移并发安全未在活动/账本实验证实。 |
| [#936 [P1] 通知广播批量化改造，解决大规模发送瓶颈](https://github.com/BA7IEE/srvf-nest-api/issues/936) | 后续非阻断 | 通知维护者。广播批量和容量专项；通知闭环不代替外部投递容量验收。 |
| [#935 [P0] 完成真实外部供应商链路验证（企业微信/COS/短信）](https://github.com/BA7IEE/srvf-nest-api/issues/935) | 未满足不得关 | 供应商与运维。真实企业微信、COS、短信需供应商链路批准与实测。 |
| [#934 [P0] 完成生产迁移、备份恢复与回滚演练](https://github.com/BA7IEE/srvf-nest-api/issues/934) | 未满足不得关 | 数据库运维。目标环境生产迁移、备份恢复/回退演练，隔离恢复只覆盖隔离。 |
| [#933 [P1] 附件上传增加病毒扫描/隔离状态机](https://github.com/BA7IEE/srvf-nest-api/issues/933) | 未满足不得关 | 附件与安全维护者。病毒扫描与隔离未验证；公开附件入口另核。 |
| [#932 [P0] 建立生产级可观测性与 Worker 健康监控体系](https://github.com/BA7IEE/srvf-nest-api/issues/932) | 未满足不得关 | SRE。生产 Worker 可观测与告警待独立验收；隔离排队与排空仅覆盖试验。 |
| [#931 [P1] Storage 加密密钥版本化与轮换机制](https://github.com/BA7IEE/srvf-nest-api/issues/931) | 后续非阻断 | 存储安全。密钥版本和轮换按存储治理验证。 |
| [#930 [P1] PostgreSQL 限流桶增加自动清理与容量治理](https://github.com/BA7IEE/srvf-nest-api/issues/930) | 后续非阻断 | 数据库运维。限流桶容量/清理策略归专属治理。 |
| [#929 [P1] 安全审计拆分业务审计与安全审计通道](https://github.com/BA7IEE/srvf-nest-api/issues/929) | 后续非阻断 | 安全审计维护者。安全与业务审计分流归架构治理。 |
| [#928 [P1] Authz 请求级上下文优化，降低重复查询](https://github.com/BA7IEE/srvf-nest-api/issues/928) | 后续非阻断 | 授权维护者。单请求查询优化保留原权限正确性边界。 |
| [#927 [P1] Worker Supervisor 重构：避免单 Worker 死亡导致隐性故障](https://github.com/BA7IEE/srvf-nest-api/issues/927) | 后续非阻断 | Worker 维护者。Supervisor 容错按故障场景独立验证。 |
| [#926 [P0] 生产上线前补齐高敏个人信息字段保护](https://github.com/BA7IEE/srvf-nest-api/issues/926) | 未满足不得关 | 隐私与发布负责人。生产高敏字段保护是正式开放前 P0，需单独隐私证据。 |

## 后端 main 已合并

| PR | 合并提交 | 在组合后端中 | 余项 |
|---|---|---|---|
| [#1440 fix(cutover): reconcile active artifact and RBAC checks](https://github.com/BA7IEE/srvf-nest-api/pull/1440) | `2b3eee0a954ea65abaef3edb35fd391eaa1567e9` | 是 | 切换核对已合入，实际目标部署仍需回执。 |
| [#1438 test: restrict organization lock cleanup to owned backends](https://github.com/BA7IEE/srvf-nest-api/pull/1438) | `f180dcb2475ac07297ebfdc52bfce9ea82cdc839` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1435 refactor(harness): centralize reviewed migration inventory](https://github.com/BA7IEE/srvf-nest-api/pull/1435) | `8eaa0e461e066842c787b33d260f5661cd52c867` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1434 feat(team-join): persist contribution threshold reminders on ledger commit](https://github.com/BA7IEE/srvf-nest-api/pull/1434) | `d75e5179f18589e71c0760aa007c0fcb0629dd25` | 是 | 贡献阈值提醒另核消息语义和外发边界。 |
| [#1433 fix(activities): cap manual settlement hours by complete evidence](https://github.com/BA7IEE/srvf-nest-api/pull/1433) | `108feebb84b85c7e4955c5af8bbfc016702e4529` | 是 | 结算工时上限归活动结算验收。 |
| [#1431 feat(activities): 管理员结算搜索与逐人冻结审核结果（A3/A4）](https://github.com/BA7IEE/srvf-nest-api/pull/1431) | `5d2b923159857f2d31890343615d9c3e706f8586` | 是 | 管理端 #171 的工作台按功能另验。 |
| [#1425 ci: reduce repeated approvals and documentation-only container work](https://github.com/BA7IEE/srvf-nest-api/pull/1425) | `4eb39ecd9e6799e79cb6fe3ba5f1dc6004383d4f` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1424 test(activities): observe C3 prepare phases in D7 capacity regression](https://github.com/BA7IEE/srvf-nest-api/pull/1424) | `00f5e46b91d01c617a791389b9a6dda5808de7f0` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1423 test(activities): add redacted D5 HTTP failure diagnostics](https://github.com/BA7IEE/srvf-nest-api/pull/1423) | `35f9358b4624533f3f296d6506fd3c148c1238ca` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1422 docs(harness): compress module rules while retaining business invariants](https://github.com/BA7IEE/srvf-nest-api/pull/1422) | `b2b5f6f3f03d1c009c398ca602803c3709a665d1` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1421 chore(harness): 精简开发底座与 CI 流程](https://github.com/BA7IEE/srvf-nest-api/pull/1421) | `bdce33b105c2ccc4e9c8cabdbe47e41771f3e0ed` | 是 | 保留 main 中既有变更；部署和生产放行另记。 |
| [#1420 fix: 兜底活动审核、后台任务与超限 JSON 的裸 500（#1416 #1417 #1419）](https://github.com/BA7IEE/srvf-nest-api/pull/1420) | `9bc703caf9b8f8102cf8cecccd7c04711ed78ab0` | 是 | 仍开放的三个 Issue 按上表分别验收。 |
