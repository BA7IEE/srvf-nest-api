# T29 活动目录定向恢复与权限审查

**结论：目录工具可独立审查；整链暂不建议发实施卡。** 候选目录恢复 NOT_RUN，候选 GRANT=0。隔离服务源 108feebb84b85c7e4955c5af8bbfc016702e4529，main 基线 2b3eee0a954ea65abaef3edb35fd391eaa1567e9，两者的种子目录契约相同。沿用 T27 候选责任制 true、V1.1/Human 关闭、通知关闭的记录；配置恢复脚本 /var/tmp/srvf-t26b.fMwTQBTr/restore.sh，本轮没有调用。

## 目录操作

scripts/ops/reconcile-activity-catalog.sql 要求传入独立核定的集群 system identifier、库名和动作，用 156 项迁移名和内容校验和检查版本。仅处理三条权限及对应角色和单个映射。已有相符记录复用；遇冲突或拟变更的角色已有绑定/职务策略即整笔回滚。无账号分配。映射变更、角色权限版本与审计同一事务。目录中一项映射的恢复不等于恢复角色的全部能力。

    psql -X -v target_db=app_test -v cluster_id="$VERIFIED_CLUSTER_ID" -v operation=preview -f scripts/ops/reconcile-activity-catalog.sql

preview 执行后整笔回滚。apply 提交。withdraw 按创建审计和 mapping id 撤回本工具新增的映射；保留审计、内置角色及权限记录。已经引用的角色阻断整笔撤回。提交后不提供物理删除内置权限的入口，因此该操作只能撤销生效映射，不能逐行还原目录。正式部署维护方须接受这项持久影响并核对其他引用。当前卡未授权候选执行。

## 隔离 PG16 验证

真实迁移、Nest 服务、候选有效 ACL 实验副本。python3 run.py 从 srcpath 指向的 108feebb 临时源码归档运行，需同 schema 生成的依赖、本地 Docker 和 T27 的 acl.jsonl。将仓库脚本复制为本实验目录的 reconcile.sql。仅在一次性源码目录运行，测试会写入 lab.ts。validation.log 收录断言及退出码。

错库、错迁移校验和、角色元数据冲突均 exit 3。强制审计失败整笔撤销，权限、映射为零。预演不留目录行。两个并发 apply 各 exit 0，仅三份创建审计、三个映射，自动用户绑定为零。withdraw 后重建缺失映射成功。已有合法审核员绑定时 withdraw exit 3，三条映射及绑定均保留。

| 隔离服务路径 | 结果 |
|---|---|
| 草稿创建与修改 | 使用 T26c/T27 已证候选差额，普通发起人更新成功。其他主体修改返回 20001 |
| 限定活动范围的角色绑定 | 通过正常 RoleBindingsService，系统管理的 activity-owner 即使由夹具管理员申请也返回 34006。另一普通主体绑定本活动的 activity-publish-reviewer 成功。该夹具绑定由隔离管理连接执行，普通 API DB 角色创建绑定曾遭 42501，不纳入业务 ACL 卡 |
| 指标及初审 | 目录恢复后，草稿发起人仍返回 30100，提交初审 20174。读取确认草稿保留、审核行数为零。activity-owner 由责任投影器在正式发布时建立；首次草稿不会自动得到该角色。审核员绑定不能代替发起人的指标权限 |
| #1416 合法形状请求、缺失活动 | 真实 controller + 普通主体，返回业务码 20001 |
| #1416 跨对象草稿 | 第二主体访问第一主体的草稿返回 20030；先命中状态前置，此结果不能证明已发布活动的越权隔离 |
| 发布、#1416 已发布正向与跨对象 | NOT_RUN。上述正常授权路径未能生成发布对象。本批没有用手工 owner 绑定、直接更新指标状态、替代业务身份或打开其他开关完成此分支 |

目录、RBAC scope、PostgreSQL ACL 各自独立。历史 T26c 的 Activity 26 列 INSERT、责任表 7 列 SELECT 及 T27 标题和 updatedAt 两列 UPDATE 只覆盖草稿段；同角色所有连接均受影响。已证 SQL 见固定 T27 包 03f5b50ec6c7f54890fbea7ab890f364f8a577eb。目录工具本身不授 PG 权限。现有证据不足以列出审核发布所需的完整最小集。部署目录由 seed 维护方负责，数据库列授权由部署角色维护方负责；草稿指标写权限与发布时 owner 投影的先后关系须在产品既定流程中解决。
