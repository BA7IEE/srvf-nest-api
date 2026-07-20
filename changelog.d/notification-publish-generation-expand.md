## Added

- D-Outbox Wave 2 G1 为 `Notification` 增加 `publishGeneration` 非负整数骨架，旧行默认代次为 0。
- 本切片仅 expand schema：runtime 尚未读写该字段，publish generation enforcement 未启用，migration 未 deploy，API 与 contract 行为不变。
