# T55/T29u 首发收尾索引（建议卡 · 未执行 merge/close）

**时刻**：2026-11-20 Asia/Shanghai · 独审 PASS · 原生 CI 16/16

## 唯一首发候选配对（建议采用）

| 仓 | PR | 精确 HEAD | 原生检查 | 独审 |
|---|---|---|---|---|
| nest-api | [#1447](https://github.com/BA7IEE/srvf-nest-api/pull/1447) Draft | `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9` | **16/16 SUCCESS**（含 Red-zone trusted approval） | T55 **PASS** |
| Mobile | [#5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) Draft | `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | 2 pass | 配对于隔离验收 |
| Admin | [#172](https://github.com/BA7IEE/srvf-admin-web/pull/172) Draft | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | verify pass | 配对于隔离验收 |

祖先链（#1447）：`dd62ce30`(#1445) + `4c8cba0a`(#1446) → `fa77c19a` → `259358ac` → `65d1d6ea`。相对 main：ahead 17 / behind 0 / 74 files。

固定证据：
- T54 https://github.com/BA7IEE/srvf-nest-api/tree/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54
- T53 https://github.com/BA7IEE/srvf-nest-api/tree/5f8f2e4336b4e2d3abdb40c577585fe0dfce9b30/docs/ops/runtime-acl/t53
- 红区 job https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696116951/job/136153250156
- CI run https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601

## 建议合并批次与顺序（未执行 · 待维护者）

1. **nest-api #1447** → main（含 H5 Cookie/Simple 发布/短信修复/账本预检/结算终审 42501 两迁移）
2. **Mobile #5**（依赖后端同源会话与活动/账本契约；#3/#4 为其祖先）
3. **Admin #172**（活动冻结指标与发布后变更审核；与候选后端配对验证）

合并前：确认目标库迁移世代可施加两新迁移；共享库 ACL 合同另议（见阻塞）。

## 候选合入且证据成立后 · 拟关闭（superseded-by · 现仅标注关系，未 close）

| PR | 关系 | 理由 |
|---|---|---|
| [#1445](https://github.com/BA7IEE/srvf-nest-api/pull/1445) `dd62ce30` | superseded-by #1447 | tip 为 #1447 祖先；功能已进入组合 |
| [#1446](https://github.com/BA7IEE/srvf-nest-api/pull/1446) `4c8cba0a` | superseded-by #1447 | tip 为 #1447 祖先 |
| [#1439](https://github.com/BA7IEE/srvf-nest-api/pull/1439) H5 Cookie | superseded-by #1447 | tip `47959402…` 为 #1447 祖先（behind 0） |
| [#1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444) Simple 草稿确认 | superseded-by #1447 | tip `713d3416…` 为 #1447 祖先（behind 0） |
| Mobile [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3)、[#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) | superseded-by #5 | tip 均为 #5 祖先 |

**注意**：旧 PR **未 merge 前不得宣称“已被交付取代”**；合入 #1447/#5 后再 close。

## 继续保留

| PR | 去向 |
|---|---|
| [#1442](https://github.com/BA7IEE/srvf-nest-api/pull/1442) 材料/预检 ops `833d4ddf` | **保留**：证据/预检材料仓；可独立合入，非业务运行时必需；Diff guards 已绿 |
| 共享 13 列 SELECT / B130 | **保留为权限决定**：本批 GRANT=0；与 #1447 源码合并解耦 |

## NOT_RUN / 首发阻断（非“可宣称上线充分验证”）

- 共享 `srvf_staging`：`ParticipationLedgerEntry` **0/13** SELECT；隔离 ACL ≠ 共享合同
- 公网业务、真机/微信、真实投递、正式切流
- RLS 隐藏更正申请的专项运行（源码路径已审，现场 RLS 关）

## 共享 13 列风险卡（可询 · 未实施）

- 库/身份：`srvf_staging` / `srvf_dp_acceptance_runtime`
- 差额：分录表 13 列全缺；批次 `id,statusCode` 已有
- 列：`activityId, cappedOutPointsDelta, creditedPointsDelta, entryKey, entryTypeCode, ledgerDate, memberId, participationIdentityId, postingBatchId, recognizedPointsDelta, resultRevisionId, serviceHoursDelta, sessionId`
- 影响：无 RLS；同 DB 身份直连 SQL 可跨成员/活动/待入账；应用层本人过滤不能约束直连
- 与 B130 **隔离**（B130 另五表，不在本卡）
- 草稿 SHA-256：施加 `e356f2f2…203b78`；回退 `e41c091f…389654`；隔离演练有错目标/施加/重复/撤回回执
- **撤权保留数据**；同授予者后重授不可用旧回退脚本区分
- 本批 **0 新增 GRANT**

## 真正需人（集中）

1. 是否 merge 上述建议批次（#1447 → #5 → #172）及合入后 close 列表
2. 是否批准共享 13 列只读（数据负责人）
3. 设备/公网验收安排（未跑）
