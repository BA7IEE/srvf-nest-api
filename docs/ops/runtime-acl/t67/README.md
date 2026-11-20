# T67 隔离浏览器登录与刷新

固定 H5 在密码校验成功后请求 `/api/app/v1/me` 和 `/api/app/v1/me/capabilities`，刷新页面时调用 `/api/auth/v1/h5/refresh`。T66′ 中，普通成员的 capabilities 与 refresh 均返回 500/50000，数据库报 42501。前一次失败的服务端 reqId 分别是 `cmwp5587772c575c838c7d539a7b4ac2c`、`cmwp558ewf69cd845bc0941d53037897d`。

| 隔离 DB 登录 | 对象与操作 | 在 T63 基础上增加的列 |
|---|---|---|
| t63_api | activity_responsibility_assignments SELECT | canManageRegistrations、canManageAttendance |
| t63_api | refresh_tokens UPDATE | rotatedAt、revokedAt、revokedReason、replacedById |

职责查询以 memberId、status 筛选，数据库执行计划还读取 id，这三列已有读权。会话轮换先原子标记旧行，再把旧行的 replacedById 指向新行。API 从 692 项列权增至 698 项。独立 Worker 沿用原 425 项。库的初始化、迁移和 ACL 安装使用试验库管理员，业务请求由非所有者 t63_api 执行。

## 实现者自测回执

独立内网的 Chrome 158.0.8127.36 访问 `/h5/#/my`。普通合成成员提交密码后，登录、成员信息和能力均返回 200/0；浏览器显示该成员的“我的”页。刷新后，续登、成员信息和能力也均为 200/0，仍显示同一成员。Secure、HttpOnly、SameSite=Strict 的 Cookie 已轮换。数据库只出现同一家族两行，其中一行有效，旧行指向新行，绝对过期时间一致。登录与轮换的 reqId 均匹配本人成功审计。[逐请求回执及 SQL 投影](receipts.json) · [登录和刷新后相同的页面截图](account.png)

| 已安装或已撤回 | capabilities reqId | refresh reqId | 结果 |
|---|---|---|---|
| 安装后 | `cmwp5uycn7481132fb6840dcf876e55a9` | `cmwp5uyo8aabbbd1bcb89e3ef7cfb9618` | 均为 200/0 |
| 撤回六列后 | `cmwp5v4hr876562880e911a96d0c6832f` | `cmwp5v4lp17b5f6d93350825e8eb58c5e` | 均为 500/50000；同一测试窗口依次记录职责表 SELECT、会话表 UPDATE 的 SQLSTATE 42501。密码和成员信息仍为 200/0 |

增量 setup、rollback 各运行两次。安装后扩展预检通过，撤回后 T63 原预检通过、扩展预检拒绝。最后退役试验库及网络。完整脱敏回执与两份截图保存在 `/private/tmp/srvf-t67-browser-acl/evidence/final/`。

## 从空库复验

使用 Python 3.9+、本机 Docker Unix socket、OpenSSL、包含后端固定提交的 Git checkout。依赖 T62 归档卷和 T63 已固定的本地 PG16、Node、Prisma 工具镜像。浏览器使用脚本中按 digest 固定的 Selenium Google Chrome 镜像，浏览器与驱动同处试验网；驱动使用本机已安装的 playwright-core 模块（本次 1.65.1）。若使用 Python Playwright，可将其 `playwright/driver/package` 目录传给 `--playwright-core`。证据目录须为新路径。具体包摘要及获取方式见 [T62 出库说明](../t62/README.md)。

从仓库根目录运行，source 指向包含 `65bad1cc` 的本地 Git 仓库。程序从固定包初始化临时 PG，签发一次性 HTTPS 证书，装入合成账号和 T63 权限。它依次验证缺项预检、增量安装、重复安装、浏览器正例、增量撤回、重复撤回、浏览器反例及基础权限清理。截图、服务端 reqId、PG 投影和回收结果写入指定目录。

```sh
python3 docs/ops/runtime-acl/t67/trial.py \
  --source "$api_source" --playwright-core "$playwright_core" --evidence "$new_evidence_dir"
```

在已完成 T63 建库和角色预置的**本机封闭试验库**，可逐步调用同一入口。容器名和系统标识取自建库时的 target.json。基础配方与浏览器增量依次安装；增量撤回后复核基础配方。两层操作均在原有集群、网络、角色和临时数据盘检查通过后执行。共享候选、生产与远端 seed 不在本配方的目标范围。

```sh
acl=docs/ops/runtime-acl/t63/acl.py
python3 "$acl" setup --container "$pg" --cluster-id "$cid"
python3 "$acl" setup --browser-delta --container "$pg" --cluster-id "$cid"
python3 "$acl" preflight --browser-delta --container "$pg" --cluster-id "$cid"
python3 "$acl" rollback --browser-delta --container "$pg" --cluster-id "$cid"
python3 "$acl" preflight --container "$pg" --cluster-id "$cid"
```

增量操作在单一事务内持 T63 的同一把事务锁。操作前的全库有效权须精确匹配 T63 基础或完整扩展，部分安装、权限漂移和整表权限均触发回滚。rollback 只撤表中六项。退役空库时，待增量撤回后再用原 T63 rollback 清理基础列权。[增量 SQL](browser-delta.sql) · [基础配方](../t63/README.md)

## 分阶段用权与共享影响

**建议先用独立验收库和浏览器专用 API 登录完成会话验收。** 按实际请求核对登录限流、账号/成员、权限范围、会话和审计所需的列，先验普通成员能进入“我的”、刷新后仍为本人、撤权后被拒。T67 验证的是在已通过 T63 的隔离 API 上新增六项的效果。会话路径的 PG 执行投影见 [逐对象的实测用列](observed-browser-columns.json)。成功窗口实际触及 11 个对象、140 项不同的列操作；完整投影来自本次合成账号的请求，未对其他账号状态、全部业务路径或单独从零装入这份投影作充分性验证。

| 阶段或口径 | 已知事实与处理 |
|---|---|
| 浏览器会话 | 职责 SELECT 实测读 id、memberId、status 和两个布尔列，前三列已有。refresh 的两次 UPDATE 分别写三列撤销/轮换标记与一列后继引用。密码校验、能力判断和续登均走 API；这条路径不需要启动 Worker |
| 结算与 Worker | T63 的 692 项来自更大的 API 业务链。单独的 Worker 登录有 425 项，负责直连 DB 领取与提交。本批沿用它的历史证据。现场独立 Worker 身份仍未确认；推迟消费者配置、过账/关账相关写权，待核实身份并进入相应业务阶段再议 |
| 共享候选差异 | T66′ 只读快照中，既有 API 登录在 T63 的 692 项里具备 460、缺 232。加入浏览器的两个新职责读列得到已知差异 234；该登录已有四项 refresh UPDATE。234 是按合同和已观察浏览器路径比出来的差额，不能用作首发最小授权清单 |
| B130 与账本 | 234 项内有 23 项与 B130 重叠（原 21 项加两个布尔列）。职责查询的五列在共享快照均无有效 SELECT，且都落在 B130。账本分录 SELECT 的 13 列此前也未获批。将共享 B130、账本读取与其它延后业务分别留在相应决策卡；本批没有共享执行入口 |
| 同一登录的影响 | 给共享登录加职责读取，同身份的所有进程均可读取跨成员、跨组织的相应数据；续登更新影响该 DB 身份能触达的会话。分录表快照中无 RLS 或行策略，放开 13 列会允许跨成员查询。应用 API 的本人过滤及合成账号测试都无法把这些 DB 权限限定在标记用户 |

共享候选的备份可恢复性仍待实际实例证明。T66′ 的合成库恢复覆盖其隔离样本。当前建议先完成真机验收，有单独授权及对应回退条件后再推进共享变更。

## 真机微信待验

在实体手机可达的固定包 HTTPS 入口，用标记普通成员完成微信内 H5 登录，等待“我的”显示该成员，再刷新或离开后返回。核登录、成员、能力、轮换与刷新后的成员/能力响应均为 200/0，并核同一成员、数据库轮换及页面状态。记下机型、系统/微信版本、实际域名、时间、已脱敏截图和服务端 reqId。手机系统浏览器另做同样记录。实体手机扫码、保险与结算仍沿用首发清单；本次只复核桌面浏览器登录和续登，既有 Worker/关账证据见 [T63 回执](../t63/receipts.json)。
