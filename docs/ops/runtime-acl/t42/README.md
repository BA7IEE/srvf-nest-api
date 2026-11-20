# T42 开发验收报告

**五类必填指标与改期、地点文字、容量的组合在服务器隔离栈通过。普通账号报名写入失败，首发仍有阻塞。** 两个业务 PR 本轮均使用原提交，未增加产品补丁。公网配对验收为 NOT_RUN。记录日期为 2026-11-20，北京时间。

## 版本与身份

| 对象 | 固定版本 | 本轮核验 |
|---|---|---|
| 前端业务仓 Draft #172 | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | 原生 verify PASS。[PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44565714648/job/135706747311) |
| 后端业务仓 Draft #1444 | `713d3416830d897852929731ff7f9b638038ab7c` | 四项必需检查 PASS。裁判判定 REQUIRED=false，人工审批步骤 skipped。[PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548708050) · [红区裁判](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548698125/job/135646405756) |
| 隔离服务 | 前端清单 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b`；API 镜像 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75` | 启动、退役后均核过整套静态文件和镜像 revision。独立内部网络、无对外端口、PG 16、156 项迁移。 |
| 普通主体 | 两个标记 USER，分别担任组织范围内的发起人、独立审核人 | 起点有两条组织绑定，活动绑定为零。前三张通过单均由不同 USER 提交和批准。 |

两条 PR 结束前复核仍为 Draft。前端 PR 记录的 base 为 `6375148a61445972e792ce37cb401fd8e5162538`，独立查询的 main 为 `b12093c67fdd5d7b5650dcaf15b6783984e4075a`，两者相差一条 README 提交。这里的 CI 对应表中 HEAD。后端 main 为 `2b3eee0a954ea65abaef3edb35fd391eaa1567e9`。

## 实测矩阵

HTTP 与业务码用斜线分隔。正例由服务器 Chromium 操作真实页面和应用。四张审核单中的配置均为同一套五项必填指标，覆盖布尔、非负整数、非负小数、短文本、单选。审核页面逐项检查名称、类型、必填标志和配置的单位、限值、两条选项。数据库核对冻结集合 `t37_full_set@1`、定义摘要及模板指针。[逐单数据](all-five.jsonl) · [HTTP、审计与三层读回](reconciled.json)

| 场景及主体 | 结果 | HTTP、页面、审计、DB |
|---|---|---|
| 发起人选 Simple 模板创建、确认草稿提审，独立审核人发布 | PASS | 页面创建 201/0、提审 200/0、批准 200/0。提审携带 expectedDraftHash，v1 已批准，活动初始容量 2。 |
| 同一活动联合申请改期、改地点文字、扩容；独立审核 | PASS | 申请与批准均 200/0。审核人核对原新值，北京时间 12 月 1 日 09:00–11:00 改为 12 月 3 日 10:00–12:00；地点文字同步至场次，原结构化地址保留。活动、场次、岗位容量均为 12。 |
| 改期后的落库时间 | PASS | 活动与场次起止一致；签到开放/截止、签退开放/截止分别为北京时间 10:00、10:20、11:40、12:00，与批准快照一致。岗位未单独设时，继承场次。 |
| 由限额 12 改为不限额 | PASS | 页面申请与批准均 200/0，三层读回均为 null，v3 已批准。 |
| 非法时间、场次越界、空地点、零容量 | PASS | 定向 HTTP 前三项依次 400/20015、400/20134、400/40000。每次重读草稿摘要一致；页面对非法时段、空地点和零容量禁用提交。 |
| 冻结指标不全、未展示的结构化地点差异 | PASS | 仅在审核浏览器替换详情读响应，分别移走一条指标、加入未展示地址差异。两例发布按钮禁用，共发出 0 次批准请求。恢复实际响应后完成正例。 |
| 已占用 2 人，申请将不限额改为 1 | PASS | 用两名标记参与者建立占位夹具，三类容量桶各占 2。申请 200/0，实际审批 409/20147。v4 保持待审，无批准人。审批前后三层容量、桶版本、6 条占位一致，拒绝请求无成功审计。 |
| 站内通知 Worker | PASS | 同一后端镜像启动实际处理者，广播 1、定向 3，各处理一次，待处理 0，退出 0。外部通知开关关闭。 |
| 普通账号正常报名，全新占位前 | **FAIL** | 同一已发布活动，合法报名期望 201，实得 500/50000，断言 exit 1。报名头、版本、参与身份、占位均无新增。 |
| 两个普通账号读取自己的报名及对方标记记录 | PASS | 单独准备占位夹具后，本人列表/详情均 200/0，双方交叉读取均 404/21001，exit 0。 |
| 正常报名后的幂等重试、取消、签到与结算 | NOT_RUN | 正常报名写入已失败。占位夹具仅用于容量约束和只读归属检查。 |
| 公网新配对验收、真实供应商投递、向真人开放 | NOT_RUN | 本轮限定服务器隔离栈，当前公网仍用旧配对。 |

活动为单场次、单岗位。覆盖地点文字及原结构化地址保留；多场次联动、实际地理坐标编辑、岗位独立时段修改均为 NOT_RUN。未配置指标、并发编辑冲突 409/20255 沿用原固定版本的既有证据，本轮未重复。四次审核的指标定义摘要一致，为 `a4e8004a0e758f12972dd157f4c7e1cabc3898755af259b610159cdd5f54f820`。已将 12 条活动写请求逐一与审计对账。

## 报名失败的定位边界

失败请求为 `POST /api/app/v1/activities/{id}/registrations`，reqId 为 `cmwnruxx748535b00a72ab1c329a8c304`。该操作在添加占位夹具之前执行。隔离 PG 同一时窗记录对 `ActivityParticipationIdentity` 拒绝访问，日志没有可与 HTTP 配对的同一 reqId。用相同非所有者运行角色和服务查询投影独立复核，普通 SELECT 退出 0，加 FOR UPDATE 退出 3，SQLSTATE 为 42501。已证实该语句在这套 ACL 下会失败，整次 HTTP 500 的唯一原因仍待逐请求关联。[报名回执](registration-enroll.log) · [隔离行锁对照](lock-control.log) · [服务查询](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activity-registrations/registration-command.service.ts#L192)

调查读取了报名涉及的 13 张表的有效权限。该角色对参与身份表有 13 列 SELECT，INSERT 和 UPDATE 均为零。后续建档、版本、占位也有独立写入条件。下一步应按报名整笔事务验证正式运行角色契约，用同一请求关联应用和数据库诊断，覆盖写入、重试和取消后再提出修复。共享候选本轮新增 GRANT 为 0。[权限取样](enrollment-acl.jsonl) · [报名前](registration-before.jsonl) · [报名后](registration-after-enroll.jsonl)

## 命令与证据

| 执行入口 | exit | 可核对结果 |
|---|---:|---|
| `sh browser.sh SCENARIO=published_layout` | 0 | [真实页面、HTTP 与拒绝断言](final-layout.log) |
| `sh registration.sh enroll` | **1** | [报名响应](registration-enroll.log) |
| `sh browser.sh SCENARIO=occupied_layout ACTIVITY_ID=<本次活动>` | 0 | [容量冲突](occupied.log) |
| `sh registration.sh read` | 0 | [两个主体的归属读回](self-read.log) |
| `python3 acl-control.py`（隔离 PG） | 0 | [脚本验证 SELECT 成功与行锁返回 42501](lock-control.log) |
| `python3 verify.py`（本目录） | 0 | [重算断言](verify.log)，输入均为脱敏记录 |
| Worker 排空、退役、静态与镜像复核 | 0 | [Worker](worker.log) · [退役](retired.log) · [回退资产预检](rollback.log) |

试验栈已退役，合成审计单独保留，权限 0600。指标交叉用的 Chromium 驱动由正式前端 HEAD 的测试入口生成，变更仅在测试驱动，未改业务仓。命令和材料文件摘要见本目录。[驱动生成](build-drivers.py) · [材料摘要](SHA256SUMS) · [人工六点包](GATE.md) · [配对及回退](PAIR.md)
