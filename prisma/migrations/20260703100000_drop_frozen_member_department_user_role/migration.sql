-- 冻结表 cleanup(goal「冻结表 cleanup — DROP MemberDepartment + UserRole 两张冻结表」,2026-07-03)。
-- 档 D,不可逆;pre-production 窗口维护者拍板执行(项目尚未上线、无生产数据)。
--
-- 背景(两表均已连续两个终态 scoped-authz PR 冻结、零生产读写):
-- - "MemberDepartment":PR2(#466,2026-07-01)方案 A' 全量重指向 member_organization_memberships
--   后零生产读写(9 个消费者已迁移;旧 3 个 department 端点行为逐字锁定不变——重指向读写的
--   是 member_organization_memberships,不是本表)。回填等值已用 count(...) 自证。
-- - "user_roles":PR6(#471,2026-07-01)回填 RoleBinding(principalType=USER, scopeType=GLOBAL)
--   后零生产读写(判权唯一读源已重指向 RoleBinding;user-roles 端点契约不变——读写的是
--   role_bindings,不是本表)。回填等值已用 count(...) 自证。
-- - 第二轮全仓 review(#484)L1 深审亲核:除迁移期回填 SQL 外,src/ 0 处生产读写两表
--   (docs/archive/reviews/full-repo-systematic-review-v0.34.0.md §4.2)。
--
-- 无其它表持有指向这两表的 FK(两表各自只持有指向 Member / Organization / User / roles 的
-- 出向 FK),故直接 DROP TABLE,无需 CASCADE。

-- DropTable
DROP TABLE "MemberDepartment";

-- DropTable
DROP TABLE "user_roles";
