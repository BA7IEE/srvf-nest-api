### Added

- **历史身份快照盘点(issue #1048 T4 / §8·§12)—— 结论:当前不需要,且结论被钉成判据**:
  issue 允许两条分支(建 `MemberIdentitySnapshotV1` 或写出盘点证据证明不需要),本刀走后者。
  三条实测事实:① 引用 member 的 31 个模型(34 条关系字段)**没有一个**持有姓名副本(全部只存 `memberId`,
  姓名读侧现取现渲染);② 软删只置 `deletedAt`,行仍在,历史渲染照样取得到姓名;
  ③ 硬删被结构性阻止(`ParticipationLedgerEntry.member` 是必填关系 + `onDelete: Restrict`)。
  ⇒ 身份**永久可达**,再建快照只会制造第二份可漂移的姓名。
- 盘点结论落成 `src/modules/members/member-identity-snapshot.spec.ts`:
  「schema 上不得出现队员姓名的反规范化副本」,白名单 5 个模型逐个写明理由。
  **写成判据而不是写进文档**,是因为「我们盘点过、当时没有」是一句会过期的话 ——
  下一个人往结算表加一列 `memberName` 做冗余展示,盘点结论就悄悄失效,而没有任何东西会报错。
  判据自带三条正对照(打在判据本体 `offendersOf` 上,不只打在子探测器上)。
  ⚠️ 它**不**声称「永远不需要快照」,只声称「当下不需要,新增副本必须显式过闸」。

### 收口:issue #1048 T1–T4 对外影响一览

- **对外契约破坏**:全部落在 T1(#1096),共 **100 个 operation**,逐条 `contract-breaking`
  申报见 `changelog.d/member-identity-master-record.changed.md`。T2(#1099)只加可选查询能力,
  T3(#1100)无 HTTP 端点 —— 两刀 `gate:contract:semantic` 均判 breaking=0 / additive=0。
- **srvf-admin-web 后续**(维护者 2026-08-20 确认「尚未真正投用」,故未做兼容层):
  ① 重新 codegen(`docs/handoff/clients/**` 已随 T1 更新);
  ② 凡渲染队员姓名处改读 `label`(`编号 · 姓名(外号)`),需要分字段时读 `realName` / `nickname`;
  ③ 队员列表/选择器的 `q` 现按五级相关性返回,前端**不要再自己重排**,否则会把后端相关性排序打乱;
  ④ 报名导出 CSV 表头 `display_name` → `real_name` + `nickname`,列数 10 → 11,**按下标取值的脚本会错位**。
- **回滚立场**:整条 goal **无 feature gate、无兼容层**(维护者拍板不留兼容态)。
  代码 revert 可行,但 T1 的 migration 含 `DROP COLUMN`、**不可逆** ——
  已在有数据的库上 deploy 过的话,真回滚必须同时恢复库快照。T2/T3/T4 无 schema 变更,可独立 revert。

### 已知限制(本 goal 未做,需另行拍板)

- `memberSinceDate`(发号日)与 `memberOriginCode`(来源码)在建档时**必填、无「默认今天」**,
  且 `UpdateMemberDto` **刻意不暴露这两个字段** —— 因此历史导入脚本若写错发号日或来源码,
  当前**没有 API 可以订正**。这是 T1 起就存在的设计问题,已在 #1096 提出,尚未有结论。
- 字典 `join_source` 新增的 `manual` / `import` 两条,**code 已按长期契约锁定,label 待维护者与队里确认后定稿**。

### 未做:恒读层能力条目

- 本刀原计划在 `docs/current-state.md` §2 登记一条队员身份终态,**因恒读层预算已满而未写**:
  该文件当前 9597 / 9600 字符 = **100%**,零余量。预算 2026-08-15 才由 7600 重设为 9600
  (落点 74.9%),**5 天后即撞顶,实测增速 483 字符/天 ≈ 定预算时假定值的 3.3 倍**。
  `scripts/docs-readtax.ts` 顶部已预先记下这一情形的处置:「若下次仍在两周内撞顶,
  该动的不是预算数字而是结构」——把 §2 逐条能力摘要挪进 `handoff/` 与 `NEXT_TASKS`
  (不在恒读层,写多不付预算),**且明记那是独立立项、不在当时 PR 范围**。
  故本刀既不调预算、也不为腾位置删既有事实,把终态摘要留在 `handoff/admin-web.md`
  (T1/T2 已同步)与本片段中,**恒读层条目待该立项落地后补**。
