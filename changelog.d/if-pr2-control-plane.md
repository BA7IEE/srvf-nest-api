---
"feat(system)": Integration Foundation v1 PR2 —— ServicePrincipal 控制面 8 端点 + RoleBinding SERVICE_PRINCIPAL 全链(P1-30)

- 新模块 service-principals(规格书 §35):POST/GET 列表/GET 详情/PATCH/PATCH status/
  POST credentials/GET credentials/POST revoke —— 8 端点全落 system/v1
- Secret 纪律(§12.1):原始 Secret = randomBytes(32) base64url **只在创建响应出现一次**;
  库存 SHA-256;常数时间比较原语(静态方法,PR3 复用);审计/列表零 secret 零 hash(e2e 断言)
- 凭证上限:同 SP ≤2 条 ACTIVE(锁主体行后计数);轮换闭环 + 已撤销幂等拒(37012)
- BizCode 37xxx 段启用:37001/37010/37011/37012/37013 + 资格门 37020/37021/37022
- 权限 seed 6 码(service-principal.*,规格书 §35)全绑 ops-admin;目录桶
  servicePrincipalControlPlane(闭包 243=243)
- RoleBinding:validatePrincipalOrThrow 补 SERVICE_PRINCIPAL 分支 + **else→fail-closed**
  (T0 §5.1 点名的「未知类型静默落入 Position Assignment」自 PR2 起结构性消灭);
  展开读面补 SP(clientId+name 最小化);DTO 加 clientId/servicePrincipalName 可选字段
- 资格门七条(§15.3,可触达四条落执行位):SELF 拒/ineligible 权限拒/system-managed 拒/
  合法通过;角色后续扩权防御(向 SP 绑定 Role 加 RolePermission 时拒不合格码)以纯函数交付,
  接线挂 role-permission 写入路径(PR4 全链时一并)
- e2e 5 用例:Secret 纪律/凭证上限与轮换/状态生命周期/资格门四路/USER 绑定零漂移

BREAKING: 无(新端点净新增;RoleBinding 展开读面新增两个 optional 字段)
