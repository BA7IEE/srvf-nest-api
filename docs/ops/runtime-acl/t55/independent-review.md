# T55 独立只读审查

**结论 PASS。** 精确 HEAD `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9` 修复了 T53 的普通终审故障。在同一项隔离活动上，终审成功、Worker 过账、负责人结案，H5 本人读到新增两笔分录。合法受信更正在该 SHA 的原生 CI 通过，普通运行角色调用受保护函数仍得 42501。#1447 保持 OPEN、Draft，16/16 项原生检查成功，含该 SHA 自己的红区批准。共享候选账本仍缺 13 列读权，公网及实机验收为 NOT_RUN。[正式 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1447) · [T54 固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54)

## 已闭

### 版本、迁移和权限

我核对了开发报告、末条交接、固定证据树 10 个 GitHub 文件对象及清单中 9 个 SHA-256。Git 祖先链为 `fa77c19adfd12c918145e1ac8e040401498a5835` → `259358acddbc899971a7a5f3ae63a4bb45a6eb33` → 本次 HEAD，原父提交 `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` 和 `4c8cba0af25abe4587533c513489729a5f219fbe` 均在祖先链中。相对 T53 共 7 个文件、增加 304 行、删除 4 行。两份新迁移各只有一条 `CREATE OR REPLACE FUNCTION`。其余差异为变更说明、迁移清单、受信 CI 源绑定及测试。应用行为代码、Prisma schema、冻结目录、harness 和 workflow 均无差异。[实际 diff](https://github.com/BA7IEE/srvf-nest-api/compare/fa77c19adfd12c918145e1ac8e040401498a5835...65d1d6ea4caaa815faac0e79ead8846b6cc3ade9) · [开发报告](https://github.com/BA7IEE/srvf-nest-api/tree/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54) · [末条交接]((T54 lastmsg; local handoff))

| 新迁移 | 独立重算的 SQL SHA-256 | 与历史函数逐行比较 |
|---|---|---|
| `20261120073000_settlement_deferred_correction_guard` | `38867d6ba7ebf72a2ca652c064bdbe8ffc674fba8c3b56d292d806cba1183d82` | `ctsp_lifecycle_guard()` 将复合 IF 拆为嵌套 IF。只有查到对应更正申请才到达受保护函数调用。 |
| `20261120073100_settlement_correction_proof_lookup` | `c5ba4ff229d717f52ed46d9d2c30585976f08a1196a955f10032629bc2517bd7` | `ctsp_assert_complete(text,boolean)` 显式限定 public schema，在读证明前增加一个提前返回条件。原有证明锚点、计数、绑定集合与异常检查逐字保留。 |

156 份旧迁移的路径及 Git blob 与 T53 全部相同。两份新增 SQL 的摘要同时吻合隔离现场输入和清单常量。独立从 Git 提取两组旧、新函数体所得的四个摘要与数据库回退回执相符。受信 CI 对 base、supplemental 两份目录分别要求目标签名唯一且旧摘要精确匹配，随后仅替换两个 `bodyHash`。源码漂移负例从两个旧位置扩至包括两个新增位置，冻结字段仍逐项比较。[迁移清单](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/test/helpers/migration-inventory.ts) · [受信源绑定](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/test/helpers/r5-ci-source-binding.ts#L120) · [回退回执](/private/tmp/srvf-t54/pair-rollback.json)

两函数在该隔离库均由 `postgres` 持有，以调用者身份运行，原 ACL 均为 NULL（沿用默认 ACL）。触发器函数固定 `search_path=pg_catalog, public, pg_temp`；完整性函数沿用原先无函数级 SET 的配置。从触发器调用时使用前者的有效搜索路径。两函数替换前后身份、OID 与 ACL 相符。独立的受保护函数 `r5_correction_phase_deferred_registered(text)` 保留原函数体及限定角色的 EXECUTE；普通 API 无 EXECUTE、无受信成员资格，对 `CorrectionTimeSourceProof` 的任一列均无 SELECT。两份产品迁移没有 GRANT 或业务数据写入。[函数目录回执](/private/tmp/srvf-t54/catalog-final.json) · [冻结函数目录](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/test/fixtures/r5-ci-source-catalog.json)

**RLS 判定成立，证据层次有别。** 只有对当前执行角色 `row_security_active(CorrectionApplication)` 为假，且找不到该批次的申请时，完整性函数才提前返回。有可见申请时，触发器沿原有受信延迟登记规则处理，未获延迟的继续检查。申请表启用对当前角色生效的 RLS 时，即使查询返回空，新增捷径也不可用，继续执行原证明查询及检查。T54 现场申请表 RLS 关闭，RLS 实际隐藏申请的专门回归为 **NOT_RUN**；该分支结论依据实际 SQL。首个修补独立施加后仍因无权读证明表而失败，说明第二处修改确有必要。[第一份迁移](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/prisma/migrations/20261120073000_settlement_deferred_correction_guard/migration.sql#L28) · [第二份迁移](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/prisma/migrations/20261120073100_settlement_correction_proof_lookup/migration.sql#L11) · [仅装第一份的拒绝回执](/private/tmp/srvf-t54/narrow-first.txt)

### 三条非所有者路径

| 路径 | 判定 | 核到的行为 |
|---|---|---|
| 普通终审 → Worker → 关账 → 本人 H5 | **PASS，srvf 隔离栈** | T54 新建一项活动并沿用同一结算版本。先后为旧库 500/50000、仅第一份迁移 500/50000、两份齐备 200/0。终审后 1 个 preparing 批次、0 条分录。实际 `ActivityBatchWorker.drainOnce()` 用独立非所有者登录领取 `settlement_prepare`，处理 1 项、失败 0，提交成功。关账 200/0，最终 1 个 committed 批次、1 条关账记录、本人 2 条分录，合计 0.67 小时、1.5 分。 |
| 合法受信更正 | **PASS，GitHub Actions 专用实例** | 独立读取工件 `14611117220`，压缩包 SHA-256 与 GitHub 摘要相符。实际身份资格检查通过，4 个套件均 exit 0。D7 日志点名提交、退回重提、审核、prepare、commit 用例通过；源码明确断言 `correctionStatus=applied`、`applicationStatus=committed`，同批次重放为 true。srvf 隔离栈未部署这条受信通道。 |
| 普通身份误用受保护更正 | **PASS，srvf 隔离栈** | 普通 API 实际连接先核自身角色，再在只读事务中调用受保护函数，实际 SQLSTATE 42501。另有未受信 provider 拒绝的原生回执。普通队员走生成及初审 HTTP 路径也分别得到 403/30100。 |

封存、生成、提交、初审、终审、关账共六个成功请求的 reqId 摘要、操作者与成功审计逐条一致。审计事件名共用 `activity.publish`，步骤由 HTTP 路径区分。七个数据库快照均对应同一活动，Worker 补齐隔离权限前领取过 0 项，后续实跑才完成过账。原生新增用例另以临时 NOLOGIN 角色在 COMMIT 触发真实函数，断言没有私有 EXECUTE 及证明表读权。真实业务表的写入结果由上述 srvf 同活动回执覆盖。[逐次活动、HTTP 与 Worker 回执](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json) · [请求审计](/private/tmp/srvf-t54/audit.json) · [受信原生作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136153355319) · [D7 提交与重放断言](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts#L3169) · [普通连接拒绝](/private/tmp/srvf-t54/ordinary-denied-final.json)

**H5 正反例可复核。** 桌面 Chromium 使用内部同源 HTTPS。本人明细 200/0，两张记录卡均属本活动，并实际打开说明；另一队员 200/0、零条，匿名 401/40100。撤回隔离库原补的六列后，以本人账号复测，明细 500/50000、卡片为零、汇总 200/0，数据库原有两条分录、批次和关账记录均保留。此次后端应用沿用 T53 dist 并施加与 HEAD 字节一致的两份 SQL，前端配对为 Mobile `529ee3a3c441eaaf992049cbbe6ee32f1414fa63`、Admin `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`。39 分钟的考勤输入为历史夹具，本次新增的账本分录来自实际过账。[页面断言](/private/tmp/srvf-t54/s54page.cjs) · [正向及他人读回](/private/tmp/srvf-t54/h5-positive.jsonl) · [撤权回执](/private/tmp/srvf-t54/h5-withdrawn.jsonl)

### 原生 CI 与回退

GitHub run `44696120601` 首轮 D6 的 2,000 人用例在 prepare 报 P2028，事务限时 60,000 ms，实际 66,183 ms；失败发生在该用例 submit 和创建过账批次之前。复跑仍是相同 HEAD、用例、规模、时限与断言。第二轮仅失败分片及其汇总有新的执行时间，分片结果 91/91 套件通过、1,335 个测试通过、1 个既有跳过。本次 prepare 总耗时约 9.820 秒。首轮超时属实，慢在宿主、数据库抑或具体查询仍无定论。最终 16 个检查全部 SUCCESS。独立确认红区 run `44696116951`、job `136153250156` 绑定本次完整 SHA；trusted scan 命中两份新迁移及组合既有的两个鉴权文件。[首轮失败日志](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136153355396) · [同 SHA 复测](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136161756937) · [精确红区作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696116951/job/136153250156)

空库重放 158 份迁移，有待终审活动的库按 156 → 157 → 158 升级。另在一次性库验证双函数 DDL 事务故意失败后整体回滚，恢复两份旧定义后复现拒绝，再施加后窄权 COMMIT 成功。该演练验证函数定义可恢复。今后若在有已过账数据的环境回退，旧故障会恢复，已提交业务数据并不随函数回退撤销，目标环境的受信源摘要也须对应。[迁移与回退证据](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/migration-evidence.json)

## 可工程闭合

- **共享部署条件仍未满足。** 隔离 Worker 另补清单读列、作业入队两列 INSERT，关账路径另补收据读写和两个指针更新。产品迁移不含这些授权。我在共享候选 `srvf_staging` 用只读事务核目录，普通运行角色对账本合同分录列仍为 **0/13**、批次所需列 **2/2**，隔离 Worker 登录不存在。执行材料支持本批共享 GRANT=0、B130 未实施；目录快照只证明采样时有效权限。若安排共享验收，仍需按目标 API 和 Worker 身份分别核部署合同。[隔离 ACL 明细](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/isolated-only-acl.json)
- **NOT_RUN** 包括 RLS 实际隐藏申请的专项运行、公网业务、手机与微信实机、真实签到采集及外部通知投递、共享迁移与授权、正式部署及切流。隔离栈退役时有 7 条待处理测试通知，退役检查 exit 0。D6 的一次长尾可继续用同规模分阶段计时调查；现有证据支持保留原时限和断言。[退役回执](/private/tmp/srvf-t54/retirement.json) · [D6 计时](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/ci-attempt1.json)

## 真正需人

**本次修复验收无需新的用户风险决定。** 精确 SHA 的红区已通过。将来是否合并、是否向共享角色开放跨成员账本读取、是否部署及切流，仍由维护者或数据负责人分别决定。本次独审只读核查源码、GitHub、回执和共享系统目录，未执行这些操作。
