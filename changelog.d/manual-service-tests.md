### Added

- 人工运维两条服务补齐单测(Phase 6-B 测试收口):`attachment-manual-intake.service.ts`(16 例)与 `attachment-manual-attest.service.ts`(20 例)。前者是幂等受理入口,覆盖 eventKey 复用与身份冲突、活跃操作互斥、以及重定位与缺失认定两种 kind 各自不同的来源态判据;后者是**不可逆补偿路径**(物理删除 Attachment 行、对象置 absent、两条操作置终态),逐条钉住其十个围栏,并在每条拒绝用例中额外断言「拒绝时绝不能已经删了」。至此今天抽出的七个新文件全部具备单测覆盖。
