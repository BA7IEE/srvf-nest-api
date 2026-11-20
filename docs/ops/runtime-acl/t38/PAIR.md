# 候选配对与回退准备

下述产物留在 srvf。可以在服务器执行本目录的只读脚本 verify-pair.sh。T38 已在隔离栈退役前后核验保留产物，实际命令及输出见 verify-pair.log。初次检查短路径 /api/health/ready 返回 404，源码登记的 /api/system/v1/health/ready 返回 200。公网入口 JS 哈希与旧发布目录一致。

| 用途 | 前端 | 后端 |
|---|---|---|
| T38 隔离实测组合 | 源码 eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64，目录 /var/tmp/srvf-t38.AtEsQ0kX/final-web，index.html SHA256 2625b6268ba53103ca78a943a70aace4398d86edbe7985cc4a3ecc2de232712d。相对该目录核验 release.sha256，清单摘要 c8fd30a91ef5e37032afb47ceb188bf6b75c203bd37de894c07b4f82571cbb2d | OCI revision 713d3416830d897852929731ff7f9b638038ab7c，镜像 ID sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75 |
| 当前公网与本次测试部署前的回退目标 | /opt/1panel/www/sites/dp.srvf.team/releases/b7f3dac00a860e32c0cbc220f29da0755bce024b/webroot，入口 HTML ae73cbd7964b002e705a9ce22c882fd2e5ec5a7f689ab510d21961b9ea3a1253，公网实际 JS 28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd | 既有容器 srvf-dp-acceptance-runtime-api-1，revision 108feebb84b85c7e4955c5af8bbfc016702e4529，镜像 ID sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb |

**部署条件。** 先逐条核固定源码、产物、同源入口、数据库迁移和有效权限、目录、模板、开关及外发关闭。隔离验收使用 156 项迁移、非所有者运行身份和隔离 ACL 副本。公网组合、目录和模板装配仍不同，共享 B130 未获批。镜像存在本身不足以切换。需要为新公网路由取得专门授权，独立复审针对实际待部署源码。供应商投递和真实用户开放继续独立管理。

**回退依据。** 当前 dp 配置 SHA256 为 86cacf43aefd1dab3fefc67d25ea81d6f81f700a43d81c34d26ee6bb13f958fc。服务器已留 /var/tmp/srvf-t38.AtEsQ0kX/pre-t38-dp.conf（0600），与现有配置逐字节相同。核对四处上游都属于旧容器当前地址，OpenResty 配置自检通过。这份副本恢复 T38 之前的配对。更早 T10 的副本指向另一个历史上游。

**获准后的操作顺序。** 保留上述旧静态目录、旧镜像和旧运行实例。若配对不符、健康失败、首页加载的静态摘要错误、版本确认保护或普通账号发布失败，先停止新写入验收。读取当前上游地址并核对原容器、静态树和变更后配置摘要，发生第三方改动就停止覆盖。确认现场与已批变更一致后，同批恢复上述原 frontend root 和四处旧上游，对恢复文件运行 OpenResty 配置自检，成功才 reload。复核磁盘和生效配置、live/ready、旧入口 JS 与原镜像。保留审核、业务审计和站内投递记录。公网执行、回退演练和真实用户流量均为 NOT_RUN。
