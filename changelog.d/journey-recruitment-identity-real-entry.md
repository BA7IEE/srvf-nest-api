### Fixed

- **招新链的第一步在 CI 里一次都没跑过**(P2-12a;由 journey 直写纪律闸逼出的两条接缝之一)。
  `RecruitmentIdentitySession` 的生产入口要**真实短信验证码往返**,于是两条 golden journey
  (`journey-certificate-recognition.ts` · `journey-recruitment-team-join.ts`)都**直写会话行起步** ——
  后果是「手机号发码 → 验码 → 发一次性 `phoneVerificationToken`」整条链断掉,
  `recruitment-identity.service.ts` 的 `sendCode` / `verifyCode` 无论怎么坏,journey 照样全绿。

  本刀把两条 journey 的起步改走**真 HTTP 入口**:
  `POST /api/open/v1/recruitment/identity/send-code` → `.../identity/verify-code`。
  钥匙不是绕过短信,而是 DEV_STUB 通道本身 —— `sms-code.service.ts` 在 `providerType === 'DEV_STUB'`
  时签发**固定码** `SMS_DEV_STUB_FIXED_CODE`,而 `journey-runtime.ts` 早已把 smsSettings 置成 DEV_STUB。
  因此**既不手算验证码哈希、也不直插 codes 表**,比立项时设想的「照抄 `auth-login-sms` 的哈希范式」
  更靠里一层:那份范式要自己算 pepper 与哈希,本刀连这一步都不需要。

  ⭐ 逻辑**只写一份**(`test/support/journey-recruitment-identity.ts`,两条 journey 共用):
  另写一份 = 两处对「验证码怎么来的」各自理解,而漂移时没有任何症状。
  helper 内另钉两条**两边非空**:发码后必须真落一条未消费的 `RECRUITMENT_BIND` 活码
  (send-code 是**防枚举**端点,闭轮+陌生手机会返回与成功路径同形的泛化 200 却零留痕 ——
  **200 本身不是「码发出去了」的证据**),验码后那条活码必须已被消费。

- 闸读数同步下降:`test/support/journey-*.ts` 直写 **46 → 44 处**,
  `ambient` 31 · `gate-unreachable` 10 · **`mid-chain-start` 4 → 2** · `time-compression` 1。
  剩下的 2 处是 P2-12 的第②条(直插 `approved` 考勤单凑贡献值,考勤审核链被整条跳过),
  属**另一刀**(12b),本刀不碰。

### Added

- **「已接通的接缝不许接回去」闸**(`scripts/harness-guards.selftest.ts`,随 `pnpm harness:selftest` 在 CI 跑)。

  ⚠️ 立这道闸的**实测理由**:原有「逐条交代」闸对本刀的回退**完全失明**。
  内存中变异对拍(同一份输入喂两道闸)——把两条 journey 改回直插、并配一条**完全合法**的
  `// journey-direct-write: mid-chain-start — …` 标注:

  | | 基线 | 变异(2 处回退) |
  |---|---|---|
  | 旧闸(逐条交代) | 绿 | **仍绿** ← 判据缺口 |
  | 新闸(封口模型) | 绿 | **红**,点名 `file:line` |

  原因是旧闸只问「交代了没有」,不问「这处该不该还存在」—— 分类标注可以把回退**买回来**。
  故新闸取**封口模型登记表**形态:表内模型(当前 `recruitmentIdentitySession`)在
  `test/support/journey-*.ts` 内直写数必须**恒为 0**,标注一律无效。12b 接通考勤链后,
  `attendanceSheet` / `attendanceRecord` 按同一形状进表。

  仪器纪律:四条正反对照先证明检查函数会红(封口模型+合法标注 ⇒ FAIL · `tx.` 前缀 + `update` 动词 ⇒ FAIL ·
  非封口模型 ⇒ PASS · 封口模型**只读** ⇒ PASS),再拿它量真仓库;
  写动词闭集与旧闸**共用一份**(分两份写 ⇒ 两处对「什么算写」各自漂移,漂移那侧零症状)。
  ⭐ 另钉一条**假绿路径**:登记表里的模型名与 `prisma/schema.prisma` 交叉核对 ——
  名字拼错则正则永不命中、闸恒绿,这条自证把它堵死。
