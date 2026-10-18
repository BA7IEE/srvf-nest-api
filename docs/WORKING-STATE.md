# SRVF 日常版本与交接

接入基线（UTC 2026-10-12）：`f9206e862805a2ac11d5e92a6a5cb8ec1a7881b1`。这是采样基线，当前身份须重新运行下列入口；文档、版本号、旧日志与 CI 绿灯均不能代替当前 HEAD 或部署证据。

在本任务工作树运行：

```sh
python3 scripts/dev-guard.py audit --repo . --phase preflight
python3 scripts/dev-guard.py audit --repo . --phase checkpoint
python3 scripts/dev-guard.py audit --repo . --phase handoff
```

新任务、恢复或换分支时运行 preflight；独立验证切片完成、准备下一切片或连续开发约 60 分钟时运行 checkpoint；暂停、交接或换执行者前运行 handoff。JSON 保存在仓库外的本任务证据目录，不自动 stage、commit 或同步其他任务文件。owner 在已有授权内形成小提交并同步远端；正在等待同一 CI 终态的本地提交要明确记录暂缓推送原因，避免取消尚未完成的验证。

审计只读，dirty 仅提示并按路径说明归属；来源冲突交 owner 核对。原 `agent:preflight`、AGENTS、权限 grant、维护者签字、CI 和生产 NO-GO 门禁保持。该脚本不读取 `.env` 或凭据内容，不枚举 ignored 内容、不删文件、不调整分支或 upstream。默认不联网；可选 `--online` 只核对已配置的 GitHub upstream，失败必须说明缓存口径。

| 接入时观察项           | 固定基线／范围                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规范仓库               | `github.com/ba7iee/srvf-nest-api`                                                                                                                                                                                                 |
| 本任务入口             | `/Users/dengwang/Documents/coding/srvf-nest-api-delivery-flow-pilot`                                                                                                                                                              |
| common-dir             | `/Users/dengwang/Documents/coding/srvf-nest-api/.git`                                                                                                                                                                             |
| owner／目标            | 本次唯一写入者：SRVF Release 5 主开发执行者；其他注册树及其修改保留，不由本入口代管                                                                                                                                               |
| 本地分支               | `codex/activity-os-r5-e4-github-workflow`；未配置 upstream，不自动补设                                                                                                                                                            |
| 授权发布分支／PR       | `codex/activity-os-r5-e4-github-validation`，Draft PR #1380                                                                                                                                                                       |
| 版本入口               | `package.json`、Swagger 和已有 release 门禁，版本号不能证明部署                                                                                                                                                                   |
| 既有其他任务 dirty     | 接入前五项 tracked、四项 untracked；完整路径和 hash 在原九项保全清单，重新审计后再引用计数                                                                                                                                        |
| 最新已发布业务候选     | `a9a4e288f39a998cbb28585369660c63812ed38a`；CI 38185094092 已终态 FAIL，最大规模 prepare 仍 P2028，不能称已验收                                                                                                                   |
| 已验证 Docker 构建身份 | PR head `a9a4e288f39a998cbb28585369660c63812ed38a`；实际 checkout `16777bced454f80df91de13bef7204d0f9971055`；image ID `sha256:be1ad8084661d508cb6ad78fd46b3d75f022f2fc2629e7428cfccf8b40b9c69a`；仅该 run 38185094091 的构建观察 |
| 线上／回退身份         | UNKNOWN；本轮未部署，保留历史材料不代表回退可用                                                                                                                                                                                   |

构建来源检查只针对之后明确授权的新构建：固定完整源码 SHA、干净构建树、新产物路径与仓库外新 manifest，审阅构建命令及额外输入闭包，再显式使用脚本的 `build`／`release`。`release` 只称 `PASS_PROVENANCE_ONLY`，不替代测试、审批或部署权限。既有 OCI 镜像核验继续使用项目原流程；不能用此脚本给旧产物补填新 SHA 或追补来源认证。当前保留其他任务 dirty 的工作树不用于包装 release 构建。

本轮未做：生产部署、签字代办、历史清理、package／hook／AGENTS 接线、旧构建追补认证。完整来源与限制见 checker 的参数帮助及实际任务审计 JSON；不得将一个项目的旧 dirty 计数复制成其他项目的当前状态。
