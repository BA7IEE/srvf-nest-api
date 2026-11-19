# T31 卡 A 停在 GitHub 人工审批

PR #1443 仍开放，head 精确等于用户批准的 2a0fd5adbaddf01ee9cac5c16d49cfc21790aed7。GitHub Actions 返回 Red-zone trusted scan 成功，Red-zone trusted approval 等待中、conclusion=null。run 44527955087 的 pending_deployments 指向 harness-review。CI、Docker Smoke 均成功。唯一执行缺口为此固定提交的 trusted approval 尚未成功。[审批作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44527955087/job/135573578020)

命令 gh pr view 1443、gh api commits/<SHA>/check-runs、gh run list --commit <SHA>、gh api actions/runs/44527955087/pending_deployments 均 exit 0。原始状态摘录与 UTC 时间同目录保存。

候选独立只读基线使用 StrictHostKeyChecking=yes 的 SSH 与 BEGIN READ ONLY。baseline.sql exit 0。三行均返回 f/f/f（预置角色行、权限行、两者映射均不存在）。该快照可供以后比较。候选 preview、apply、rollback 全为 NOT_RUN，无执行 receipt。候选写入 0，新 GRANT 0，未创建用户绑定，未修改范围外角色。若 gate 日后成功，仍需重新核对目标集群、脚本身份及实时 preview。

T30 装配预检本轮重跑 exit 0。srvf_staging 责任制 true、模板控制面 off、V1.1 false，模板初筛数与 activity.create.record 行数均 0。短信、企业微信、微信订阅真实外发条件均 false。常规单场次首发路径要求合法组织、适用模板、普通发起人与独立审核人；卡 A 仅恢复三码映射，无法补齐创建码或模板。#1416 公网正向本轮 NOT_RUN。此前隔离发布生成一个活动负责人绑定、两条通知意图；结束绑定并将未发意图按租约置 dead 后，无法再领取，五条原审计保留。该结论适用于隔离实验。[T30 固定材料](https://github.com/BA7IEE/srvf-nest-api/tree/fb90a2d647d0af9c1f2c4d29673fa9f726180c42/docs/ops/runtime-acl/t30)
