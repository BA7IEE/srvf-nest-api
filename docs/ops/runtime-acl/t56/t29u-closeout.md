# T56/T29u 最终收尾批次（可交维护者执行 · 未执行 merge/close）

**时刻**：2026-11-20 Asia/Shanghai · Mobile base→main 缺口已闭 · T56 独审 PASS

## 候选配对（精确）

| 仓 | PR | base | HEAD | 原生 CI | 独审 |
|---|---|---|---|---|---|
| nest-api | [#1447](https://github.com/BA7IEE/srvf-nest-api/pull/1447) Draft | **main** | `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9` | **16/16** | T55 PASS |
| Mobile | [#5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) Draft | **main** | `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | run [44705508066](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44705508066) **SUCCESS**（vs main 全量；旧 #4-base checks 作废） | T56 PASS |
| Admin | [#172](https://github.com/BA7IEE/srvf-admin-web/pull/172) Draft | **main** | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | verify SUCCESS | 配对成立 |

Mobile 相对 main：5 commits / 45 files；#3 tip `ce14f84b…`、#4 tip `5e5be8dc…` 均为 HEAD 祖先（behind=0），无栈外独有提交。

## 建议合并顺序（维护者操作 · 本轮未执行）

1. nest-api **#1447 → main**（先 ready-for-review 再按仓库规则 merge）
2. Mobile **#5 → main**（确认 base=main、HEAD=`529ee3a3…`、CI 44705508066）
3. Admin **#172 → main**

## 合入成功后拟关闭（当前请保持 OPEN）

| 关闭对象 | 前提 |
|---|---|
| nest [#1445](https://github.com/BA7IEE/srvf-nest-api/pull/1445)/[#1446](https://github.com/BA7IEE/srvf-nest-api/pull/1446)/[#1439](https://github.com/BA7IEE/srvf-nest-api/pull/1439)/[#1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444) | #1447 已合入 nest main 且内容核实 |
| Mobile [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3)/[#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) | **仅当 #5 已合入 Mobile main**（merged=true、目标 main）后；确认无新的栈外提交 |

## 保留

- nest [#1442](https://github.com/BA7IEE/srvf-nest-api/pull/1442) 材料/证据（含 t55/t56 记录）
- 共享 13 列 SELECT / B130：GRANT=0，权限另批

## 两新迁移部署前（运维 · 非独审授权）

- `20261120073000_settlement_deferred_correction_guard` / `20261120073100_settlement_correction_proof_lookup`
- 仅 CREATE OR REPLACE FUNCTION；无回填、无 GRANT、无破坏性表变更
- 需目标世代兼容；回退可还原函数并复现旧 42501，**不撤销已过账数据**；须同步受信源摘要
- 生产施加/备份流程 **≠** 独审 PASS

## 仍阻塞上线充分性声明

共享账本读权、公网、真机/微信、正式切流 = NOT_RUN。不重复索 `65d1d6ea` 红区。
