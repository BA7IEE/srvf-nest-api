### Changed

- 拆出发布审核**提交/直发命令族**为 `ActivityPublishReviewSubmitService`,并把两侧共用的事务原语(Activity 行锁、提案快照、可发布性不变量、受众标签解析)与幂等原语(规范化 JSON、内容哈希、重放投影)下沉为纯函数模块。`ActivityPublishReviewService` 由 1335 降至 908 NCLOC,退出尺寸棘轮的「基线文件变大」告警;审核侧(approve / return / withdraw / cancel)与全部 7 个对外方法签名、锁序、审计事件、DTO、OpenAPI 契约零变化。
