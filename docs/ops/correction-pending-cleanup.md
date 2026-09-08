# 服务段更正暂存清理（实施中，未部署）

依据 #1295 方案 A。这里只清理成功更正的重复暂存明细，不删除正式段、账本、申请或收据。
当前实现尚待完整验收与 PR 审批；本文不构成任何环境的执行授权。

## 执行前

维护者核实单个 application 的成功状态、正式历史完整性及无未解决恢复／调查保留需求。
批准记录必须包含目标主机、数据库、application ID、预览条数、执行人及批准引用。
数据库身份以 session_user 为准，不使用 CLI 自报的 App User ID 充当认证。
使用既有安全配置注入 DATABASE_URL，禁止把口令、连接串或人员时间明细粘到终端记录中。
数据库权限由独立部署审批落实；SECURITY INVOKER 函数本身不提升或授予数据库权限。

## 预览

在仓库根目录执行，替换三个目标参数；缺任何一个都拒绝。默认事务只读。

```bash
pnpm exec tsx scripts/cleanup-correction-pending.ts \
  --host '<批准的主机>' --database '<批准的数据库>' \
  --application-id '<单个 application ID>'
```

预览只包含状态和计数，不输出名单、区间、摘要 hash、凭证。
预览不是最终准入结论；apply 在同一事务持锁后重新核对同链、已提交 batch 和正式 revision。
每次至多一个 application、2000 行；超限拒绝，不截断、不自动分批。

## 独立批准后执行

仅获得本次精确目标授权后，增加 `--apply --authorization-reference '<批准引用>' --confirm-no-retention-hold`。
批准引用是查找批准记录的标识，不是授权认证机制。操作者须独立核对真实批准记录。
无自动重试、自动扫描、cron、启动清理或请求内清理。

清理函数按 Activity → run → request → application 顺序取锁，精确验证正式物化历史。
清理收据写入、pending 删除、数量核验在同一事务；失败回滚。正式段后来 superseded 仍可作为历史证明。
清理完成后复核 remaining=0、收据计数一致及正式段／账本未变。重复执行返回原收据，不重复删除。
失败退出码非零，通用失败输出不包含数据库异常原文；先在受控环境排查，不盲目重试 apply。

## 回退和保留

未提交／未解决失败必须保留 pending。退队撤销访问不等于删除正式历史。
已有新格式 preparing application 时，不能直接回退旧二进制；先停止新命令，再独立批准处置未完成流程。
新增表不自动 DROP，不批量回填旧 application。正式历史保留期限不由本 SOP 决定。

本次未做：未授权实际业务数据清理，未生产部署或启用 Gate。
