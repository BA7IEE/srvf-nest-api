- **证书核验改用锁后的到期日(2026-07-31;证书标准库第二轮跨模型评审 findings G3)**:`CertificatesService.verify()` 的 `before` 读于 `claimAtStatus`(条件行锁)**之前**,而落点状态(§9.3:最后有效日早于今天 → `expired`,否则 `verified`)用的就是那份锁前快照。**Endpoint 恒 438 · 权限码恒 222 · Migration 恒 67 · BizCode 恒 306 · AuditLogEvent 恒 129**,零 schema、零契约变化。

  条件行锁只保证「状态仍是 `pending`」,**不保证这一行其余字段没变** —— 而 `expiredAt` 恰恰是管理端 `PATCH` 可以改的一列。等锁期间一次改早 / 改晚提交之后,核验就是按一个**已经不存在的到期日**给证书定状态:改早 → 一张昨天就失效的证书被写成 `verified`(到期扫描 cron 只处理**已经是 verified** 的行,所以要到次日 09:00 才纠正,这期间资质判定一律认它有效);改晚 → 一张刚续期到明年的证书被写成 `expired`。

  改法镜像**同文件 `update()` 早就做对的那一步**:`claimAtStatus` → 重新查 `lockedBefore` → 后续只看锁后事实(到期判定、审计 `before`、最终 `update` 的 id)。这与 F1 修掉的「发号用锁前快照」是同一个病,当时没铺到这里。

  **同文件扫查(DoD 要求)**:`create`(无既有行)/ `update`(已正确)/ `verify`(本刀修)/ `reject`(本刀顺带对齐)/ `softDelete`(全程无锁,写入不依赖任何锁前事实 —— 形状不同,不在本刀范围)。`reject` **今天不是活 bug**(写入值全部来自 dto 与常量,读到的 `verifyNote` 在 pending 行上恒为 null),但它的形状与 `verify` 相同;与其让下一个人重新推一遍「为什么这里没事」,不如让三条写路径一致:锁之后只看锁后的行。

  行为锁:新增 `test/e2e/certificate-verify-concurrency.e2e-spec.ts`(8 条,含独立连接元断言 + 全库巡检「`verified` 证书不得带早于今天的最后有效日」)。**两个方向各一条** —— 只测一侧证明不了「用的是锁后事实」,只能证明它在那一侧碰巧猜对了。其中 3 条在修复前红。
