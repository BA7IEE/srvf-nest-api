修复隔离 V3 CI 的 PostgreSQL 镜像身份解析：使用工作流已固定的 repository digest 解析并验证完整本机镜像 ID，供创建和超时恢复共同校验；镜像缺失或 ID 非法时在创建卷、容器前拒绝。
