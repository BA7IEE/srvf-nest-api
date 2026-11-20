# T42 配对部署准备

| 用途 | 静态产物 | API 产物 |
|---|---|---|
| 隔离已验配对 | #172 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，服务器 `/var/tmp/srvf-t41.a8QKt5qN/final-static`，完整清单 SHA256 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b` | #1444 `713d3416830d897852929731ff7f9b638038ab7c`，镜像 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75` |
| 现公网配置对应的旧配对 | `/opt/1panel/www/sites/dp.srvf.team/releases/b7f3dac00a860e32c0cbc220f29da0755bce024b/webroot` | `srvf-dp-acceptance-runtime-api-1`，revision `108feebb84b85c7e4955c5af8bbfc016702e4529`，镜像 `sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb` |

**本轮实证。** 先在 srvf 只读检查当前配置的四处上游、原容器、回退副本和 OpenResty 配置语法；再分别在隔离启动及退役后用 pair.sh 核验 T41 新静态目录全部文件和后端镜像标签。旧配置副本为 `/var/tmp/srvf-t38.AtEsQ0kX/pre-t38-dp.conf`，权限 0600，SHA256 为 `86cacf43aefd1dab3fefc67d25ea81d6f81f700a43d81c34d26ee6bb13f958fc`，与本轮现场配置相同。[本轮回执](rollback.log) · [只读新配对校验](pair.sh) · [旧配对原始核验与恢复边界](https://github.com/BA7IEE/srvf-nest-api/blob/805ccde613f808ba4fa2ab18e63eb687e7be35d8/docs/ops/runtime-acl/t38/PAIR.md)

**进入部署的条件。** 执行时重新核远端两条 PR 的 SHA 和原生 CI、两套产物、当前配置摘要、动态上游归属。单独核目标数据库迁移与实际运行角色权限、模板和目录版本、模式、独立审核人的组织绑定、消费者及外发状态。隔离环境用非所有者和活动链权限副本；共享候选 B130 未批，本次无新增共享授权。普通报名实际失败，公网新配对验收、真实回退、数据库恢复均为 NOT_RUN。

**已授权部署后若需恢复。** 保留旧实例和静态目录；健康失败、资产错配或关键流程失效时停止新的业务写入验收。先确认被替换的当前配置确属刚批准的变更，有并发改动就停止覆盖。按已批准方案以同一份备份恢复旧静态 root 和四处旧上游，按容器当时的实际地址核对。配置自检通过后 reload，再核生效配置、首页静态摘要、live/ready 和镜像 revision。保留活动、审核、站内意图及审计记录，另行核对在途数据；回退前后端不会撤销已经提交的业务写入。
