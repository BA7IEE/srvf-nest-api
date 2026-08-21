### Added

- 队员身份主档订正入口(第七轮评审 R7-A-01):`POST /api/admin/v1/members/:id/identity-corrections`。管理员在**存量老队员导入**或人工建档时把 `memberNo`(永久队员编号)、`memberSinceDate`(发号日)、`memberOriginCode`(来源)任一项录错,此前**只能直接改库** —— 实测全仓 `member` delegate 的 8 处写调用里,这三个字段只出现在 3 处 `create`(本地夹具 / 招新发号 / 后台建档),5 处 `update` 一处都不碰它们,**零订正路径**。而老队员存量录入是上线前的待办事项:一行录错,错误的身份事实就长期固化,`memberNo` 还同时是登录识别锚(用户名未命中时按它反查队员)、导入锚定与组织岗位展示的身份锚;直接改库则没有统一的操作者 / 理由 / 前后值记录。

  这笔账是仓库自己记下的 —— `members.dto.ts` 里 `UpdateMemberDto` 上方的注释逐字预告过「本刀刻意不开改口;真需要订正时应有独立的、带审计的更正接口,而不是混进日常改资料」。本次就是还这笔账,注释同步改为指向新端点。

  三处刻意的设计:① **独立入口而非放宽 `UpdateMemberDto`** —— 那份禁止清单一个字段都没放宽,三个身份事实仍然进不了 `PATCH /:id`;「存在订正入口」与「可以混进日常改资料」是两件事。② **校验与建档逐字同源,一条不松也一条不加** —— `memberNo` 复用同一条字符集 `@Matches` + `normalizeMemberNo()` + `assertMemberNoUnique()`(含软删)+ `runWithUniqueConstraintGuard()` 的 P2002 兜底,日期复用同一个 `normalizeDateOnly()` 北京日归一;`memberOriginCode` 则**刻意不加**字典存在性校验,与建档保持同口径(`join_source` 是自由串候选字典,MP-28 起就是 —— 当闭集校验会让「后台加了个码却订正不了」;维护者 2026-08-21 拍板)。③ **改编号用二次确认参数,不为它单发第二个权限码** —— 单发码多出一处「可能漏发给角色」的失败形态,那正是同轮 R7-D-01 修的那一类;二次确认是同一处代码里的显式入参,结构上不存在「码没发给人」这种形态。

  「订正了却什么都没改」不做成幂等成功:三个字段一个没传、或传了但每项都与现值相同,一律 `15011` 而不是静默 200 —— 沿仓内 `MEMBER_OFFICIAL_PORTRAIT_NOT_FOUND` 的同一立场(订正是针对某个具体错值的判断,静默成功会让调用方以为自己订正了什么,而实际什么都没发生)。

- 权限码 `member.correct.identity`,持有人与 `member.create.record` 一致(`biz-admin` + `org-admin`;维护者 2026-08-21 拍板:能建档就该能订正建档时录错的事实,与创建同权是最小且自洽的口径)。本码不入 `BIZ_ADMIN_EXCLUDED_CODES` / `ORG_ADMIN_EXCLUDED_CODES`,由既有派生链自动挂上;副职只读投影结构上取不到它(`isReadonlyProjectionCode` 只认 `.read.` 与 `attachment.view.`),`group-manager` 显式列表也不含它。`biz-admin` 72 条、`org-admin` 50 条,`org-readonly` / `group-readonly` 恒 11 条不变。新码由同轮 R7-D-01 的「权限码必须有持有人」类闸纳管 —— 摘掉角色映射,该闸即红并点名。

- 审计事件 `member.identity.correct`(`MemberAuditRecorder.identityCorrected`,沿既有六个事件的 payload 组装口径,不新造范式)。`before` / `after` 恒写**完整身份三元组**而非只写改动项 —— 沿 `member.audience-tags.update` 的既有口径(before/after 是被改对象的全量状态,extra 是 delta);只记改动项的话,这条审计行本身答不出「订正之后这个人的身份事实到底是什么」,而那正是事后回溯要问的第一个问题。`extra` 记 `reason`(DTO 层必填)与 `changedFields`。

### Fixed

- `prisma/seed.ts` 里 `biz-admin` 角色描述的绑定数陈述订正:「89 条业务码中绑 69」→「90 条业务码中绑 72」。本次新增 1 条码使业务码 89 → 90,但**绑定数此前已陈旧 2 条**(实测改动前为 89 绑 71)。该数字是散文陈述、不参与任何断言(`seed-biz-admin.e2e-spec.ts` 的期望全部由 `RBAC_SEED_CATALOG` 派生),故此前无症状。
