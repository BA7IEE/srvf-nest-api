# certificates — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)。证书仍是独立 member-qualifications 上下文，本文件只登记资格 runtime 的窄读取出口。

## Qualification coverage

- `CertificateQualificationService` 是活动资格 evaluator 的唯一证书/培训覆盖查询出口。只认已 verified、未软删、`issuedAt` 不晚于活动开始北京日且 `expiredAt` 为空或覆盖活动结束北京日的证书。
- 同一规则的标准数组由 evaluator 按 OR 使用；本 service 只提供已覆盖 standardId 集合或命中判断，绝不把证书编号、签发机构、证据图、审核人或其他证书事实放进资格 snapshot/App DTO。
- 它不读取 ActivityRegistration，也不负责规则解析、enforcement、写 snapshot 或保险判断；这些仍分别属于 qualification evaluator 与 `InsuranceRequirementService`。

## Risk points

- ❌ 不把“今天仍有效”替代“覆盖活动全程”。
- ❌ 不让 activity-registrations 直接复制 Certificate 查询；变更覆盖口径必须先扩本模块窄服务并补 unit test。
