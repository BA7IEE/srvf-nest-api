### 修复

- Integration Token 配置在 production / smoke 启动阶段强校验独立 Gate 与密钥；`10m` TTL 正确按 600 秒解析，并由 Docker smoke 覆盖。
