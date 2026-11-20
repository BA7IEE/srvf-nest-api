# T44 配对与隔离回退

管理端静态清单 SHA256 为 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b`，后端镜像为 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75`。退役后重新验证静态清单所有文件及镜像 revision。队员 H5 是第三个独立产物，其 Draft #3 仍为未接线构建。[核对回执](pair.log) · [T42 配对资产](https://github.com/BA7IEE/srvf-nest-api/blob/2f310d71feb92fb56ecc65d01739373935febd79/docs/ops/runtime-acl/t42/PAIR.md)

## 一次性隔离库的装配和撤回

前提为经独立核验的一次性试验目录、同名内部网络、未发布端口、tmpfs PG、原镜像、156 个已应用迁移、非所有者运行角色及 T43 列基线。装配脚本只接受满足这些条件的环境。将本目录三个 Python 文件 trial_acl.py、assemble.py、closure_guard.py 放入试验目录，使用现场独立核对的数据库 cluster ID。生产与共享候选不在此脚本适用范围。试验管理员只做装配和核对，HTTP 始终经非所有者身份运行。

```sh
python3 trial_acl.py apply --expected-cluster "$verified_trial_cluster"
python3 trial_acl.py check --expected-cluster "$verified_trial_cluster"
python3 trial_acl.py withdraw --expected-cluster "$verified_trial_cluster"
```

apply 先安装组织深度写保护，再以事务施加 32 项列权限；check 验证回执、有效权限及触发器身份、实现与启用状态。若中断，保留本次试验目录和回执，重新 check 并核对后按需 withdraw。不可直接调用底层 assemble.py apply 跳过保护。撤回按权限在先、触发器在后的顺序执行；有 UPDATE 权时单独移除保护会被拒绝。两次撤回成功，有效 ACL 与原始三表基线一致，28 条审计仍在。[装配](arm.log) · [撤回](restore.log) · [核验](restored-check.jsonl)

自助签到留下 0 事件、0 时段。负责人作废唯一的测试二维码，Worker 在无外部出口的内部网络将 5 条意图全部处理后停止。销毁一次性 PG 前封存合成审计，服务器文件权限 0600，证据仅收录摘要。公网路由和共享运行角色均沿用现场配置，本批未进行公网切换或回退演练。[二维码回执](post.log) · [Worker](worker.log) · [退役](retired.log)
