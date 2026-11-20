# T48 非公网 H5 配对验收

2026-11-20，在 srvf 的独立内网，用最终三个 PR 的实际产物，从管理端独立发布走到 H5 严格保险报名、图片扫码签到和本人读回。合成库备份在新库恢复成功。参与记录页暴露出另一个发布阻断项：运行角色可以读汇总，但读已认定账本所需的列权限不足。共享候选本轮新增授权为 0。

## T47 条件结算

| 独审条件 | T48 结果 | 证据 |
|---|---|---|
| #1445 原有 WAITING | 已闭。精确提交 15/15 COMPLETED SUCCESS，含同一次 Red-zone trusted approval 作业。OPEN、Draft、CLEAN、mergedAt=null，GitHub reviews 数为 0 | [原生作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667827144/job/136061481394) |
| 管理端曾在中间版后端发布 | 已闭。最终组合上，普通发起人按模板创建，独立审核人批准发布。创建返回 201/0，批准返回 200/0 | [页面回执](trial.json) |
| 最终 90 天配置的签到审计只投影通用事件 | 新一轮已闭。一次查询同时匹配签到 reqId、成功审计的 operation 和 eventId、本人账号及队员、同一活动和时段。完整匹配 1，错误 reqId 匹配 0。T47 历史记录仍保留原证据粒度 | [联查 SQL](audit.sql) |
| 严格保险与配对部署回退 | 已闭合成团险场景和非公网配对回退。数据库在全新逻辑库恢复；原队员在恢复后的配对重新登录并读回本人在场状态 | [部署回执](trial.json) |
| 本人参与记录 | **基线 FAIL，隔离补齐后 PASS，撤回后再现 FAIL**。共享候选账本读取契约仍有差额 | [列权限采样](aclcheck.sql) |
| 手机、微信、公网、候选共享权限、真人开放 | 手机和微信受实机通道限制。公网部署和开放属于维护者决定；共享权限另有审批边界。Simple 模板要求定位的场次还缺坐标契约 | [设备回执](devices.json) · [T47 独审全文](https://github.com/BA7IEE/srvf-nest-api/blob/1775cfbe8f46c15c471010edc9827965eed738a4/docs/ops/runtime-acl/t47/independent-review.md) |

## 版本与原生 CI

| 仓库 / PR | 精确 HEAD | 原生检查 |
|---|---|---|
| 后端 [#1445](https://github.com/BA7IEE/srvf-nest-api/pull/1445) | `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` | 15/15 成功 |
| 后端 [#1439](https://github.com/BA7IEE/srvf-nest-api/pull/1439) / [#1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444) | `479594029d46bb9ab0e00e01411368830e2e6a24` / `713d3416830d897852929731ff7f9b638038ab7c` | 两者均在 #1445 祖先链。分别 15 成功、14 成功加 1 skipped |
| H5 [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) → [#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) → [#5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) | `ce14f84b5add85de11816136a0ef975a28ff7b7e` → `5e5be8dc11daf86781cf648c8c35572b3e79df60` → `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | 各 2/2 成功。逐个 commit 对象核对到 mobile main；本地缺 main 之前的老对象 |
| 管理端 [#172](https://github.com/BA7IEE/srvf-admin-web/pull/172) | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | verify 成功。与最新 main 的本地试合并内容相对已测产物只差 README |

部署使用已核 SHA-256 的最终后端编译目录覆盖层、H5 真实构建和管理端静态文件清单。基础容器镜像为 `1eb4e3ca…`；运行版本凭挂载的编译产物追溯到 #1445。试验网为 Docker internal，服务发布到宿主的端口数为 0。反代与 H5 同源 HTTPS，后端信任反代单 IP /32；浏览器验证试验证书。仅在一次性库装配既有活动、报名及考勤权限。业务 API 使用非所有者身份；标记队员直接业务角色绑定为 0。[产物摘要](build-inputs.json) · [依赖关系](graph.json) · [原生 CI](live.json)

## 页面、HTTP、数据库与 Worker

| 实际场景 | 结果 |
|---|---|
| 管理页模板创建、提审、独立审核发布 | PASS。最终后端产物，普通发起人与审核人分开，发起人无预绑 owner。该次模板指标为 not_required |
| H5 重新加载、轮换与跨标签退出 | PASS。Access 15m、Refresh 90d，JS 看不到 Refresh Cookie，Web Storage 访问次数为 0。绝对寿命、Access 到期沿用 T47；禁用和重放沿用 T46 |
| 严格保险 | PASS。需保险活动、合成团险符合，H5 报名 201/0，库内 1 条保险证据绑定报名修订。另一无保障主体读取本人预检 200/0、eligible=false。本轮未向供应商投保 |
| 图片选择扫码、本人在场 | PASS。签到 201/0，reqId `cmwogsl54ec9218bd3037f0db9fcbb513`；本人读回 200/0。二维码已撤销，手机摄像头 NOT_RUN |
| 审计及数据 | PASS。报名 reqId `cmwogptu569133d5f7fdde8ef8947e67f` 对应 create、review 两条成功审计；签到的审计、本人事件和开放时段直接关联。156 条迁移 |
| Worker | PASS。真实 notification-outbox-worker 消费 1 条站内广播和 2 条站内定向通知，各尝试 1 次。积压从 3 到 0，正常退出 0。外部渠道 NOT_RUN |
| 本人参与页 | 原始列表和诊断复现均 500/50000；汇总 200/0。补齐隔离差额后列表 200/0、页面正常，正式时长 0、账本 0 行，与尚未结算一致。撤权后列表恢复 500/50000。已结算非空账本、正式结算写入 NOT_RUN |

定位账本失败时，使用隔离观察器仅投影该路由的 reqId、Prisma 码、SQLSTATE 和表名，并交还原异常处理器。请求 `cmwogvx1rd15c390e3f51be894bf4ed5b` 同时取得 HTTP 500/50000、P2010、42501、ParticipationLedgerEntry。初次 500 的请求号另存。观察器第一次启动因脚本文件权限失败，修正该只读脚本的文件权限后复现成功。成功复测使用原后端产物，卸载了观察器。

源码的本人账本分页读取 13 个分录列，以及批次 id、statusCode，业务筛选约束为 committed。隔离角色原已具部分列权限，实际缺 **SELECT 六列**：cappedOutPointsDelta、entryKey、entryTypeCode、participationIdentityId、recognizedPointsDelta、sessionId。仅在一次性库暂授这六列，随后逐列撤回，基线一项未差。共享候选只读采样显示 **13 个分录列全部缺 SELECT**，两个批次列可读。此处的六列经验只适用于装配过的隔离基线。正式部署应将本人账本读面纳入运行角色契约预检及非所有者回归，结合既有角色共享范围一并审查。[固定查询源码](https://github.com/BA7IEE/srvf-nest-api/blob/dd62ce308f9142e8b3be04e9c4d52f548c0ebb17/src/modules/activities/ledger-query.service.ts#L367)

## 备份、回退和复原

1. Worker 排空后停止试验 API，备份运行中的后端覆盖层、两套静态产物、反代配置和隔离数据库。文件包含校验和；合成库 dump 为 0600，仅留服务器本地。
2. `pg_dump -Fc`、向新建空库执行 `pg_restore --single-transaction --exit-on-error` 均 exit 0。源库与恢复库的业务和审计投影逐字一致，本人账本的 15 项列权限也一致。
3. 隔离服务实际退回旧后端 #1444 与当前 H5 官方未接通构建。旧后端运行角色设为事务默认只读；健康检查 HTTPS 200，浏览器显示“服务尚未接通”，页面 API 调用 0。这个回退档会暂停 H5 业务。
4. 从备份重新解包最终配对，核对后端和 H5 全部文件摘要及管理端清单，反代配置测试成功。原队员重新登录，原签到读回 200/0。该步使用原隔离业务库；新恢复数据库另外完成数据和 ACL 对账。
5. 退役前再次确认积压 0，保留 23 条脱敏审计投影及摘要。10 个专属容器、隔离网络、试验凭据和合成库临时备份已退役。公网切换、生产数据库恢复、旧版继续提供 H5 会话均为 NOT_RUN。

## 仍需维护者决定的六点

1. **配对范围**。受审后端 #1445、按依赖顺序的 H5 #3→#4→#5、管理端 #172。任何合并决定以届时精确 HEAD 为准。
2. **审批状态**。#1445 红区已成功，GitHub 当前无 review 记录。T47 独审及 T48 工程实测分别留证。本轮业务仓源码无新提交。
3. **影响**。公网 H5 依赖同源代理、浏览器安全会话与合规数据库角色。共享候选的账本权限和 B130 均没有新增授权。
4. **验证**。服务器非公网、桌面 Chromium 和数据库恢复已有回执。新请求与数据关系可用 `python3 verify.py` 复算。T47 已测 P0-E 和未变页面继续适用其原范围。
5. **回退**。配对备份与 H5 暂停档已在隔离站验证。公网切换仍需单独确认现场备份、代理范围、入口恢复及业务影响。
6. **建议**。合并可独立决定。暂缓公网 H5 切流，先补齐运行角色合同与设备证据。实机只需接入一台已解锁、已授权调试的手机，允许它到达仅供试验的受信 HTTPS 地址；微信验收在同一台设备打开该地址。设备记录为 USB 识别 0、xcdevice 真机 0，CoreDevice XPC 失败。设备定位、微信 WebView、公网 H5、真人开放均为 NOT_RUN。Simple 模板当前拒绝要求定位的场次，实机接入本身不能补齐这个合同前置。

[试验数据与逐项退出结果](trial.json) · [设备探测](devices.json) · [T47 原始证据](https://github.com/BA7IEE/srvf-nest-api/tree/929f33cdd77aa2a0c7207c43161c8aa9deeb9ad3/docs/ops/runtime-acl/t47)
