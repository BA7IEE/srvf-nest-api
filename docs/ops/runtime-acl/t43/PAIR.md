# T43 配对与回退补充

前端静态清单 SHA256 仍为 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b`。后端报名正反测试使用 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75` 原镜像、零诊断挂载、内部网络。活动页面测试使用上述前端；队员页另核 SRVFMobileWeb #3 正式构建，结果为未接线。[原配对与回退资产](https://github.com/BA7IEE/srvf-nest-api/blob/2f310d71feb92fb56ecc65d01739373935febd79/docs/ops/runtime-acl/t42/PAIR.md)

重建同型一次性试验时，先核镜像、迁移、网络、数据库 cluster ID 和现有角色。默认缺少此处的 32 项列权限。可从对应测试目录使用 `python3 assemble.py rehearse --expected-cluster <本次隔离库的独立核对值>` 在回滚事务内预检。apply 记录精确增量，withdraw 仅恢复该栈的原基线；幂等性、撤权和审计保留均已实测。夹具须有覆盖活动日期的合成保险，业务操作使用普通账号和正常应用流程。[隔离装配脚本](assemble.py) · [演练与重复执行回执](assembly.log)

目标部署需另外验证共享角色的行锁与投影写入合同、队员端同源认证、生产构建路由和消费者配置。仅更换镜像不会补齐这些条件。公网新配对和实际路由回退保持 NOT_RUN。
