---
"feat(authz)": Integration Foundation v1 PR4 —— Principal-neutral Authz:DirectPrincipalAuthzService + 共享 scope coverage(P1-30)

- 新模块 integration-authz:DirectPrincipalAuthzService(SP 只认 direct RoleBinding;
  零 SUPER_ADMIN 短路 / 零 Member·Position·Supervision 虚拟 grant / SELF 运行时纵深过滤)
- 资格门运行时执法(§15.3 末段):explainDirect 每次过滤 servicePrincipalAllowed=true ——
  向已绑定 Role 后续扩权的不合格码在运行时结构性看不见(创建时校验不是唯一防线)
- RoleBindingScopeCoveragePolicy:五种 scopeType 共享判定(GLOBAL 恒真/ORG 精确/
  TREE 含根+后代(closure 回调注入,Policy 本体零 DB 依赖——lint D-7)/ACTIVITY 精确/
  RESOURCE 双键);与 User direct binding 语义一致,防两处各写一份后漂移(§68 P1)
- 零改 AuthzService/RbacService 一行(characterization 全绿是验收前置,§60)
- e2e 5 用例:SP direct binding 正向(附 matched)/资格门运行时关→结构性看不见/
  零旁路(no-bindings·no-eligible-permission)/scope 矩阵五型/USER 判权零漂移
  (资格门关时 USER 路径不受影响 —— SP-only 门不构成 USER 过滤)

BREAKING: 无(新模块净新增;现有 authz 零改动)
