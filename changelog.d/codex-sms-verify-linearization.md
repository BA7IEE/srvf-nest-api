### Fixed

- SMS 验证码 active 预检、错误尝试递增与最终消费统一改由数据库 UTC 时钟裁决；写路径使用参数化 PostgreSQL `UPDATE ... RETURNING` 并强制先取得目标行锁、再捕获实时时钟，避免热行等待期间自然过期后仍递增或消费。补充双 Nest app / 双 Prisma pool 的行锁屏障回归，覆盖签发与验证先后、错误尝试 4→5、快慢应用时钟、排队自然过期及双 consumer 竞态。
