### Harness / 执法层

- 「journey 直写库必须逐条交代」纪律闸(`scripts/harness-guards.selftest.ts`,随 `pnpm harness:selftest` 在 CI 跑,零新接线)。守的缺陷类是:**验证代码自己绕过了被验证的路径,而且没人知道它绕了**。

  立项实测:`test/support/journey-*.ts` 共 **46 处**直接写库,而 golden journey 是全仓最端到端的验证 —— 每一处直写都是**一段没被穿过的接缝**,建那个状态的 API 路径若断了或有个满足不了的前置,journey 照样全绿,因为它压根没走那条路。

  闸**不禁止直写**(禁了 journey 无法起步),而是要求每个直写调用的**紧邻上一行**带 `// journey-direct-write: <分类> — <理由>`,分类取自**闭集**(自由文本的理由验不了真伪,分类可以):`ambient` / `gate-unreachable` / `time-compression` / `mid-chain-start` / `no-api`。

  ⭐ `no-api` 是关键一档 —— 它把「图省事的直写」与「真的没有接口」分开:前者该改成走 HTTP,后者是**缺口显形**,必须同时登记 NEXT_TASKS。

  46 处逐条分类后:`ambient` 31 · `gate-unreachable` 10 · `mid-chain-start` 4 · `time-compression` 1。

  仪器纪律:四条 stub 正反对照(无标注 / 合法分类 / 闭集外分类 / 标注不紧邻)先证明检查函数会红,再拿它量真仓库;自证用地板锚点(≥5 个 journey 文件、≥30 处直写)不写「恰 46 条」。真文件变异对拍:摘掉一条真标注 → 红并点名 `文件:行号`;新增一处未标注直写 → 红。

### 文档

- `NEXT_TASKS` 新增 **P2-12**:本闸逼出的两条**从未被自动化穿过**的链 —— ① 招新实名入口(要真实短信验证码往返,两条 journey 都直接写库起步 ⇒ 招新链第一步在 CI 里一次没跑过);② 入队门槛的贡献值(journey 直接建 `approved` 考勤单,建单 → 一审 → 终审整条链被跳过 ⇒ 不证明「贡献值真能由考勤链产出」)。均为**判据缺口不是风险敞口**,零已知缺陷。
