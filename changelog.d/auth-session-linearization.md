### Fixed

- **Auth 会话并发逃逸**：密码、短信、微信签发与 refresh rotation、replay、logout、改密/重置、身份变更、禁用/软删和队员离队统一通过 PostgreSQL User 行锁线性化；锁后复验身份快照，防止撤销成功后残留并发 refresh sibling 或旧 factor 签出新会话，既有 JWT payload、错误码、rotation 与 access-token 策略不变。
