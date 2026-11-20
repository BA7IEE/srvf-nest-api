# T57 实际 merge/close ledger

> **T58 更正已生效。** T57 对「可合并／主机未知不阻塞」的判断已撤回。宿主证据采自合并之后。[更正及核验时点](CORRECTION-T58.md)
时间：2026-11-20 17:14:26 UTC+08:00 Asia/Shanghai · 授权 t30u；长期规则 t31u 起生效（历史「须维护者逐次批」保留为变更前事实）

## 生产联动（合入前）
见 `srvf-t57-prod-linkage-certificate.md`：GitHub 侧无自动生产部署（docker 仅 CI 本地 build；hooks=0）。残余：主机侧仓库外 cron/1Panel 未知，未改生产配置。

## 已执行

| 序 | 动作 | 结果 |
|---|---|---|
| 1 | nest #1447 ready+merge `--match-head-commit 65d1d6ea…` | MERGED merge=`65bad1ccb7e6a4bb7a3cda46b49512f092d04779` @ 09:11:14Z；tip behind=0 |
| 2 | nest #1439/#1444/#1445/#1446 | 随 #1447 **自动 MERGED**（09:11:16Z）；覆盖 behind=0；保留未删分支 |
| 3 | Mobile #5 ready+merge `--match-head-commit 529ee3a3…` | MERGED merge=`ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1` @ 09:12:37Z |
| 4 | Mobile #3 | 随 #5 **自动 MERGED** |
| 5 | Mobile #4 close | CLOSED @ 09:13:35Z（tip behind=0；非 merge） |
| 6 | Admin #172 ready+merge `--match-head-commit 104e524c…` | MERGED merge=`2626116889affe3bda3758f7ed1ce006272503bf` @ 09:13:47Z；tip behind=0 |
| 保留 | nest #1442 | 仍 OPEN（证据材料） |

## main 现状
- nest-api main=`65bad1cc…` CI push 进行中：https://github.com/BA7IEE/srvf-nest-api/actions/runs/44708578967
- Mobile main=`ae2e3b0a…` CI：https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44708773107
- Admin main=`26261168…` CI：https://github.com/BA7IEE/srvf-admin-web/actions/runs/44708940910
新 main 绿 ≠ 重跑全业务 ≠ production PASS。

## 合入后 main CI（实核）
- nest-api：https://github.com/BA7IEE/srvf-nest-api/actions/runs/44708578967 **success**
- Mobile：https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44708773107 **success**
- Admin：https://github.com/BA7IEE/srvf-admin-web/actions/runs/44708940910 **success**
说明：新 main 绿 ≠ 重跑全业务隔离验收 ≠ production PASS。
