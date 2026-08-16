### Changed

- 附件人工缺失认定的执行侧抽出 `AttachmentManualAttestService`(Phase 6-B 第四域第五刀 · manual 族收官,架构边界 §3.2):`executeManualAttestAbsent` 与 `finalizeManualAttestedDelete` 迁入该类,编排器 `executeClaimed` 改为按 kind 委托。该路径是不可逆补偿(物理删 Attachment 行、对象置 absent、原始 delete 与本 manual 操作双双置终态),四段锁序(内容根 → Attachment → 对象+操作 → 落库)逐字保留,并在文件头写明「把内容根或 Attachment 锁挪到 lockClaimedForUpdate 之后会静默破坏全局锁序且不会有任何编译错或测试失败」。至此 manual 族(受理 / relocate 执行 / attest 执行)全部迁出编排器,编排器只余三个注入字段与两个薄委托入口。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
