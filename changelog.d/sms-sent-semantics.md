### 变更

- **`SENT` 的语义写清楚了 —— 它是「已提交 Provider」,不是「已送达终端」**(P2-10 项 1;`src/modules/sms/sms.dto.ts` · `docs/handoff/admin-web.md` · `docs/ops/sms-production-rollout-checklist.md`):`SmsSendLogResponseDto.status` 与 `SmsSendLogQueryDto.status` 两处 `@ApiProperty` 描述、后台「短信日志」页的前端页面规格、上线验收清单第 4 步,统一改成「`SENT` = 已提交 Provider,**不代表终端已送达**」。**零运行时行为变更、零架构变更**(发送逻辑本来就是对的);对外契约只动 `description` 文案,**不是 breaking**。

  🔴 **实证反例(维护者 2026-08-20 真机实测,这条刀的全部理由)**:系统侧留痕 `status=SENT` · `providerMsgId=99:2507238470…` **非空** · `errCode=null` · `errMsg=null`,而腾讯云控制台同一条显示 **提交状态成功 / 送达状态失败 / 原因:运营商免打扰名单** —— **手机始终没收到**。换第二个号码后正常收到,证明链路本身没问题。⇒ **零故障,但运营会误判**:照字面把 `SENT` 读成「用户收到了」。`SmsSendStatus` 只有 `SENT` / `FAILED` 两态,全仓**无任何送达回执 / 状态回调链路**,`SENT` 只覆盖到「腾讯云受理了 SendSms 请求」那一段。

  ⭐ **只改 DTO 就是修实例不修类。** 运营看的是后台页面,值班的人看的是 runbook,两者都不读 Swagger ⇒ 面向人描述这个状态的地方逐处数全再动手,共 **5 处**:两处 DTO 描述、`admin-web.md` 的「短信日志」页规格(**后台 UI 文案的出处**,最容易漏的一处)、`sms-production-rollout-checklist.md` 第 4 步(该文件 §0-pre / 步骤⑤ / §7 三处**原本就有**免责说明,唯独照单打勾的第 4 步漏了)、`sms-closed-loop-test.md` §6.5 导语(实证反例的出处,本刀**只钉不改**)。

  ⚠️ **明确划到范围外**:企微侧的 `SENT`(`NotificationDelivery.status='sent'`)是**另一个枚举、另一条域**,且 `wecom-message-channel-rollout.md` 已自带「SENT ≠ 已读,也 ≠ 已送达」,不动。

  ⚠️ **项 2(状态细化)明确未做**:引入 `SUBMITTED` / `DELIVERED` / `DELIVERY_FAILED` 三态 + 接腾讯云状态回调 —— 那是**对外契约变更 + 新增外部入站端点**(要验签、防重放、幂等),属独立立项评审,不顺手做。台账 P2-10 状态已改成 `⏸ 挂起`。

  ⚠️ **台账原文一处错名已订正**:出参 DTO 被写成 `SmsSendLogItemDto`,**仓内没有这个类**,真名是 `SmsSendLogResponseDto`。

### Harness / 执法层

- **「`SENT` 是提交态不是送达态」类闸**(`scripts/check-sms-sent-semantics.ts` + 薄运行器 `src/modules/sms/sms-sent-semantics.criteria.spec.ts`,随 `pnpm test` 执法):钉两件事 —— ① 五处面向人的描述**都还带着免责说明**(DTO 侧 typed-AST 定位到 `@ApiProperty` 的 `description`,文档侧用「定位锚 + 2 行窗口」,不做全文搜索,免得被文件别处偶然出现的同名词汇喂成假绿);② ⭐ **`SmsSendStatus` 仍是两态**。

  ⭐ **第 ② 条不是用来拦住项 2 的,恰恰相反。** 项 2 落地那天,这五处「不代表终端已送达」的说明**全部过期**(那时 `SENT` 不再是唯一的成功态)。这条红是**提醒**:回来把这批文案重写一遍。失败信息里直接带出登记表和该做什么,不需要读判据源码 —— 所以本刀**没有**给 `prisma/schema.prisma` 加注释:面包屑做进闸的报错里比做进 D 档红区文件里更有执行位,而那个枚举**本来就零注释**,它是沉默处不是「描述了这个状态的地方」。

  ⚠️ **字符串匹配刻意没写死到某一句话上。** 逐字匹配一整句中文「改个标点就红」,而假红会诱导人把闸删掉。改用**三组短锚点**:`submitted`(`已提交`)/ `negation`(`不代表` / `不等于` / `不是` / `≠`)/ `delivery`(`送达`),**三组必须同时命中**。任何一层语义被删掉都会红,改写措辞 / 加粗 / 换标点不会 —— spec 里有一条**换了整套措辞与标点的等价写法**作假阳性对照,和一条「只说了一半」的真阳性对照。

  ⭐ **判据落 `scripts/check-*.ts`(selfGuard 内),`src/` 侧只留薄运行器。** `src/**/*.criteria.spec.ts` 不在 selfGuard,判据住那里等于任何 PR 都能顺手改成恒绿;新合入的 `check-criteria-spec-purity` 现在是机器执法这一条的,本刀的薄运行器实测过它(能力型 import / 正则字面量 / ≥2 数字字面量 / 控制流 / 块体函数一条不沾)。

  ⭐ **变异对拍两条,都先 `diff` 确认非空变异、先验基线 0 红**:① 把 `SmsSendLogResponseDto.status` 的描述改回「发送状态」⇒ **红**,且**只红那一条主断言**(1 failed / 6 passed),报错点名站点并写明该补什么;还原后逐字空 diff、7/7 复绿。② 给 `SmsSendStatus` 加第三态 `DELIVERED` ⇒ **红**(`enum-arity`,恰 1 条)。第 ② 条走**镜像根**做 —— `prisma/schema.prisma` 是 D 档不可逆红区,本 lane 无授权也不该有;判据的 `analyzeSmsSentSemantics(root)` 全部路径相对 `root` 解析,把五个站点原样镜像到 scratchpad、只把 schema 那份换成三态,即可走通**完整的读盘 + 解析 + 判定链路**,而不是只在纯函数边界注入一个字符串。**未变异的镜像先跑一遍读数 0 红**,证明「镜像本身不是红的原因」。

  ⚠️ **「解析不到 ⇒ 零违规 ⇒ 全绿」这条假绿形状单独拎成一组自证断言**:五个站点任何一处的类 / 属性 / 装饰器 / 文档锚点被改名或搬走,都算**仪器红**并与「口径被改回去」**分开报** —— 两者的下一步动作不同(前者修判据登记表,后者补文案)。外加登记表规模的地板锚点(≥5,不写死「恰 5 条」)。
