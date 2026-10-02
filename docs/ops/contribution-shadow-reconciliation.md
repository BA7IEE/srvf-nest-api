# 贡献影子对账：复核读面与受控签字

本文件描述 E3-2 D3 的技术候选实现；尚未提交、未部署，不代表真实业务验收。生产仍 NO-GO，shadow／Gate 保持关闭，D8-OPS 未执行。测试窗口、合成映射和夹具签字均不能替代真实目标、逐项映射批准或真实对账。

## 1. 三项独立权限

| 用途                   | 权限码                                 | 入口            |
| ---------------------- | -------------------------------------- | --------------- |
| 查看最小证据           | `contribution-shadow.read.evidence`    | 五个 System GET |
| 登记未来窗口           | `contribution-shadow.register.window`  | 受控 CLI        |
| 逐候选签字、修订、撤销 | `contribution-shadow.sign.disposition` | 受控 CLI        |

均要求当前 ACTIVE Human、有效显式 GLOBAL 授权。十五个内建角色零默认授予，SUPER_ADMIN 不直通，Service Principal 和 delegation 禁止。读权限不赋予窗口登记或签字能力，也不继承旧映射登记权限。

## 2. 五个读接口

统一根路径 `/api/system/v1/contribution-shadow`；仅 GET，不提供 HTTP 写入口。

| 路径                                                 | 用途                                 |
| ---------------------------------------------------- | ------------------------------------ |
| `/windows`                                           | 分页窗口，区分正式登记和历史未签窗口 |
| `/windows/:windowId/summary`                         | 单窗口原始／净缺口汇总               |
| `/windows/:windowId/candidates`                      | 分页候选、原因及签字状态             |
| `/windows/:windowId/candidates/:auditLogId`          | 单候选详情及当前签字摘要锚点         |
| `/windows/:windowId/attempts/:attemptId/comparisons` | 同窗口指定尝试的分页比较行           |

分页统一 `page`／`pageSize`，最大 100；内部锚点使用 1–128 位受控 ASCII 标识。响应沿全局包装。未登录 `40100`、无显式权限 `40300`、不存在或跨窗口锚点 `40400`、非法参数 `40000`；不创建新的业务错误码。

返回内部链路 ID、计数、原因、定长摘要及十进制字符串；不返回姓名、电话、密码、令牌、原始审计 context、政策正文或 `candidateEvidence`。列表中的 `candidateEvidenceHash` 为 null，详情才计算当前单候选锚点；不要把历史 `evidenceHash` 当成当前可签摘要。每次成功读取在同一事务记录最小审计；审计失败不放行结果。

## 3. 计数与签字含义

- 候选数 = 有尝试候选数 + 原始缺开始数。
- 有尝试候选数 = 有终态候选数 + 原始缺终态数。
- 净未解决数 = 原始未解决数 − 有效不适用数 N。
- 同一候选有多个原因时，汇总未解决数只算一项；原因计数允许重叠。

`confirmed_gap` 只确认缺口，不清零。`not_applicable` 仅允许已关闭正式窗口中的 `resubmit`／`edit-no-records`，逐候选批准，证据新鲜且没有来源／链路异常、失败、hold、error 或 mismatch。不能因为开关关闭、未知操作、缺映射或已有问题而批量排除。未知操作保留缺口，不自动签字。

历史未签处置不计入 N。新签字追加独立不可变批准收据和处置；撤销追加下一修订，不改删旧记录。迟到尝试、比较或终态改变证据后，旧签字显示 `stale_evidence`，不再抵扣缺口。窗口／候选为零显示 `zero_visible_candidates`，含义是当前没有可见证据，不是验收通过或允许上线。

## 4. 清单校验与执行分开

在仓库目录运行默认校验，仅解析文件及复算清单摘要，不连接数据库、不认证、不登记，也不代表批准：

```zsh
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm exec tsx scripts/register-contribution-shadow-reconciliation.ts \
  --manifest /绝对路径/已批准清单.json \
  --expected-manifest-hash 已复核的64位小写十六进制摘要
```

窗口清单包含 `schemaVersion=1`、`operation=register_window`、`commandKey`、`approvalReference`、`windowId`、规范 UTC 毫秒 `startsAt/endsAt`、`deploymentDigest/configDigest` 和 `signedMappingVersion`。开始必须晚于数据库登记时间，区间不得重叠，映射版本必须有既有有效批准。不得倒填过去窗口。

签字清单使用 `operation=sign_disposition`，另含 `auditLogId`、`expectedPreviousDispositionId`、`expectedRevision`、`decisionCode`、`basisCode`、详情提供的 `expectedCandidateEvidenceHash`。首修订前驱为 null；之后必须严格绑定上一处置。三种决定对应依据为 `not_applicable/outside_comparison_contract`、`confirmed_gap/observed_gap`、`unresolved/withdraw_previous`。不接受自由证据正文、自由说明、客户端时间或客户端 actor。

只有维护者另行批准具体环境、精确清单、当前 Human 和短期 DB authority 后，才允许添加 `--execute`。凭据只能通过非回显私有 stdin JSON 提供，键仅 `registrarDatabaseUrl`／`accessToken`；不得放在 argv、清单、终端历史、截图或日志。运行时不从默认连接回退，不以客户端 GUC 自授权限。此文件不提供真实凭据或生产执行授权。

同一命令同输入重放复核当前资格，仅返回既有最小收据，不重复审计；同键异输入拒绝。批准、处置及审计同一五秒事务闭环，任何失败整体回滚。

## 5. DB 身份分离与关闭

具名 ACL 文件为 `scripts/sql/contribution-shadow-reconciliation-roles.sql`。仅维护者以确切 DB 目标和 `bootstrap`／`bind`／`close` 执行；脚本不创建 LOGIN 或密码，不修改旧映射 ACL。默认 authority 为 null，登记函数对 PUBLIC 无 EXECUTE。

owner／registrar／reader 三个 NOLOGIN 角色互不继承；真实执行 LOGIN 只能继承 registrar，禁止超级权限及 owner／reader membership。owner 仅拥有新两张表和具名 D3 函数，函数固定 search_path；registrar 仅有最小 Human／RBAC 投影和被短期批准的登记 EXECUTE。reader 只能获得允许名单读函数和安全字段，不读取原始审计、批准正文或密码。

API 仍使用既有应用连接完成正常身份认证、属主读查询和最小审计；reader 是额外最小 DB 读面，不声称一个只有 reader 的账号就能启动整个应用。应用 LOGIN 不得继承 registrar 或 owner。关闭登记授权不改变历史收据，不启用业务开关。

## 6. 验证和验收边界

本地只允许 `app_test_w98`，四个具名夹具角色为 `srvf_d3_{owner,registrar,reader}_w98_fixture` 及 `srvf_d3_login_w98_fixture`，结束撤权回收。标准 Contract／E2E 全局初始化会操作模板和其他 worker 库，不能凭 w98 许可执行；使用已批准的 w98 内存配置，其他固定库套件交 PR CI 冷跑。

测试夹具清理只在安全目标、具名受控事务内临时停用 no-truncate 守卫，必须恢复原状态；两新表半套存在、具名守卫缺失或恢复失败均拒绝。业务数据、生产和历史证据不清理。

第136条 SQL 定稿另签3b；三个权限、三个审计和新增 DB 执行面另签4b。本地技术验证及签字齐后才创建 Draft，CI 全绿不自动赋予 Ready、合并、部署、真实映射／窗口／签字或上线许可。

**本次未做**：真实目标登记、逐项真实映射签字、真实业务对账、正式贡献结算、生产操作、部署、shadow／Gate 启用及 D8-OPS；不删除或重算业务数据。
