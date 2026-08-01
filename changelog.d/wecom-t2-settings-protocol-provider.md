- **企业微信 T2 收口:配置写路径锁后复读 + 上游协议严格解析 + Provider 无状态化(2026-08-01;整批评审 3 条 P1)**:零 schema、零 migration(恒 **68**)、零 cron(恒 **2**)、零新端点、零新权限码、零新 BizCode —— 三条都是**同一批新代码里的运行时缺陷**,修的是形状不是文案。

  **① `wecom-settings` PATCH 锁前读、锁后不复读(S1 形状)**:`updateSettings` 原先 `findFirst`(**不带锁**)→ `SELECT … FOR UPDATE` → 然后拿**锁前**的行去算三个开关的终态。两个并发 PATCH 各自用锁前快照判"二级闸不得脱离总闸",于是**两边都保存成功**,合起来写出 `enabled=false + loginEnabled=true` —— 运维看 `loginEnabled=true` 以为能登,实际全被总闸挡掉。现在改成**先取 id → 锁 → 锁后重读完整行 → 用锁后行 + dto 算终态 → 校验组合不变量 → 写**;组合不变量在**同一份终态**上判,不再各判各的。行为变化:并发下后到的那条现在返 **400**(它看见了先到者已提交的事实),此前是两条都 200。新增真双连接并发 e2e `wecom-settings-concurrency.e2e-spec.ts`,两个顺序各一条 + 一条"互不冲突的并发变更不误杀"反向对照。

  **② `agent/get` 用本地默认值冒充上游事实**:原先三处 `readNumber(body, key, 默认值)` 各自是一句谎话 —— `errcode` 缺失默认 **0(= 成功)**、`agentid` 缺失回填**本地配置的 agentId**、`close` 缺失默认 0(= 应用已启用)。三条叠加的结果是:上游返回 `{}`,`test-connection` 回答"一切正常",而 `agentMatched` 变成**自己和自己比**,恒 true。现在协议字段一律 required:`errcode` / `agentid` / `close` 必须**存在且为整数**,缺失或类型不符统一 `INVALID_RESPONSE` → **36031**;`gettoken` / `message/send` / `auth/getuserinfo` 的同类默认值一并清掉。

  **可见范围区分"缺席"与"读不懂"**:`allow_userinfos` / `allow_partys` / `allow_tags` **整个键缺席**记 0(缺席 = 空列表,这是协议读法);键**出现了而结构不对**(不是对象 / 内层不是数组)⇒ 36031。静默计 0 会把"读不懂上游回执"报成"没有人可见",而这正是诊断接口最不该撒的谎。

  **③ `WecomRealProvider` 是 `@Injectable` 单例却写请求级状态**:`prepare(settings)` 原先 `this.settings = settings; return this`(注释还自称镜像 wechat provider —— 实际相反)。并发请求 prepare 后互串配置快照:实测两个并发 `resolveRoute()` 之后,请求 A 的路由拿着请求 B 的 CorpID + CorpSecret 去换 token,且两者被 token cache 合并成**同一次**上游请求。现在 `prepare()` 返回**绑定不可变 ctx 的新对象**,类上零实例字段;并且本类**刻意不再 `implements WecomProvider`** —— 唯一公开入口就是 `prepare()`,于是"未 prepare 就调用"降级成**编译错误**而非运行时错误。`return this;` 此前是全 `src/` 唯一一处:`cos.provider` / `wechat.provider` / `tencent-realname.provider` 一直是 closure 范式。

  **顺查结论**:`WechatMiniRealProvider` **不是**同形状 —— 它的 `prepare()` 早已返回绑定 ctx 的新对象;唯一的实例字段 `accessTokenCache` 是**按 `configurationGeneration` 校验后才命中**的进程级缓存,不是请求级状态,故不改。三处同款 provider 全仓核过,无第二例。

  **新增模块 `CLAUDE.md`**([`src/modules/wecom/CLAUDE.md`](src/modules/wecom/CLAUDE.md)):把上述三条写成 **T3 / T5B 的开工前置出生检查**(配置快照无状态传递 / 写路径锁后复读 / 上游事实不得用本地默认值补),连同"为什么"和 red-first 用例的位置。教训是整批评审给的那一条:**形状表此前没有进入新代码的出生检查** —— S1 清了三轮,新模块第一版又写出来一遍。

  **测试**:`providers/wecom.provider.spec.ts`(六组畸形响应 + 缺席/结构错分野 + 无状态形状 + 并发不串配置 + 日志纪律回归)· `wecom.service.spec.ts`(并发 `resolveRoute` 走真实编排路径)· `wecom-settings-concurrency.e2e-spec.ts`(真双连接锁后复读)。三条均**先写红、再修**,修复前的失败输出逐条留在 PR 描述里。
