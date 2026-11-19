# T23 候选环境验收

运行 API revision 为 108feebb84b85c7e4955c5af8bbfc016702e4529。按已核验主机名与运行容器 ImageID 执行，数据库为 srvf_staging。

| 场景 | 状态 | 证据 |
|---|---|---|
| 单列授权 | PASS | 角色采样与批准对象一致。事务锁内确认原先无有效 UPDATE 列，grant.sql 经 psql ON_ERROR_STOP 执行并提交，exit 0。来源 postgres 直接授予，不带 grant option。before/after JSON 比较仅多 Member.updatedAt 的 UPDATE，十列 INSERT 保留。rollback.sql 执行前已保存，仅撤本次列权限。 |
| 两个独立普通账号各绑定自己的新成员 | PASS | 两次 bind 均 200/0；成员详情读回关联账号，普通账号正常登录后 app/me 读回各自 memberId、canUseApp=true。数据库按成员、用户和 member.account-bound 审计 extra 三方关联，各匹配一行成功审计。 |
| 重复与业务权限 | PASS | 两次重复绑定均 409/15031，重复编号均 409/15002；普通 USER 建档 403/30100。 |
| 普通 USER 调用自身成员绑定管理接口 | FAIL | 期望 403/30100，实际 500/50000。按同一 reqId 匹配 SQLSTATE 42501 与 organization_position_assignments 表权限拒绝。发生在普通角色路径；成功绑定和数据库审计断言此前已执行。原 T22 的 Member 行锁错误已通过同路径复测。 |
| 活动准入 | PASS | 新成员无正式等级，组织选项 403/20019 符合合同。候选有效 member_grade 类型为 0，level-1 至 level-7 有效项为 0。 |
| #1416 / #1417 认证业务夹具 | BLOCKED | 两个独立成员身份已创建并验证。合法正式发起人、可发布活动及结算更正任务仍缺。启用共享 member_grade 类型及其产品字典项会改变全库配置；本次授权限于单列数据库 ACL 和隔离业务数据。普通角色授权链另有已定位 42501，未扩大授权。认证正向、缺失 ID 与跨对象分支 NOT_RUN。 |
| 岗位、场次、考勤、结算与账本 | NOT_RUN | 依赖可用的隔离活动和授权角色。 |
| 前端 | 部分验证 | 公网根页面 200；普通账号后台 UI 未完成浏览器端验收。 |
| Worker | 部分验证 | 三个队列读取成功，采样时有效租约均为零。通知和活动有历史完成时间，存储为空；当前处理者心跳 UNKNOWN。 |
| 恢复 | 部分验证 | 当前 nginx -t exit 0；回滚备份复制到隔离临时文件、cmp 及摘要核对 exit 0。未在线切换，完整数据库恢复 NOT_RUN。 |
| #1419 | PASS，复用 | GitHub t21/1419-public.json 已记录宿主桥接 413/40000，本次新增超限请求 0。 |

## 可复用的绑定闭环

由标记 SA 创建全新成员与普通 USER。先核对成员编号登记，再 POST admin/v1/members/{id}/account/bind，断言 HTTP 200、code 0、返回 userId 匹配。另行 GET 成员详情核对 hasAccount 和 userId。重复请求断言 409/15031。只读查询将 User.memberId 与 audit_logs.resourceId 对齐，并核对事件、success 和 context.extra.userId。最后用普通身份登录并读取自己的 app/v1/me。退出会话，正常禁用本次测试账号，保留关联和审计。

执行命令为 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'python3 -'，输入分别为本地 /private/tmp/srvf-t23/public.py 和 second.py。第一组因额外的普通角色绑定断言 exit 1，第二组 exit 0。public.log 和 second.log 分别记录实测响应。两个测试账号均已正常禁用，审计保留。不能用 SA 的成功替代普通角色权限验收。整体首发仍受阻。
