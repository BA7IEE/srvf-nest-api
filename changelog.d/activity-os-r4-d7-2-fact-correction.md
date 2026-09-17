## D7-2 冻结事实更正与 Human 写链（实施中）

- 按 #1335 第10–13节的方案 A 新增 v3 冻结事实更正链：来源证明、待物化分配、证据绑定和更正分配绑定均只以追加模型和第125条 migration 表达；不回填、不删除既有业务数据。
- 增加 App managed activity 的提交、查询、审核、重提、准备和提交接口，以及对应的访问复核、canonical/hash、来源冻结、附件保护、准备人绑定和回放语义。
- Human 的 review、resubmit、prepare、commit 现在将 URL `activityId` 与不可变申请归属逐一核对；错误活动路径返回既有“引用不存在或不可访问”错误，不改变申请状态。
- 本轮已完成一轮 TypeScript 与 Human command 定向单元验证。第125条 migration 尚待维护者3b重签，之后才会在唯一获准的 `app_test_w98` 运行迁移、数据库 E2E 和 contract；尚未创建 PR、跑 CI、Ready、合并、操作生产或启用 Gate。
