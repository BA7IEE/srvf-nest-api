# SRVF API — scoped-authz 终态上线初始化清单(组织职务 + 分管 + scoped RBAC + 统一鉴权)

> **性质**:维护者 / 运营侧一次性上线初始化 SOP(沿 [`cos-production-rollout-checklist.md`](cos-production-rollout-checklist.md) 范式),**不是**周期性运维任务——本清单只在项目从 pre-production 首次进入真实运营(录入真实队员 + 落真实组织任命)这一时刻执行一遍。
> **权威源**:架构与判权语义见冻结评审稿(已归档,全序列实施完成)[`org-position-scoped-authz-terminal-design-review.md`](../archive/reviews/org-position-scoped-authz-terminal-design-review.md);权限地图 + BD-2 绑定参数样例见 [`RBAC_MAP.md` §5](../ai-harness/RBAC_MAP.md);前端对接契约见 [`docs/handoff/admin-web.md`](../handoff/admin-web.md) §2.1 / §2.6。
> **背景**:终态 scoped-authz 序列(PR1–PR12 + 摘码微刀 #482)已于 v0.34.0 全量落地,但截至编写时项目**尚未进入生产**——本清单描述的组织/任职/分管/终审绑定录入动作至今未在任何环境执行过,这里是从零开始的完整初始化顺序。

## 0. 用法说明

### 0.1 谁在读

- **维护者 / SUPER_ADMIN**(全程操作人,尤其 ②④⑤ 涉及提权与真实数据):全部步骤
- **运营**(可协助③④的数据准备,如整理队员清单、核对公告 rows):③④ 的数据准备部分

### 0.2 怎么读

- 按 §1 → §7 顺序执行,每节末尾有"校验"步骤;任一校验不过,**不进入下一节**。
- **R13 红线贯穿全篇**:真实姓名 / 身份证号 / 手机号 / `memberNo` 的对照关系绝不写入本仓库任何文件(含 issue、PR 描述、commit message、AI 协作会话记录);本清单所有示例一律用假数据(`T0001`/`张三` 类占位)。
- 占位符:`<API_HOST>` / `<ACCESS_TOKEN>`(SUPER_ADMIN 或持权账号的登录 token)。

## 1. 部署 ≥ v0.34.0 + 摘码微刀 #482

- [ ] 部署版本 ≥ `v0.34.0` 且包含摘码微刀([#482](https://github.com/BA7IEE/srvf-nest-api/pull/482));`git log` 应能看到该 squash commit
- [ ] `prisma migrate deploy` 执行完毕、`prisma migrate status` 无 pending:部署 current `main`(含 v0.35.0 发版后的冻结表 cleanup [#494](https://github.com/BA7IEE/srvf-nest-api/pull/494))共 **39** 个 migration —— 终态 scoped-authz 8 张新表在第 **38** 个 migration 时已建齐(`organization_closure` / `member_organization_memberships` / `organization_positions` / `organization_position_rules` / `organization_position_assignments` / `organization_supervision_assignments` / `role_bindings` / `organization_position_role_policies`),第 **39** 个(`20260703100000_drop_frozen_member_department_user_role`)DROP 掉已零生产读写的两张冻结旧表 `MemberDepartment` + `user_roles`(对外行为逐字不变,详见 [`CHANGELOG.md` `## Unreleased`](../../CHANGELOG.md));若部署的恰是 `v0.34.0` / `v0.35.0` tag(#494 之前)则为 38 个,以实际 `migrate status` 为准
- [ ] `pnpm prisma:seed` 幂等执行:权限码 **191** 条 / 7 个内置角色(`biz-admin` **72** / `ops-admin` **91** / `member` 9 / `org-admin` 56 / `group-manager` 22 / `org-supervisor` 4 / `attendance-final-reviewer` 3)/ 6 个内置职务(队长 / 副队长 / 部长 / 副部长 / 组长 / 副组长)/ 30 条默认职务规则全部到位

**校验**:

```bash
curl -s https://<API_HOST>/api/system/v1/health/ready
# 期望:{"code":0,...,"data":{"status":"ok"}}
```

`GET /api/system/v1/roles`(需 SUPER_ADMIN token)应看到 7 条内置角色,`attendance-final-reviewer` 绑 3 码(`attendance.{read,final-approve,final-reject}.sheet`)。

## 2. 建 SUPER_ADMIN 与管理账号

- [ ] 首个 `SUPER_ADMIN` 由部署环境变量 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` 驱动,`pnpm prisma:seed` 首次运行时创建;**production 下 seed 强校验用户名 ≠ `admin`、密码 ≠ 默认值 `ChangeMe123456`,否则 fail-fast 拒绝启动**
- [ ] 首个 `ops-admin` 持有者默认 fallback 到该 `SUPER_ADMIN`(env `RBAC_INITIAL_OPS_ADMIN_USER_ID` 留空即可);如需指定他人,部署前将该 env 设为目标 `User.id`
- [ ] 日常操作组织/职务/任职录入的管理员账号:`SUPER_ADMIN` 登录后 `POST admin/v1/users` 建账号,再用既有端点分配角色(`POST system/v1/users/:userId/roles`,body `{"roleCode":"biz-admin"}` 或 `"ops-admin"`;仅 USER+GLOBAL 契约不变,继续可用)

**校验**:`GET /api/system/v1/rbac/me/permissions`(SA token)返回 `Permission.code` 全集;新建管理员账号登录后 `GET admin/v1/me` 能查到身份与角色。

## 3. 录入队员(公告涉及人员)

- [ ] 确认《2026 任命公告》涉及的全部人员(约 ~180 人)已作为 `Member` 存在,且每人有唯一 `memberNo`——公告导入(§4)的双锚铁律(R7)要求 `execute` 阶段每条任职 / 分管行都能按 `memberNo` 命中**已存在**的队员,**不会替你创建 `Member`**
- [ ] 逐个核对 / 创建缺失的队员:`POST admin/v1/members`(仅 `memberNo` + `displayName` 必填,`gradeCode` 可选)

```bash
curl -X POST https://<API_HOST>/api/admin/v1/members \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"memberNo":"T0001","displayName":"张三"}'
# 期望:201,返回含 id 的队员记录
```

- [ ] ⚠️ **已知缺口(候选 goal,已登记 [`NEXT_TASKS.md`](../ai-harness/NEXT_TASKS.md))**:存量队员**批量**导入工具尚未建;当前只能逐个 `POST admin/v1/members`,或由运维在数据变更 SOP 框架下直接 `psql` 灌数据(**psql 直灌不在本清单展开,须走既有数据变更流程**)。~180 人逐个建如耗时过长,可先用最小字段(`memberNo` + `displayName`)批量占位,后续再补全档案(证书 / 紧急联系人等)

**校验**:`GET admin/v1/members?memberNo=<待任命人编号>` 逐一命中(或抽样核对总数 ≈ 180)。

## 4. 公告 rows 导入(preview → 补号 → execute)

- [ ] **R13 红线**:公告 rows(真实姓名 × `memberNo` × 组织 `code` 的对照关系)是 R13 定义的真实数据,**绝不能**以任何形式提交进本仓库 git 历史(含 issue / PR 描述 / commit message / AI 协作会话);维护者已线下持有 v2 版本的 rows 文件,本步骤在维护者本地环境或安全的运维终端执行,不在协作会话里粘贴真实内容
- [ ] 先 `preview`(零写入)看逐行诊断:

```bash
curl -X POST https://<API_HOST>/api/admin/v1/announcement-import/preview \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"organizations":[{"code":"SECT-G1","parentCode":"SECT","name":"示例组"}],"positions":[{"displayName":"张三","orgCode":"SECT","positionCode":"team-leader"}]}'
# 期望:200,summary 给出 ok/blocked/already-exists/needsManual 计数;
# needs-manual 行的 suggestedMemberNo 供人工核对(仅建议,不会自动采信)
```

- [ ] 对 `needs-manual` 行:人工核对 `suggestedMemberNo` 是否为本人,**手工把 `memberNo` 补进请求体**;对 `blocked` 行按 `reasons[]` 修正(常见:缺 `memberNo`、组织 `code` 未先声明——父组织行必须先于引用它的子行出现)
- [ ] 全部行补齐 `memberNo`(positions/supervisions)与 `code`(organizations)后,`execute` 落库:

```bash
curl -X POST https://<API_HOST>/api/admin/v1/announcement-import/execute \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{ ... 同 preview 请求体,已补齐 memberNo ... }'
# 期望:200,summary.ok 计数与预期任命行数一致
```

- [ ] `execute` 天然幂等:同一批数据可安全重跑(已存在的行落 `already-exists`,不会重复报错或产生重复记录)

**校验**:`GET admin/v1/organizations/:orgId/position-assignments`(抽查若干组织)与 `GET admin/v1/members/:memberId/position-assignments`(抽查若干队员)能看到导入的任职记录。

## 5. BD-2 终审中枢绑定

考勤终审(`final-approve`/`final-reject`)摘码后**不再随 `biz-admin` 天然生效**(见 [`admin-web.md` §2.1](../handoff/admin-web.md)),必须显式建立至少一条 `attendance-final-reviewer` 的 role-binding,否则**没有任何 `ADMIN` 能终审,只能靠 `SUPER_ADMIN` 兜底**。

- [ ] 查 `attendance-final-reviewer` 角色 id:`GET /api/system/v1/roles` → 找 `code === 'attendance-final-reviewer'` 的 `id`
- [ ] 查 APD 部长任职 id(§4 已导入):`GET /api/admin/v1/organizations/:apdOrgId/position-assignments` → 找该任职人的 `id`
- [ ] 查总队根组织 id:`GET /api/admin/v1/organizations` → 根节点 `id`
- [ ] 建绑定(参数样例见 [`RBAC_MAP.md` §5](../ai-harness/RBAC_MAP.md)):

```bash
curl -X POST https://<API_HOST>/api/admin/v1/role-bindings \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "principalType": "POSITION_ASSIGNMENT",
    "principalId": "<APD 部长任职的 OrganizationPositionAssignment.id>",
    "roleId": "<attendance-final-reviewer 的 RbacRole.id>",
    "scopeType": "ORGANIZATION_TREE",
    "scopeOrgId": "<总队根组织 id>",
    "startedAt": "2026-07-01T00:00:00.000Z"
  }'
```

- [ ] 副部长同法再建一条(两人互为备份,规避"终审链只有一人"的单点风险;见 §7)
- [ ] 该 role-binding 是终审中枢的**唯一真相**,换届只需撤销旧绑定(`DELETE .../role-bindings/:id`)+ 建新绑定,**代码零改动**

**校验**:AuthzService 不缓存判权结果(现读实时库),绑定创建后**立即生效**,无需等待或手动重载缓存——直接进入 §6 验收即可确认。

## 6. 验收清单

- [ ] **分管范围展开**:若已按公告导入分管人(如设计评审场景中"分管 SECT、SSD 的副队长")的 `SupervisionAssignment`,`GET admin/v1/members/:memberId/supervision-scope` 返回的 `expandedOrganizationIds` 应同时含两棵分管树下的全部组织
- [ ] **authz/explain 抽查**(`POST admin/v1/authz/explain`,需调用者持 `authz.explain.decision`):
  - 某队队长对本队某活动 sheet 的 `attendance.approve.sheet` → `decision.allow=true` / `reason='matched'` / `matchedGrant.source='position'`
  - §5 绑定的部长对任意 sheet 的 `attendance.final-approve.sheet` → `allow=true` / `reason='matched'` / `matchedGrant.source='role_binding'`
  - 一个只持 `biz-admin`、**未**建终审绑定的普通 `ADMIN` 对 `attendance.final-approve.sheet` → `allow=false` / `reason='no_permission'`(印证摘码后果:`biz-admin` 不再天然终审)
  - `SUPER_ADMIN` 对同一 action → `allow=true` / `reason='super_admin_pass'`(兜底恒在)
- [ ] **22074 自审抽验**:用 §5 绑定的终审人账号,对**自己提交**的考勤单调 `final-approve` → 期望错误码 `22074`(即使换成 `SUPER_ADMIN` 提交后自己终审,同样应是 `22074`,零例外)

```bash
curl -X POST https://<API_HOST>/api/admin/v1/authz/explain \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"userId":"<目标 userId>","action":"attendance.final-approve.sheet","resourceRef":{"type":"attendance_sheet","id":"<sheetId>"}}'
```

全部通过 = 判权链路验收完成。

## 7. env 项确认

- [ ] `ATTENDANCE_ALLOW_SAME_REVIEWER`:留空 / 非 `'true'`(默认,推荐)= 禁止"一级审核人 == 终审人";若运营规模小、终审人手不足,可显式设 `'true'` 放开同人限制——**但自审限制(提交人 == 终审人)不受此开关影响,永远禁止,`SUPER_ADMIN` 也不例外**
- [ ] **单一终审人风险**:若 §5 只建了一条绑定(如仅部长,无副部长备份),该人请假 / 离职 / 换届期间终审链会中断到只剩 `SUPER_ADMIN` 可用;建议至少两人(正副部长)同时持有 `attendance-final-reviewer` 绑定
- [ ] `RBAC_CACHE_TTL_SECONDS`:仅影响 `GLOBAL` 角色走的老 `RbacService` 判权缓存(默认 1800s);§5 建的是 `POSITION_ASSIGNMENT` 主体的 scoped 绑定,`AuthzService` 目前不缓存判权结果,与此 env 无关

## 8. 排错速查

| 现象 | 查 | 常见原因 |
|---|---|---|
| 终审端点返回 `30100` | `authz/explain` 查该终审人 | §5 绑定未建 / 建错(`principalId` 不是任职 id、`scopeOrgId` 不是祖先组织)、或对应任职已被撤销 |
| 终审端点返回 `22074` | 单据的提交人 | 提交人与终审人是同一人,这是**正确行为**(不是 bug);换人提交或换人终审 |
| 终审端点返回 `22075` | 单据一级审核人 | 一级审核人与终审人是同一人;确认是否要设 `ATTENDANCE_ALLOW_SAME_REVIEWER=true` |
| 公告导入 `execute` 大量 `blocked` | 响应 `reasons[]` | 多数是缺 `memberNo`,或组织 `code` 未先声明(父组织行必须先于引用它的子行出现) |
| 公告导入 `needs-manual` 命中率低 | §3 是否已建全队员 | `displayName` 唯一命中的前提是该队员已存在于系统 |

## 9. 本清单不覆盖(已知事项 / 后续)

- **存量队员批量导入工具**:preview/execute 两段式镜像 announcement-import 尚未建,已登记 [`NEXT_TASKS.md`](../ai-harness/NEXT_TASKS.md) 候选项,诉求触发再立项
- **members / certificates / content / notifications 等其余业务面 scoped 判权迁移**:见 [`admin-web.md` GAP-007](../handoff/admin-web.md#4-缺口台账-gap-ledger) 序列外候选清单
- **换届 SOP**:本清单只覆盖首次上线初始化;后续常态化换届(撤销旧任职/绑定 + 建新任职/绑定)沿 §5 末尾的"撤销 + 重建"操作即可,暂不需要独立 SOP,诉求增长后可另立
