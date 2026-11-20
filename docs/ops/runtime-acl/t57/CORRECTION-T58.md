# T58 更正：撤回 T57 对合并前置的判断

T57 在缺少宿主机取证时写下“可合并”“主机未知不阻塞”。这两项结论撤回。T57 的 GitHub 工作流与仓库 webhook 检查仍可用于说明当时已核的范围，不能证明宿主没有独立部署入口。

后端、Mobile、Admin 分别在 2026-11-20 17:11:14、17:12:37、17:13:47（北京时间）合入 main。本轮严格 SSH 首次核验发生在 18:20:18。宿主回看窗口为 17:00–18:20，当前版本采样在合并之后。没有发现三仓合并改变 dp 的旧 API 或已核后台入口；完整静态历史、独立 H5 和 Worker 在线版本仍有限制。GitHub 的历史提交与实际合并时间保留。[原证书](https://github.com/BA7IEE/srvf-nest-api/blob/deb984ff5bd4a9d27b7de15dc97712058ab6d686/docs/ops/runtime-acl/t57/prod-linkage-certificate.md) · [T58 证据](../t58/README.md) · [部署决定材料](../t58/deployment-decision.md)
