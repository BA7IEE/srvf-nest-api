# T52 首发交付收尾

2026-11-20 核实。可交维护者决定合并的非公网三端配对为后端 #1445、移动端 #3 → #4 → #5、管理端 #172。部署含本人账本的版本还要带上 #1446 的预检和短信修复。**两个后端 PR 单独绿，叠加时有一处生成文件冲突。共享候选账本预检仍拒绝，公网 H5 放行条件尚未满足。**

## 版本与去向

| 交付项 | 冻结 HEAD | 原生检查 | 建议 |
|---|---|---|---|
| 后端 [#1445](https://github.com/BA7IEE/srvf-nest-api/pull/1445) | `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` | 15/15 成功，含 trusted approval | 先处理组合。#1439、#1444 均为其祖先，分别落后 9、8 个提交。进入 main 后核实源码及回归仍在，再由维护者决定这两条 PR 的关闭。 |
| 账本及短信 [#1446](https://github.com/BA7IEE/srvf-nest-api/pull/1446) | `4c8cba0af25abe4587533c513489729a5f219fbe` | 14 成功、1 跳过。四项必需检查全部成功 | 按所选最终基线用仓库生成器更新授权清单，复核最终 HEAD 的原生 CI。T51 独审 PASS 绑定原 HEAD。 |
| 移动端 [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) → [#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) → [#5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) | `ce14f84b5add85de11816136a0ef975a28ff7b7e` → `5e5be8dc11daf86781cf648c8c35572b3e79df60` → `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | 每个 HEAD 均有两个成功的 check 作业 | #4 目标为 #3 分支，#5 目标为 #4 分支。最终验收产物取 #5。逐层整合，核新 base、目标树及原生检查，避免重复引入。 |
| 管理端 [#172](https://github.com/BA7IEE/srvf-admin-web/pull/172) | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | verify 成功 | 负责 Simple 管理页。相对当前 main 领先 3 个提交、落后 1 个，main 独有变化只有 README.md。#170 建档页、#171 结算页与它均分叉，仍各归原 PR 验收。 |

三仓共 28 个开放 PR，全部是 Draft。后端有 29 个开放 Issue，另核 12 个已合并 PR 的合并提交，均在后端 main 及 #1445 的祖先链。矩阵按六类记录责任去向，CI 逐项保留作业链接。独审按已有回执标注；GitHub 审查决议单列。#1442 是材料分支，其基准 CI 与各业务仓原生 CI 分开记录。[完整矩阵](MATRIX.md) · [GitHub 查询快照](inventory.json) · [祖先关系](ancestry.json) · [与当时 main 的差额](base-comparisons.json)

## 两个后端提交如何组合

共同基线是 `2b3eee0a954ea65abaef3edb35fd391eaa1567e9`。Git 预演返回 1，唯一冲突文件是 `docs/ai-harness/ROUTE_AUTHZ.md`。临时源码树使用仓库生成器从组合源码重建，校验通过，共 676 个声明端点。相对 #1445 的清单只有两处 inputDigest 随源文件更新。组合预演 Git tree 为 `e6b67c20aa799192b13e8c8eff17957eff5fc073`；构建 exit 0，通知元数据保护定向单测 50/50。该树没有业务分支提交或原生 CI 作业。#1446 自身的原生短信 E2E 沿用 T51 固定 HEAD 证据。[预演差异与命令](backend-combination.json) · [T51 独审原文](previous-t51-independent-review.md) · [短信分片](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44682887628/job/136110436475)

## 服务器验收

| 范围 | 实测及退出码 | 发布意义 |
|---|---|---|
| 共享候选，只读 | 在 `srvf_staging` 的活动连接中核对了 API 容器地址和运行角色，API 镜像 revision 标签为 `108feebb84b85c7e4955c5af8bbfc016702e4529`。运维身份代查精确版 #1446 预检，CONNECT、USAGE 和批次两列可用，分录 13 列仍缺。预检 exit 3，核对预期结果 exit 0，共享新增授权 0。 | **BLOCK**，以当前共享角色部署含本人明细的 H5 会缺权限。 |
| srvf 一次性 PostgreSQL | 使用无网络、仅私有 socket 的新 PG，运行真实迁移。先复现缺 13 列，预检 exit 3。在该临时库补足差额，运行角色自行预检 exit 0；以数据库非所有者执行组合构建中的真实 LedgerQueryService。两名合成队员各读回本人 2 条已提交分录，准备好的未提交批次和他人活动过滤均返回 0，翻页无重漏。 | **PASS**，覆盖分录非空时的查询及过滤。数据来自仓库的读面夹具。 |
| 同一隔离角色撤回 | 撤本次 13 列后预检 exit 3，实际读取报 PostgreSQL 42501，6 条合成分录均保留。核对脚本 exit 0。试验容器、socket 卷及上传目录已清理。 | **PASS**，权限回退与数据保留均有回执。 |
| 既有非公网三端 | T48 实际组合验证了同源 HTTPS、管理端独立发布、普通队员严格保险报名、图片签到、本人在场读回、审计关联、Worker 排空以及隔离备份恢复。 | **PASS** 仅限原三端版本和隔离拓扑；本批新增验证聚焦两个后端 PR 的组合及账本。 |
| 完整结算写入→非空账本→H5 页面；微信/真机相机与定位；目标版本公网业务、真实供应商投递及真人开放 | **NOT_RUN**。隔离账本采用合成已提交批次，历史图片扫码用桌面浏览器。要求定位的 Simple 场次另有模板坐标合同前置。 | 分别交结算/H5、设备、部署及发布负责人验收。 |

共享候选的 SQL 只读代查与运行角色在隔离库直连分别留有身份标志。[共享逐列回执](shared-preflight.json) · [隔离读回和撤权结果](nonempty-isolated.json) · [复现步骤](REPRODUCE.md) · [T48 实际产物哈希](../t48/build-inputs.json) · [T48 独审](../t48/independent-review.md)

## 待人决定与责任去向

1. **代码整合。** 维护者决定上述合并集合与次序。#1445 当前 SHA 的红区条件已满足。后端合成后的真实提交应有自己的原生 CI 及对应审查；本次临时 tree 和材料分支不提供该状态。移动端保留三层堆叠；管理端的结算和成员页面各自保留负责人。
2. **共享账本权限。** 若仍采用该共享身份，维护者仅需就分录表 13 列 SELECT 的实际差额评估读范围。同角色进程可能跨队员、跨活动读取关联、时长和分值，亦可直接接触未提交批次的数据；应用的本人过滤仅约束正常接口。回退仅撤届时实加列，保留已有批次权限与业务数据。B130、写权限及其他表不在此卡。T45 隔离基线已有 7 列，故原隔离实验余缺 6 列；本次共享实测为 13 列。[13 列、影响及撤回边界](../t51/shared-ledger-decision.md) · [拟议差额](../t49/future-delta.json)
3. **真机。** 设备持有人接入一台已解锁、信任调试主机且能访问受信试验 HTTPS 的手机。工程侧复建隔离入口，分别记录浏览器和微信登录恢复、报名、相机签到及可用定位场景。已有设备盘点识别数为 0。[设备回执](../t49/devices.json)
4. **公网和真人开放。** 待最终产物、权限预检、业务/设备验收和目标环境回退方案齐备，由维护者分别决定公网切流与真人开放。生产总放行仍归 #940，供应商、生产恢复演练、监控及隐私等 P0 留在各自 Issue。此前 #1419 的公网 413/40000 有独立桥接回执，不能代替最终版本公网业务验收。[#940](https://github.com/BA7IEE/srvf-nest-api/issues/940) · [#1419 原始脱敏回执](https://github.com/BA7IEE/srvf-nest-api/blob/0411a4ecd0348f5311228cca4fb17c7f446e8e9e/docs/ops/verification/t21/1419-public.json)

T52 开发段交付矩阵及实测证据。后续串行独审核对本目录固定提交、组合差异、隔离范围和关单条件。
