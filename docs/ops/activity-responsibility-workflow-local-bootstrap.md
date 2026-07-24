# 活动责任闭环本地前端联调环境准备

> **本文件只用于专用本地联调数据库，不得复制命令操作正式环境。**
>
> 本文只准备本地占位账号、组织、Membership 和显式 reviewer / cross-org RoleBinding；不会预制活动、
> owner/collaborator 投影、发布审核、报名、考勤或闭环状态。A–I 业务数据必须由前端按
> [`activity-responsibility-workflow-local-acceptance.md`](activity-responsibility-workflow-local-acceptance.md)
> 通过真实页面和 API 建立。

## 1. 安全边界

本地 fixture 命令在连接或写入前必须同时满足：

- `APP_ENV` 只能是 `development` 或 `test`；`production`、`smoke` 和其他值立即拒绝；
- `DATABASE_URL` 解析出的数据库名必须是 `app_local_frontend` 或
  `app_local_frontend_<suffix>`；
- `LOCAL_FIXTURE_CONFIRM_DATABASE` 必填，并与 URL 中解析出的数据库名逐字相等；
- 不能以 `host=localhost` 代替数据库名确认；正式数据库也可能经本地隧道暴露；
- 禁止目标为默认 `app`、测试基库 `app_test`、PostgreSQL 系统库或任何未知数据库；
- 禁止 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`；
- setup 在单事务/可验证幂等边界内工作，失败不能留下半套账号或半套权限；
- 所有 fixture 数据使用 `local_fe_` / `LOCAL-FE-` 稳定前缀；
- 密码、token、数据库 URL、User/Member id 不写入 Git、PR、issue、manifest、audit 或普通日志。

任一检查失败即停止。不要为了“先跑起来”改脚本、换数据库名、补宽角色或绕过确认值。

## 2. 准备依赖和本地 PostgreSQL

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
docker compose up -d postgres
docker compose ps postgres
```

首次启动且仓库根目录还没有 `.env` 时，先执行 `cp .env.example .env`，获得当前版本完整的本地开发配置模板；已有
`.env` 时不要覆盖。`.env` 必须保持 untracked，后续第 3 节的当前终端变量优先用于这套专用联调库。

只在仓库自带的本地容器 `u-nest-api-postgres` 中检查专用库：

```bash
docker exec u-nest-api-postgres \
  psql -U postgres -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname = 'app_local_frontend'"
```

若输出为空，仅在该本地容器中创建：

```bash
docker exec u-nest-api-postgres createdb -U postgres app_local_frontend
```

已有同名库时不要再次创建。不要把容器名替换成不明主机，也不要把这条命令用于共享、测试基库或正式数据库。

## 3. 配置当前终端

下面只展示变量名和本地占位值。密码用隐藏输入提供，不要把真实值粘进命令历史或文档：

```bash
export APP_ENV=development
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/app_local_frontend?schema=public'
export LOCAL_FIXTURE_CONFIRM_DATABASE=app_local_frontend
export ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=true
export APP_CORS_ORIGIN='http://localhost:5173'
export APP_TRUSTED_PROXY_CIDRS=none
export ENABLE_SWAGGER=true
export LOGIN_THROTTLE_LIMIT=50

read -s "LOCAL_FRONTEND_FIXTURE_PASSWORD?Local fixture password: "
export LOCAL_FRONTEND_FIXTURE_PASSWORD
printf '\n'
```

`LOCAL_FRONTEND_FIXTURE_PASSWORD` 必须为 8～128 位并同时包含字母和数字。所有 17 个占位账号使用这个变量指定的密码；
命令只读取，不会打印或写入账号清单。前端换 origin 时只调整 `APP_CORS_ORIGIN`，多个 origin 用英文逗号分隔。
`LOGIN_THROTTLE_LIMIT=50` 只用于当前专用本地后端，使一次 HTTP verify 的 17 次登录不会触发默认 5 次/60 秒限流，
不得照搬到其他环境。

`.env` / `.env.local` 若已存在，确认其中没有覆盖上述变量。它们必须保持 untracked，禁止提交。

## 4. 部署 migration、执行 seed

确认当前终端仍指向 `app_local_frontend`，然后执行：

```bash
pnpm prisma:deploy
pnpm prisma:seed
```

fixture 只复用 seed 已存在的字典、Role 和 Permission。以下任一角色不存在时，setup / verify 必须失败，不能在本地脚本中
补造：

- `activity-publish-reviewer`
- `attendance-first-reviewer`
- `attendance-final-reviewer`
- `activity-cross-org-initiator`
- `biz-admin`

同样会校验 `node_type.group` 与 `member_grade` 中的 `level-3`、`volunteer`、`reserve` 都是 active；缺失时停止，
不在 fixture 中补造字典项。

前四个专项角色的权限码集必须与冻结契约精确一致；`biz-admin` 必须继续不含活动责任写权限。任一检查失败都停止，不把
`biz-admin` 的其他正常权限变化误判为漂移。

## 5. 建立、检查和打印 fixture

```bash
pnpm local:activity-fixture:setup
pnpm local:activity-fixture:verify
pnpm local:activity-fixture:print
```

- `setup` 幂等建立两个组织、17 个账号、Member、ACTIVE Membership 与允许预置的 reviewer/cross-org/biz-admin
  RoleBinding；连续执行两次不得增加账号、Membership 或 RoleBinding；
- 重跑 setup 必须使用首次建库时的同一密码；若密码不同，脚本拒绝直接覆盖 hash，以免绕过 refresh session 撤销与密码变更审计，
  需要按 guarded rebuild 重建专用库；
- `verify` 只读检查数据库名、账号/队员状态、等级、组织、角色权限集、绑定唯一性和负向约束；
- `print` 只输出 username、职责、组织和页面提示，不输出密码、token、User id、Member id 或数据库信息。

bootstrap 发生在后端监听启动之前，Admin API 尚不可用；现有 Service 入口还要求真实认证 actor，并把上述对象拆成多个独立事务，
无法提供本工具所需的全有或全无边界。因此 setup 只在全部环境闸通过后，用一个数据库事务直接建立
`Organization`/closure、`User`、`Member`、Membership 和允许预置的 8 条 RoleBinding。它不创建 Permission、Role、
PositionRolePolicy、audit 或任何活动业务表记录；事务内最终 verify 不通过即整体回滚。

setup 后初始数据库必须没有：

- active `activity-owner` RoleBinding；
- active `activity-registration-collaborator` / `activity-attendance-collaborator` RoleBinding；
- `ActivityResponsibilityAssignment`；
- 活动、发布审核、报名、GPS 打卡、考勤单/记录或反馈；
- `test-legacy-activity-actions` 对 `local_fe_unrelated_admin` 的绑定。

owner 与 collaborator 投影只能在 A–I 过程中由真实业务接口产生。

## 6. 固定账号矩阵

两个占位组织均为 ACTIVE、非根节点且 closure 正确：

- `Local Organization A`
- `Local Organization B`

| username                       | 身份与组织                                 | setup 允许预置                                 | 用途与应看到                                                      | 不应因此获得                     |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `local_fe_owner`               | 正式队员，组织 A                           | 无 reviewer/活动责任绑定                       | 发起主流程、送审；发布后成为 owner                                | 初始直发、预制 owner             |
| `local_fe_publish_reviewer`    | 正式队员，组织 A                           | `activity-publish-reviewer@ORGANIZATION(A)`    | 待发布审核；本人活动可直发                                        | 审批别人的活动后成为 owner       |
| `local_fe_registration_collab` | 正式队员，组织 A                           | 无活动责任绑定                                 | 发布后由 owner 委托报名协办                                       | 初始管理任何报名/考勤            |
| `local_fe_attendance_collab`   | 正式队员，组织 A                           | 无活动责任绑定                                 | 发布后由 owner 委托考勤协办                                       | 初始管理任何报名/考勤或审核      |
| `local_fe_first_a`             | 正式队员，组织 A                           | `attendance-first-reviewer@ORGANIZATION(A)`    | 待一审、退回/通过                                                 | 终审资格、活动 owner             |
| `local_fe_first_b`             | 正式队员，组织 A                           | 同上                                           | 重提后的换人一审                                                  | 终审资格、活动 owner             |
| `local_fe_final_a`             | 正式队员，组织 A                           | `attendance-final-reviewer@ORGANIZATION(A)`    | 待终审、终审退回                                                  | 一审资格、活动 owner             |
| `local_fe_final_b`             | 正式队员，组织 A                           | 同上                                           | 重提后的换人终审                                                  | 一审资格、活动 owner             |
| `local_fe_new_owner`           | 正式队员，组织 A                           | 无活动责任绑定                                 | owner 通过业务接口移交后接管                                      | 初始 owner                       |
| `local_fe_participant_a`       | 正式队员，组织 A                           | 无业务角色                                     | 报名、GPS 签到签退、查看 approved-only 结果                       | 活动管理或审核                   |
| `local_fe_participant_b`       | 正式队员，组织 A                           | 无业务角色                                     | 第二名参与者，验证多 record 草稿                                  | 活动管理或审核                   |
| `local_fe_unrelated_admin`     | `ADMIN` + 正式队员，组织 A                 | 正常 `biz-admin`；明确无 legacy role           | 可见其正常管理面；验证通用管理员不能代替活动责任                  | 别人活动的报名/考勤写、一审/终审 |
| `local_fe_cross_org`           | 正式队员，组织 A                           | `activity-cross-org-initiator@ORGANIZATION(B)` | organization-options 中 B 来源为 `cross-org-grant`；可为 B 建草稿 | 管理 B 中别人活动                |
| `local_fe_org_b_owner`         | 正式队员，组织 B                           | `activity-publish-reviewer@ORGANIZATION(B)`    | 建立并直发组织 B 中属于自己的活动                                 | 把 owner 权扩给 cross-org 账号   |
| `local_fe_volunteer`           | ACTIVE 队员，组织 A，`gradeCode=volunteer` | 无业务角色                                     | `canInitiateActivity=false`                                       | “发起活动”入口                   |
| `local_fe_reserve`             | ACTIVE 队员，组织 A，`gradeCode=reserve`   | 无业务角色                                     | `canInitiateActivity=false`                                       | “发起活动”入口                   |
| `local_fe_no_grade`            | ACTIVE 队员，组织 A，`gradeCode=null`      | 无业务角色                                     | `canInitiateActivity=false`                                       | “发起活动”入口                   |

`local_fe_unrelated_admin` 仍是正式队员，所以它可能拥有普通队员的本人入口；负向断言是“通用 admin 不能管理别人活动”，
不是“ADMIN 不能发起自己的活动”。

## 7. 启动后端和打开 Swagger

在完成 setup + verify 后启动：

```bash
pnpm start:dev
```

另开终端检查：

```bash
curl -fsS http://localhost:3000/api/system/v1/health/live
curl -fsS http://localhost:3000/api/system/v1/health/ready
```

成功路径应为 `code=0`、`data.status='ok'`；ready 还应为 `data.db='up'`。Swagger UI：

```text
http://localhost:3000/api/docs
```

前端按页面分工：

- App：我参与的活动、我发起或负责的活动、组织选择、报名、GPS 签到签退、协办管理；
- Admin：待发布审核、待考勤一审、待考勤终审、活动完结；
- 具体按钮必须结合 `myResponsibility`、review/Sheet/closure 状态，不能按 ADMIN、页面可见或
  `publishedBy` 猜权限。

## 8. 可选 HTTP verify

后端启动后可把本地 API 地址传给同一个只读验证命令：

```bash
export LOCAL_API_BASE_URL=http://localhost:3000
pnpm local:activity-fixture:verify
```

HTTP 部分应检查：

- live / ready；
- 17 个账号都能以 `LOCAL_FRONTEND_FIXTURE_PASSWORD` 登录；
- 正式队员 `activities.canInitiateActivity=true`，三个负例为 false；
- owner 的 organization-options 含 A 且不含 B；
- cross-org 账号含 B，且 `source='cross-org-grant'`；
- publish/first/final reviewer 对应 `managed.canReviewActivityPublication` /
  `canFirstReviewAttendance` / `canFinalReviewAttendance` 为 true；
- unrelated admin 初始没有活动责任 capability；
- 业务 GET 响应不含 `passwordHash`、`secretKey*` 或其他 L3 字段。

这里的“只读”指**不写活动业务域**。密码登录会按冻结认证契约建立 refresh session 和登录 audit；verify 必须只在内存中使用
access token，绝不打印 login 响应、密码、access/refresh token。`/api/auth/v1/login` 合法响应本身必含
`refreshToken`，因此 L3 blacklist 扫描只作用于登录后的业务 GET 响应，不能把登录契约误判为泄漏。

初始 owner/collaborator 投影和 RoleBinding 精确码集仍以数据库只读 verify 为权威；App capability 只是产品入口提示，
不能证明某个具体资源最终可操作。

## 9. 跑 A–I

按 [`activity-responsibility-workflow-local-acceptance.md §4`](activity-responsibility-workflow-local-acceptance.md#4-从创建到闭环怎么验)
执行。主流程活动使用真实短时间窗和测试设备实际位置：

1. 先完成发布与两名参与者报名审核；
2. 到 `startAt` 后由参与者真实签到，至少 36 秒后签退；
3. 考勤协办从真实 check-ins 生成草稿并提交；
4. 活动自然到 `endAt` 后再完结、声明和完成审核闭环。

不得使用 SQL、Prisma Studio、`prisma migrate reset`、系统时钟修改或 E2E 内部 fixture 推进时间/状态。时间安排失败时，
重新建立一场本地活动。

## 10. 清理或重建

停止后端，保留与 setup 相同的安全变量，再执行：

```bash
pnpm local:activity-fixture:cleanup
```

cleanup 必须再次校验 `APP_ENV`、数据库名与 `LOCAL_FIXTURE_CONFIRM_DATABASE`，且只作用于已明确识别的
`app_local_frontend*`。该命令**不连接数据库、不删行、也不自动 drop**；它只针对已确认的专用库输出人工执行的本地 Docker
`dropdb --if-exists` / `createdb` 命令，以及后续恢复步骤。先停止后端，再逐条检查并执行输出；不要把库名、容器名或
连接目标替换成其他环境。

不要在混合数据库中逐表猜测业务记录归属，也不得改成无保护的 SQL `DELETE` / `DROP DATABASE`。

重建后依次执行：

```bash
pnpm prisma:deploy
pnpm prisma:seed
pnpm local:activity-fixture:setup
pnpm local:activity-fixture:verify
```

禁止使用 `pnpm db:test:reset`；它属于 `app_test` 自动测试路径，也禁止使用 `prisma migrate reset` / `db push`。

## 11. 常见错误

| HTTP / BizCode      | 排查                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 403 / `30100`       | 页面可见不等于资源可操作；核对 scoped reviewer、`myResponsibility`、组织 scope 和资源状态，不给 unrelated admin 补 legacy role |
| 403 / `20019`       | 当前 grade 不是 `level-1..level-7`；三个负面账号出现此码是预期                                                                 |
| 403 / `20020`       | 目标组织不在 organization-options；核对 Membership 或精确 cross-org grant                                                      |
| 403 / `22074`       | 终审人是提交人或最近重提人；换没有提交/重提过该单的终审员，SUPER_ADMIN 也不豁免                                                |
| 403 / `22075`       | 一审人与终审人相同；换另一名终审员，SUPER_ADMIN 也不豁免                                                                       |
| ready 500 / `50000` | 数据库不可达；核对容器健康和当前 `DATABASE_URL`，不要改确认值绕过                                                              |
| 登录 401 / `10004`  | 核对 username 和当前终端中的 fixture password；不要打印密码或完整响应                                                          |
| 登录 429            | 同一窗口登录次数过多；确认当前专用本地后端以 `LOGIN_THROTTLE_LIMIT=50` 启动，必要时等待 60 秒窗口结束后再重跑                  |

更完整的按钮、状态和错误码语义见
[`activity-responsibility-workflow-local-acceptance.md §5–§6`](activity-responsibility-workflow-local-acceptance.md#5-按钮显示规则)。

## 12. 当前不是正式环境

这套环境没有真实人员、真实组织或真实活动，不执行生产 migration/seed、历史认领、真实 reviewer/owner 配置、fleet
drain、部署、恢复流量、release、tag 或版本变更。活动责任闭环后端进入的是**本地前端联调功能冻结**；未来正式上线仍须按
届时批准的 release 构建物、不可变 image digest 和
[`activity-responsibility-workflow-rollout.md`](activity-responsibility-workflow-rollout.md) 重新评审与执行。
