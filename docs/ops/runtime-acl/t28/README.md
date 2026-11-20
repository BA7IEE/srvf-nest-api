# 活动权限目录只读预检

在仓库根目录用已核对目标库的只读连接运行：

```sh
psql -X --file=docs/ops/runtime-acl/check-activity-catalog.sql
```

连接使用 libpq 的常规参数。预检在同一只读事务中读取 `public.permissions(id, code)`、`public.roles(id, code, "deletedAt")` 和 `public.role_permissions("roleId", "permissionId")`。输出一个 JSON 数组，三项按权限码排列，逐项给出权限、有效预置角色和指定映射是否存在。三个映射齐全时输出 `PASS` 并退出 0。缺项、角色软删或指定映射缺失时先输出各项结果，再以脚本错误退出 3。查询权限不足也退出 3，原因见标准错误。连接失败等客户端错误按 psql 原始非零退出码处理。

通过只证明下表的三个指定映射存在。用户绑定、额外角色的权限、运行账号 SQL 权限和实际业务判权需各自的证据。运行账号与单 Worker 业务链已有固定包的隔离记录。[T63 回执](../t63/receipts.json)

## 历史现场记录

下文及同目录两个 `.exit` 文件记录 T28 当时的结果。随后 T31b 用固定提交 `2a0fd5ad` 在获准的候选库补齐了三个映射。旧工具与当时审批可按提交追溯；本轮没有连接该库复测。[T31b 执行回执](../t31b/README.md)

### T28 活动部署权限目录与更正详情验收

运行版本 108feebb84b85c7e4955c5af8bbfc016702e4529 与 main 2b3eee0a954ea65abaef3edb35fd391eaa1567e9 的 prisma/seed.ts 和 permission-catalog.ts 内容一致。RBAC_SEED_CATALOG.roles 展开后，三项受检操作的预置映射如下。此表只规定种子角色的权限集，业务授权仍须按实际活动责任、角色绑定范围和资源条件检查。

| 权限码 | 预置角色 |
|---|---|
| activity.update.record | activity-owner |
| activity.publish.record | activity-publish-reviewer |
| activity.settlement-final-review.record | attendance-final-reviewer |

执行 psql -X -f docs/ops/runtime-acl/check-activity-catalog.sql。预检逐项检查目录、活跃角色和二者的映射。候选三个权限码和三个角色均缺失，exit 3。现场与版本契约存在部署数据漂移。历史 seed 是漏跑、部分装配还是后来发生变更仍 UNKNOWN。该差异与 #1420 的错误映射修复相互独立。普通发起人身份本身不能证明拥有 activity-owner。此检查不为任何账号分配角色。

部署维护方应将此预检与同版本数据库执行角色的实际 SQL/列 ACL 验证一起执行，分别留存结果。候选核验基于 T27 固定证据 03f5b50ec6c7f54890fbea7ab890f364f8a577eb；当时仅草稿与修改部分有隔离实证，未批准整链 GRANT。预检失败时应核对绑定来源与引用，再审查有审计、可回退的定向目录装配。全量 seed 会影响范围外角色及用户。权限码的内置删除保护 30105 仍生效。本次交付只读预检，候选目录恢复未执行。

#1417 仍 OPEN。#1420 合并提交 9bc703caf9b8f8102cf8cecccd7c04711ed78ab0 已在运行源码祖先链。候选 ACTIVITY_HUMAN_CORRECTION_BACKGROUND_MODE 为 off，既有标记管理员正常登录后的单次公网 GET 返回 HTTP 503、业务码 50300，脚本 exit 0。这验证服务不可用时的错误转换。请求用合成资源引用；没有执行受信事务内的 missing-ID 查找，也未验证普通终审角色。请求号见 public.log。当前 V1.1=false；关闭态的可预期错误为本次实测范围。真实任务详情、受信 missing-ID 的 404/40400、跨对象访问以及创建、更正写入均 NOT_RUN。first-launch 配置需要项目规定的已安装记录和专用 Human 客户端，随后还校验事务身份；当前 off 配置在装配前返回 null。未来若纳入首发启用范围，需要重新验收上述分支。

隔离 PG16 定向测试覆盖完整映射、软删角色和映射指向错误角色。候选现场检查与公网调用分别记录退出码。测试账号使用既有认证文件，日志仅记录状态码、业务码及不含凭据的请求编号。
