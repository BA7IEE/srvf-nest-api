# T41 发布后改期、地点和容量验收

普通负责人在服务器隔离栈通过页面申请，另一名普通审核人核对冻结的原值、新值并批准。必填布尔指标的单场次活动通过了改期、地点文字和容量的组合变更，也通过了单独改为不限人数。两个账号均为 USER，初发后由业务流程投影负责人。本轮共享候选新增 GRANT 为 0。

## 版本与复审

| 项目 | 固定版本与证据 |
|---|---|
| 正式前端 | Draft #172，HEAD `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，直接父提交 `eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64`。原生必需检查 verify **SUCCESS**。[增量 diff](https://github.com/BA7IEE/srvf-admin-web/compare/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64...104e524c0b76826a79b1d48fad37fb07dcdfb8e8) · [业务仓原生 CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44565714648/job/135706747311) |
| 配套后端 | Draft #1444，HEAD `713d3416830d897852929731ff7f9b638038ab7c`。四个必需检查通过。单列人工 Red-zone trusted approval 为 SKIPPED，人工批准无记录。[后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548708050) |
| 隔离产物 | 前端静态目录完整清单 SHA256 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b`，后端镜像 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75`。两个容器均无宿主端口绑定，外部 SMS、企微、订阅消息路由均关闭。 |
| 复审状态 | T40 独审覆盖至 eb587bd2。本次 8 个文件的增量待对 104e524c 单独复审。固定二进制 diff 的 SHA256 为 `af51e4f2fc1858216ebdbcd0846a90003f2d6d4a8b707de5f3ace9a908f0b165`。 |

## 字段矩阵

| 字段或保护 | 页面、HTTP 与数据库断言 | 结果 |
|---|---|---|
| 合法改期 | 北京时间 12 月 1 日 09:00–11:00 改为 12 月 3 日 10:00–12:00。负责人提交 200/0，待审时原时间有效；独立审核 200/0。审核页展示原新活动时间与联动场次、签到窗口，Simple 详情和冻结提案读回一致。默认岗位有显式时间时随场次移，继承场次时间则保留继承。 | PASS |
| 非法时间与场次越界 | 页面拦开始晚于结束。通过负责人正常登录调用同一变更接口，开始等于结束得到 400/20015，仅缩短活动范围致原场次越界得到 400/20134。两次均复读原 draftHash，未新增提案或成功审计。 | PASS |
| 地点文字 | 活动与场次文字从原场地改为“东侧训练区”标记值，独立审核对照原新文字并批准。页面详情显示生效文字，原结构化地址、可见范围与冻结地点一致。空白由页面拦截，空字符串到 API 返回 400/40000。模拟审核读面多出未核对的地址差异，按钮禁用、批准请求为 0。真实批准使用原始响应。 | PASS |
| 容量正向 | 人数上限 2→12，与改期同一提案；再经单独提案 12→不限。两次均 200/0，活动、场次与默认岗位三层同步，数据库审核快照及页面读回一致。 | PASS |
| 容量反向 | 隔离库中两名标记队员，各有报名、参与身份和三类有效预约，共六条。负责人申请从不限降到 1，提交 200/0，独立审核 409/20147。原三类名额仍各占用 2，容量、版本、活动/场次/岗位/地点行摘要和历史批准记录一致，本次提案仍待审。失败请求无成功业务审计。页面也拒绝零容量。 | PASS |
| 原有保护定向回归 | 无需指标模板的标题与说明再次通过两主体页面审批。浏览器并发改稿后旧确认被 409/20255 拒绝；重新核对后通过。正文与摘要不一致的额外容量差异被拦截，批准请求为零。审核人代负责人申请返回 404/20001。 | PASS |
| 内部 Worker | 本轮整个隔离栈共 3 条系统通知、8 条定向通知，均一次处理成功，退役前待处理数为 0。 | PASS |
| 真实结构化地址、地图坐标或签到围栏迁移 | 当前 change-reviews 可写活动 location 和场次 locationText；V7 冻结沿用现存 activityPlaces。页面标出这层区别。此次未执行地理位置、签到地址记录、围栏迁移。 | NOT_RUN |
| 五类必填组合 × 新三个字段 | 本轮新字段实测为必填布尔。T39 曾测五类指标与标题、说明变更。 | NOT_RUN |
| 公网认证业务、上线和外部投递 | 公网仍保留 b7f3dac0 / 108feebb 配对。验证现有路由及预备副本一致，仅做了只读复核。 | NOT_RUN |

最终业务回执通过 HTTP reqId 关联 SQL 审计，共 12 条创建、提交或决定请求。失败申请均未产生成功业务审计。降容审批前后还有一次合法的“提交待审”写入。其记录与失败审批分别核对。占用数据由一次性测试库事务按后端容量 E2E 的实体关系创建，检验的是审批对已有占用的处理；报名页面全链本轮未测。

## 同 SHA 开发交接

1. 改动集中在已发布 Simple 详情、负责人提交适配器、审核冻结差异展示和两个 Chromium 测试文件。工作台从原基线重建受支持的目标值，核对服务端 activityFields、场次/岗位、解析规则和完整冻结字段；额外差异会阻止批准。[固定源码](https://github.com/BA7IEE/srvf-admin-web/tree/104e524c0b76826a79b1d48fad37fb07dcdfb8e8)
2. 使用既有 change-reviews 和 approve 接口。调整场次时间时保留模板相对偏移，岗位沿用显式或继承语义。人数沿活动、场次、岗位一起变更。后端事务、授权、草稿锁内 expectedDraftHash 检查继续使用原实现。
3. 业务写入仅发生于标记的隔离 PostgreSQL。批准会写活动聚合、容量投影、审核、审计与内部通知。两个账号登录、独立审核、请求回执与数据库状态均已关联。
4. 复审应重点查看空容量与省略字段、北京时间和窗口偏移、完整差异比较、藏入额外地点差异时的拒批、未批准前后的读回。开发段已完成，新 SHA 独审待独立会话执行。
5. 退役及回退分开处理。隔离回归保留脱敏收据及合成审计。业务仓可单独 revert 104e524c 回到 eb587bd2 的前端行为。已批准的活动变更如需撤回须走业务变更流程，回退静态文件不会撤销已生效的数据。
6. 待复审配对为 104e524c / 713d3416。建议按此固定增量复审前端，完成部署授权后再安排公网验收。[前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172)

本机证据在 `/private/tmp/srvf-t41/`，包括 `final-layout.log`、`final-occupied-retry.log`、`final-before.jsonl`、`final-after.jsonl`、`reconciled.json`、`verify.py`、`native-final.json` 和 `back-final.json`。浏览器断言入口在正式前端的 tests/render/simple_freeze_server.cjs 与 simple_published_layout.cjs。首次内部读证 SQL 误用了审计列名，exit 3；改为 event 与 context.requestId 后读取成功。登录限流 429/42900 的开发试跑单独保留，重试复用原限流设置。

## 实测命令与退出码

| 调用 | exit | 证据 |
|---|---:|---|
| pnpm lint、pnpm typecheck、pnpm exec vite build --outDir 指定隔离静态目录 | 各 0 | final-lint.log、final-type.log、final-build.log |
| sh browser.sh SCENARIO=published_layout | 0 | final-layout.log |
| 私有试验网络内运行 fixture.sh 和只读 final-snapshot.sql | 0 | final-fixture.log、final-before.jsonl |
| sh browser.sh SCENARIO=occupied_layout ACTIVITY_ID=标记活动 | 0 | final-occupied-retry.log |
| 只读 final-snapshot.sql、python3 verify.py | 各 0 | final-after.jsonl、reconciled.json |
| sh browser.sh SCENARIO=text_change_race | 0 | text-retry.log |
| gh run watch 44565714648 --exit-status | 0 | native-watch.log |
| sh worker.sh、sh retire.sh、退役后 sha256sum --quiet -c | 各 0 | worker.log、retired.log、retained.log |

隔离业务库、生成的登录文件和四个容器已退役。合成审计以 0600 留存在服务器试验目录，供授权复核。场次时间、三层容量和原地点安排已有 API 读回与库内冻结记录；补取每列签到窗口的独立 SQL 查询在试验库退役后未取得数据，窗口逐列 SQL 回执标 NOT_RUN。公网业务与实际回退演练留待获批部署后验证。
