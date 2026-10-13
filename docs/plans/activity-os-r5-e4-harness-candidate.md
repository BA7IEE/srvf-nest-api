# E4当前事实与单轮诊断候选

2026-10-13。当前基线 `fe16de40b424bc45dd5864ceb0b2295c06329059` 属于[Draft PR1380](https://github.com/BA7IEE/srvf-nest-api/pull/1380)，不是main、正式验收或部署。migration142；[CI38355911967](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38355911967)仅原满额prepare仍P2028（31944ms），三条opening回归已恢复。签字136/142及trusted approval等待独立存在；E5未实施。

用户已允许普通driver/adapter/离线测试候选。**本轮DB、提交、推送及新GitHub执行均NOT_RUN**。历史FAIL/UNKNOWN保留；37.5→31.9秒没有生产性能变更，不能称优化收益。

目标是取得一次完整prepare/commit成本，保持原满额2000/10000/50000/8000输入、业务SQL、全部触发器、权限、原子性及完整独立oracle。原service事务30000、旧SQL/probe窗口和原考卷不改。

可运行候选为 `test/diagnostics/e4-prepare-cost.diagnostic-spec.ts`：普通E2E regex不收集；显式DIAGNOSTIC_ONLY、固定HEAD、GitHub run attempt1、专用app_test_w98、正常DROP/lease release。拒绝生产目标、retained库模式和guard统计模式。新client adapter只对该实例一次原30秒prepare设90秒。

独立父进程监督自己的进程组：560秒TERM、590秒KILL、600秒硬截止，清除计时器并检查组退出；强停后DB清理只记UNKNOWN，不能声称DROP成功。完整prepare结束后恢复观察器和adapter，运行原完整oracle，关闭连接，执行原正常库/lease finalizer。Jest退出失败或进程清理不明不能COMPLETE。

首轮只复用phase/native/transaction观察器；覆盖完整prepare和事务commit，native缺覆盖保持UNKNOWN。native等待不是纯SQL或INSERT，commit事件不是耐久性证明；不扩guard-function窗口，不开track_functions，不新增业务SQL、trigger或统计裁判。诊断COMPLETE永远带NOT_AN_ACCEPTANCE_RESULT，原30秒FAIL仍有效。

启动定位使用独立原子阶段回执（最多16条、4KiB），只记录guard/fixture bootstrap/source build/prepare/oracle/cleanup固定枚举与允许列表错误类别。父在child.json缺失时仍读取最后阶段、失败阶段和退出状态；stderr/stdout不导出，错误消息、栈、SQL、URL和环境不进回执。迁移/beforeAll失败归初始化失败，强停后清理仍UNKNOWN。

当前执行队列只有：①离线验证目的/实例隔离/预算/父进程停止与清理/冻结oracle；②父核最小diff；③维护者在本云树精确授权workflow路径及一次DB执行后才能采样。先前配对数量、效果阈值与符号统计建议未获批准，已从当前方案和可执行测试移除，历史归档不构成执行队列。

控制面候选仅在仓库外提供 `.github/workflows/activity-os-r5-e4-validation.yml` 增加一个显式单轮job的最小补丁。AGENTS的受保护规则要求维护者本树精确grant；AI不生成grant，Mac grant不能移用于云。没有修改真实workflow、旧E2E合同、生产代码、SQL、schema/migration、权限、签字台账或E5。

复现入口：`TS_NODE_PROJECT=test/tsconfig.test.json pnpm exec ts-node test/diagnostics/e4-prepare-cost.diagnostic-spec.ts --plan`（离线）；获准的独立GitHub job设置显式目的后以同入口 `--execute`，结果写 `tmp/e4-prepare-cost-evidence/result.json`。本候选没有自动后续采样链。
