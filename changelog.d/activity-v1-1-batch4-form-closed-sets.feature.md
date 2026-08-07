### Added

- 活动业务改造 v1.1 第 4 批 Form 前置微刀新增第 79 migration：冻结报名表题目可见性和上传会话状态闭集、以双向 CHECK 锁 `consumed`/`consumedAt`，并以 partial unique 将 `registration-upload-session` 限为单附件。expand-only、零回填/删数/default/列变更/endpoint/runtime/seed/生产部署；MIME 与 10 MiB runtime 留待下一把 Form 行为刀。
