### Added

- 补齐 attachments 三个零单测覆盖文件的单元测试(Phase 6-B 测试收口,192 例):`attachment-storage-locator`(41)、`attachment-reconciliation.service`(68)、`attachment-upload.service`(83)。此前六刀边界抽取把大文件拆小了,但测试覆盖没有跟着搬过来,留下三个 100~600 行、顶着「已抽出边界」名头的零覆盖块。本刀只加测试,零生产代码改动。13 个变异对拍全部命中(每个都定位到具体用例)。
