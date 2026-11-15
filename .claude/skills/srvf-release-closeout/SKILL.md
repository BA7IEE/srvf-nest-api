---
name: srvf-release-closeout
description: SRVF 合并、发版、tag、GitHub Release 或合并后工作树清理时使用。
---

# 合并与发版

路径均相对仓库根。按 `docs/process.md` 操作，执行前核对维护者授权、目标 PR、
实际 head、CI 和评审结果。其他 Draft PR 的存在不阻止当前任务。

- 发布先 `pnpm release:prepare <版本>`，审阅生成文件并通过 PR；
  确认合并后再 `pnpm release:finish <版本>`。tag 指向批准的提交，notes 来自 CHANGELOG。
- 合并命令报错时先查 GitHub `state/mergedAt/mergeCommit`，已合并不重试。
  main 只 fast-forward，不强推或 hard reset。
- 清理只针对本任务；先确认远端合并、无未推工作和干净工作树，普通 remove/delete。
  squash 后祖先判断不成立时核对 patch 等价，不用强删掩盖不确定性。
- 报告 PR/tag/Release 的实际状态和未完成事项。合并、发版与生产部署分别核验。
