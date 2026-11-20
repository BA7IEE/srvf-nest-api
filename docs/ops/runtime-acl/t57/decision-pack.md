# T57 维护者决策包：共享账本权限 / 部署 / 公网验收
生成：2026-11-20 17:14:26 UTC+08:00 Asia/Shanghai · **建议卡，未实施 GRANT/B130/公网切流/生产部署**

## 背景
t30u 已授权并完成三仓代码合入 main（见 merge ledger）。t31u 起：已确认需求范围内常规 merge 在 checks/独审/保护满足后可执行，**不**扩大生产权限边界。本包供维护者决定下一步。

## A. 共享账本 13 列 SELECT（推荐：暂缓；若验收 shared H5 再最小批）

| 项 | 内容 |
|---|---|
| 库/角色 | `srvf_staging` / `srvf_dp_acceptance_runtime` |
| 当前预检 | 分录表 **0/13** SELECT；批次 `id,statusCode` 已有（T53/T55 只读目录核） |
| 列 | `activityId, cappedOutPointsDelta, creditedPointsDelta, entryKey, entryTypeCode, ledgerDate, memberId, participationIdentityId, postingBatchId, recognizedPointsDelta, resultRevisionId, serviceHoursDelta, sessionId` |
| 风险 | 分录表无 RLS；同 DB 身份直连 SQL 可跨成员/活动/待入账；应用层本人过滤不约束直连 |
| 与 B130 | **隔离**（B130 另五表，不在本卡） |
| 草稿 SHA-256 | 施加 `e356f2f2e24d478f6f7545165f986b9882bea8f09639085905bd550bc7203b78`；回退 `e41c091f98f397657fe748c97bb67bc4cf03c5910b5a8c80d68b49a4dd389654` |
| 隔离演练 | 错目标拒绝/施加/重复拒绝/按列撤回；撤权保留数据；同授予者后重授不可用旧回退区分 |
| **推荐** | **本批不实施**（GRANT=0 维持）。仅当必须在 shared 上做本人 H5 账本验收时，由数据负责人批最小 13 列只读+固定回退脚本，并记录 receipt。 |

## B. 部署（推荐：内部验证轮；人工 runbook；勿自动跟 main）

| 项 | 内容 |
|---|---|
| 源码 main | nest `65bad1cc…`（含已审 `65d1d6ea`）；Mobile `ae2e3b0a…`（含 `529ee3a3`）；Admin `26261168…`（含 `104e524c`） |
| 两新迁移 | `20261120073000_settlement_deferred_correction_guard` / `20261120073100_settlement_correction_proof_lookup`：仅 CREATE OR REPLACE FUNCTION；无回填/GRANT |
| 兼容 | 目标世代需可 156→158；空库重放过 |
| 备份/回退 | 施加前备份；DDL 可还原函数并复现旧 42501；**已过账数据不随回退消失**；须同步受信源摘要 |
| 产物 | 配对构建：后端 dist/镜像摘要、Mobile H5 artifact、Admin 静态清单（T48/T54 已有隔离摘要；生产构建须重新取证） |
| 停回条件 | 迁移失败/健康检查失败/冒烟登录失败 → 停；不自动切公网 |
| **推荐** | 按 `docs/ops/server-deployment-runbook*.md` 做**内部验证轮**（envPrefix=staging）；**禁止**依赖「盯 main 自动升级」。 |

## C. 公网 / 真机微信验收（推荐：部署内部验证通过后再排）

具体步骤（摘要）：
1. 内部验证环境 HTTPS 同源：后端+H5+Admin 配对版本就位
2. 真机微信：登录/续期/退出、保险、签到、本人账本非空（依赖 shared 读权或隔离只读合同）
3. 负例：匿名/他人/撤权
4. 公网拓扑：反代、可信 IP、证书、APP_ENV=production 检查清单
5. **NOT_RUN 直至维护者排期**；绿 CI ≠ production PASS

## 真正需人（集中）
1. 是否批共享 13 列（及是否同时排除 B130）
2. 是否启动内部验证部署（谁执行 runbook、目标机）
3. 真机/公网验收窗口
