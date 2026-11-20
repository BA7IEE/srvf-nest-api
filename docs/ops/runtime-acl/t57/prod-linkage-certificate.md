# T57 merge 前生产联动核证（Asia/Shanghai 2026-11-20）

> **T58 更正已生效。** T57 对「可合并／主机未知不阻塞」的判断已撤回。宿主证据采自合并之后。[更正及核验时点](CORRECTION-T58.md)

## 当时结论（已撤回）
三仓 **GitHub 侧**未见「合入 main → 自动生产部署」链。合并后 CI 会跑测试/本地镜像构建，**不**推 registry、**不**经 webhook 调服务器。

## 证据
| 仓 | workflows | docker push/ghcr | repo hooks | 合入 main 后预期 |
|---|---|---|---|---|
| nest-api | ci.yml push main/dev：测试+`docker build -t u-nest-api-starter:ci`（无 push）; release-audit 仅 `tags: v*`; redzone 仅 PR | 无 | **0** | CI 绿；**人工**按 runbook 部署 |
| Mobile | check.yml：pnpm check | 无 | **0** | CI 绿 |
| Admin | ci.yml：verify | 无 | **0** | CI 绿 |

nest `docs/deployment.md` / `docs/ops/server-deployment-runbook*.md`：生产形态为人工镜像/环境切换与 runbook，非 Actions 自动切流。

## 残余未知（不阻塞本次代码合入；也不等于 production PASS）
主机侧若存在**仓库外** cron/1Panel 盯 main 的配置，不在 GitHub API 可见范围；本轮按授权不改生产配置、不扩探。公网切流仍须维护者另批。
