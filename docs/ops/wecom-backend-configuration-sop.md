# 企业微信后台配置 SOP + 身份链启用 runbook(T6)

> **谁在什么时候读它**:维护者(SUPER_ADMIN 本人),在企业微信身份链**第一次**进生产之前,以及此后每次需要重配凭证 / 换可信 IP / 回滚身份链时。
> **读完要能做成什么**:把企业微信自建应用从零配到「10–30 人试点成员能在企业微信工作台里点开 SRVF 并免密进入」,每一步都有一条**可以自己判断过没过**的判据;以及在出问题时用一次开关操作把身份链干净地关掉。
>
> **需求真相源**:冻结稿 [`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md) §15.1(身份链 GO 条件)/ §15.4(回滚)/ §0.5(五条业务口径)。冲突以冻结稿为准。
> **消息链**不在本文:见 [`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md)。**试点名单与留证**见 [`wecom-pilot-playbook.md`](wecom-pilot-playbook.md)。**故障演练**见 [`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)。

---

## 0. 用法说明

### 0.1 谁执行

| 步骤 | 执行人 | 为什么不能是别人 |
|---|---|---|
| §2–§4(企业微信后台) | **维护者本人** | 企业微信管理后台是外部系统,AI 与本仓任何自动化都碰不到 |
| §5–§6(SRVF 配置面) | 维护者(`SUPER_ADMIN`)或持 `ops-admin` 的运维 | `reset-credentials` **只有 SUPER_ADMIN 能调**(该码不绑 ops-admin) |
| §7(可信 IP) | 维护者 + 服务器运维 | 需要同时知道服务器实际出口 IP 与企业微信后台 |
| §8(密钥注入) | 部署环境持有人 | `WECOM_ENCRYPTION_KEY` 是部署 env,不经过任何 API |
| §10–§13(启用与回滚) | 维护者 | 开关即产品行为变更 |

### 0.2 怎么读

- **按 §1 → §13 顺序执行,一次只配一样东西,配完立刻按该节「怎么验」验一次再往下走。**
  这不是洁癖:SRVF 把企业微信的**全部配置类错误归一成同一个码 36030**(见 §0.4),
  一次配三样再统一验证,失败时你分不出是哪一样错了。**逐项配置 + 逐项验证 = 用执行顺序换回可诊断性。**
- 每节末尾的 `✅ 判据` 是**这一节过没过**的唯一标准;`❌ 不符怎么办` 给出下一步。
- 占位符:`<API_HOST>`(SRVF 生产域名)· `<SA_TOKEN>`(SUPER_ADMIN 的 access token)。

### 0.3 🔴 凭证红线(违反一次就必须重置 CorpSecret)

**CorpID / AgentId / CorpSecret 只允许从企业微信后台页面复制,直接粘进下面的 HTTP 请求体,一次性完成。**

禁止出现在:

- 任何与 AI 的对话(含本仓 Claude Code / Codex 会话记录)、任何 issue / PR / commit message;
- 任何文档(含本文件)、任何截图、任何聊天工具、任何笔记应用;
- shell 命令行(会进 `~/.zsh_history`)—— 若不得不用 `curl`,见 §3.2 的免历史写法;
- 任何日志。SRVF 侧已有执行位:响应永不回显凭证、`corpId` 只出掩码、`reset` 的 audit 连字段名都不记。
  **红线针对的是 SRVF 之外的部分 —— 那里没有执行位,只有纪律。**

> CorpSecret 一旦进过上述任一处,就按泄露处理:在企业微信后台重置 Secret,再走一遍 §3。
> 本仓**不支持** `WECOM_ENCRYPTION_KEY` 在线轮换(冻结稿 §17 明确不做),但 **CorpSecret 本身可以随时重置**,代价只有一次 §3。

### 0.4 ⚠️ 先知道这条,否则 §7 会让你抓瞎

**企业微信的配置类错误在 SRVF 侧全部归一成 `36030`,且原始 `errcode` 不进日志。**

| 企业微信 errcode | 含义 | 你在 SRVF 看到的 |
|---|---|---|
| `40001` | CorpSecret 不合法 | `36030` |
| `40013` | CorpID 不合法 | `36030` |
| `40056` | AgentId 不合法 | `36030` |
| `50001` | redirect_url 未登记可信域名 | `36030` |
| `50003` | 应用已过期 | `36030` |
| `60020` | 访问 IP 不在可信 IP 白名单 | `36030` |

这是**刻意的**([`wecom.provider.ts`](../../src/modules/wecom/providers/wecom.provider.ts) 的 `throwByErrcode`
→ [`wecom.service.ts`](../../src/modules/wecom/wecom.service.ts) 的 `toBizException`):
上游 `errmsg` 原文与完整 URL 里带着 `corpsecret` / `access_token`,进日志就是凭证泄露。
代价是**运维侧看不到具体是哪一条配错了** —— 所以本 SOP 用「逐项配、逐项验」的执行顺序替代错误码诊断。

**真要拿原始 errcode 只有一条路**:维护者在服务器上绕开 SRVF 直接调企业微信接口(§7.3),
或用企业微信后台自带的接口调试工具。**这条路会把 CorpSecret 放进命令行**,须按 §3.2 的免历史写法执行。

---

## 1. 开工前:三件必须已经在生产就位的事

这三条不是企业微信的事,但少任何一条,后面的验证结果都不可信。

- [ ] **当前批准 release 已部署**,且部署的 image digest 与该 tag 一致(不看 tag 名,看 digest)。
      该 release 必须包含 T1–T4([#882](https://github.com/BA7IEE/srvf-nest-api/pull/882) /
      [#884](https://github.com/BA7IEE/srvf-nest-api/pull/884))—— 没有 T3 就没有 OAuth 端点,配了也没处用。
- [ ] **身份链 migration 已 deploy**:`WecomSettings` / `WecomIdentity` / `WecomAuthAttempt` 三张表
      (第 68 migration `20260801093000_wecom_identity_foundation`)。

  ```bash
  pnpm prisma migrate status
  ```

  ```sql
  -- 三张表都在(期望 3)
  SELECT count(*) FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('wecom_settings', 'wecom_identities', 'wecom_auth_attempts');
  ```

- [ ] **登录限流走 PostgreSQL shared storage**(§15.1 条 10)。本仓自 v0.59.0 起命名 throttler
      的计数已从每进程 Map 改为 PostgreSQL 共享存储,`login-wecom` 沿用同一存储 —— **无需额外配置**。
      ⚠️ 这一条的**实证**要等 §10.4 真跑过一次登录之后才做得了(没请求就没有桶),
      开工时只需确认部署没有覆盖限流相关 env;勾选放到 §14 清单里统一收。

  ```sql
  -- 跑过一次 §10.4 的工作台登录之后再执行:出现 login-wecom 的桶即证明
  -- 该 throttler 走的是 PostgreSQL 共享计数,而不是退回了每进程 Map
  SELECT "throttlerName", count(*) FROM throttler_buckets GROUP BY 1 ORDER BY 1;
  -- 期望:列表里能看到 login-wecom
  ```

✅ **判据**:三条全部勾上。
❌ **不符怎么办**:任一条没过就停在这里 —— 这些是部署问题,不是企业微信问题,继续往下配只会把两类问题混在一起。

---

## 2. 企业微信后台:创建自建应用(§15.1 条 1)

> **只有维护者能做。** AI 无法访问企业微信管理后台。

1. 用企业微信**管理员**账号登录企业微信管理后台。
2. 「应用管理 → 自建 → 创建应用」,建**一个**自建应用。
   - 名称建议能让试点成员一眼认出是 SRVF(例如「SRVF 队务」)—— 这个名字会出现在工作台图标和消息卡片来源上。
   - **不要建第二个应用**。本版是单企业、单自建应用 Agent(冻结稿 §0.1),多 Agent 不在支持范围。
3. 记下应用详情页的 **AgentId**(数字)。
4. 记下「我的企业 → 企业信息」里的 **企业ID(CorpID)**。
5. 应用详情页的 **Secret** 先不要取 —— 等 §3.2 要粘的时候再取,取完立刻用掉(红线 §0.3)。

✅ **判据**:后台能看到这个自建应用,状态为「已启用」,且你手上有 CorpID 与 AgentId 两个值。
❌ **不符怎么办**:创建不了应用通常是当前账号不是企业管理员 —— 换管理员账号,或请企业超管授权。
这一步 SRVF 侧完全无感,没有任何东西可查。

---

## 3. 把凭证录进 SRVF(§15.1 条 2)

### 3.1 先录非凭证字段(CorpID / AgentId)

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"providerType":"WECOM","corpId":"<CORP_ID>","agentId":<AGENT_ID>}'
```

> `providerType` 必须是 `"WECOM"`。生产环境写 `"DEV_STUB"` 会被**写入口直接拒绝**(第①重),
> 这是刻意的:登录链路上 fallback 到 stub 等于放假身份进生产。

⚠️ **CorpID 只能在「当前 active 绑定数 = 0」时修改**,否则返 `36020`。
首次配置时一定是 0;**但这意味着一旦试点跑起来,改 CorpID 就必须先清掉全部绑定** —— 所以第一次就填对。

### 3.2 再录 CorpSecret(独立端点,只有 SUPER_ADMIN 能调)

```bash
read -rs WECOM_SECRET && curl -X POST https://<API_HOST>/api/system/v1/wecom-settings/reset-credentials -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d "{\"corpSecret\":\"$WECOM_SECRET\"}"; unset WECOM_SECRET
```

> `read -rs` 是 §0.3 说的**免历史写法**:粘贴时不回显,secret 不出现在命令行,也就不进 shell history。
> 直接写 `-d '{"corpSecret":"xxx"}'` 会让它永久留在 `~/.zsh_history` —— 那是红线。

✅ **判据**:

```bash
curl -s https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>"
```

`data` 中应满足:

| 字段 | 期望 | 含义 |
|---|---|---|
| `providerType` | `"WECOM"` | 不是 stub |
| `credentialStatus` | `"configured"` | **密文能被当前 `WECOM_ENCRYPTION_KEY` 解开** |
| `credentialConfigured` | `true` | DB 里确实有密文 |
| `corpIdMasked` | 形如 `ww12****cdef` | 与你录的 CorpID 首尾一致 |
| `agentId` | 你录的数字 | — |
| `enabled` / `loginEnabled` / `messageEnabled` | 三个都是 `false` | **此刻还什么都没开,这是对的** |

❌ **不符怎么办**:

- `credentialStatus="invalid"` ⇒ 密文在但解不开 = 部署的 `WECOM_ENCRYPTION_KEY` 与写入时不是同一把。
  **先做 §8,再重跑 §3.2**。本版不支持 key 轮换,落到 `invalid` 即 fail-closed,不会自动重加密。
- `credentialStatus="missing"` ⇒ `reset-credentials` 没成功。查响应码:`403` = 用的不是 SUPER_ADMIN token。
- 整个 `data` 是 `null` ⇒ 一次 PATCH 都没成功过,回 §3.1。

---

## 4. 应用可见范围只开试点名单(§15.1 条 3)

> **只有维护者能做**(企业微信后台)。

在自建应用详情页「可见范围」里,**逐个添加**试点成员(名单来自 [`wecom-pilot-playbook.md`](wecom-pilot-playbook.md) §2)。

🔴 **必须逐人添加,不能添加部门,不能添加标签,不能开全员。**

三个理由,每个都独立成立:

1. §15.3 明令「应用可见范围不得先开全员」;
2. 加部门 = 该部门**将来**进人时试点范围自动扩大,而且没有任何人会收到通知;
3. SRVF 侧**永远不会**用部门 / 标签发消息(请求体只有 `touser`,`toparty`/`totag` 在代码里根本不存在),
   所以在可见范围里放部门对 SRVF 没有任何用处,只有扩大暴露面这一个效果。

✅ **判据**(要等 §10.1 开了总闸才跑得起来;此处先记住期望值):

`POST /api/system/v1/wecom-settings/test-connection` 的 `visibilitySummary` 应满足:

| 字段 | 期望 |
|---|---|
| `directUsers` | **等于试点名单人数**(10–30) |
| `parties` | **0** |
| `tags` | **0** |

❌ **不符怎么办**:

- `parties > 0` 或 `tags > 0` ⇒ 可见范围里加了部门或标签。回后台改成逐人,**不要**因为「反正 SRVF 不用部门」就放着。
- `directUsers` 比名单多 ⇒ 多加了人,逐个核对删掉。
- `directUsers` 比名单少 ⇒ 少加了人;注意该计数是企业微信侧的**直接成员**数,不会把部门展开成人数,
  所以「少」也可能意味着你把人加进了某个部门条目而不是直接成员。

> ⚠️ 这个接口**只返回计数,没有任何成员 ID**(类型上就没有存 ID 的字段)。
> 它是连通性诊断,不是通讯录导出接口 —— 核对具体是谁只能回企业微信后台看。

---

## 5. 配置 `webBaseUrl`(§15.1 条 4)

`webBaseUrl` 是试点成员在企业微信工作台里打开的那个 H5 站点的 **origin**。

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"webBaseUrl":"https://app.example.com"}'
```

🔴 **只能是 origin,不能带 path / query / fragment。** 生产环境强制 **HTTPS**。

为什么这么严:OAuth 回跳地址与消息深链都由**代码固定拼接**(`<webBaseUrl>/auth/wecom/callback`)。
如果允许配置里带 path,这个配置面就成了「改回跳目标」的入口 —— 那是一个开放重定向漏洞的注入点。

✅ **判据**:`GET wecom-settings` 的 `webBaseUrl` 与你填的逐字符相同,且以 `https://` 开头、不含路径。
❌ **不符怎么办**:返回 `40000` ⇒ 带了 path/query 或不是 HTTPS。去掉多余部分重试。

---

## 6. OAuth 可信域名 / 回调域名(§15.1 条 5)

> **只有维护者能做**(企业微信后台)。

在自建应用详情页「网页授权及JS-SDK」/「可信域名」处,登记 §5 里 `webBaseUrl` 的域名
(例如 `app.example.com`)。**按企业微信后台届时的规则执行** —— 官方可能要求上传域名归属校验文件,
这部分规则本仓**刻意不硬编码**(冻结稿 §15.1 条 5:「不把具体后台规则硬编码进 T0」)。

### 6.1 这一条 SRVF **验不了**,只能靠真实 OAuth 回跳

`test-connection` 里有一个字段叫 `redirectDomainConfigured`,**它证明不了这一条**:

> 它只表示「SRVF 本地配了 `webBaseUrl`」,与企业微信后台那侧有没有登记可信域名**完全无关**。
> —— 这句话写在 [`wecom.dto.ts`](../../src/modules/wecom/wecom.dto.ts) 该字段的描述里,不是本文的推测。

✅ **判据**:**唯一判据是 §10.4 的工作台实跑** —— 试点成员在企业微信客户端里打开 H5,能走完 OAuth 回跳。
❌ **不符怎么办**:回跳失败(通常表现为企业微信客户端直接报错、根本没回到 SRVF)⇒ 可信域名没配对。
这也是 §0.4 说的那类「SRVF 看不见 errcode」情形:上游 `50001` 在 SRVF 侧就是 `36030`。
**先回后台逐字符核对域名**,再考虑是不是生效延迟(参照 §7.2 的等待协议)。

---

## 7. 静态出口 IP 与企业可信 IP(§15.1 条 6)

### 7.1 做什么

1. **确认服务器出口 IP 是静态的。** 如果是动态 IP,或多实例各自出网,这一步做完也会随时失效 ——
   那属于基础设施问题,必须先解决(固定 NAT 网关 / 弹性公网 IP),不能靠「先配上试试」。
2. 在 **SRVF 服务器上**取实际出口 IP:

   ```bash
   curl -s https://ifconfig.me
   ```

   ⚠️ 必须在**服务器上**跑,不是在你自己的电脑上跑 —— 那两个 IP 通常不一样,配错了会白等一个生效窗口。
3. 在企业微信后台「应用详情 → 企业可信IP」把该 IP 加进去(多实例就把每个出口 IP 都加上)。

### 7.2 生效窗口:等多久、以什么现象为准

企业微信侧的配置有生效延迟。**冻结稿没有给出确定时长,本文不编造官方数字。**

**以什么现象为准**(正面证据,不是等时间):

> `POST /api/system/v1/wecom-settings/test-connection` 返回 **200** 且 `tokenAcquired: true`
> ⇒ **可信 IP 已生效。**

理由:可信 IP 没生效时,企业微信在 `gettoken` 这一步就返 `60020`,
SRVF 会把它归一成 `36030` 抛出(拿不到 200)。所以**能拿到 token 本身就是 IP 白名单已放行的证明**。
反过来不成立:拿到 `36030` **不能**单独证明是 IP 问题(§0.4 那六个码长得一模一样)。

**操作协议**:

| | |
|---|---|
| 重试节奏 | 配置后每 **5 分钟**跑一次 `test-connection` |
| 观察上限 | 累计 **30 分钟** |
| 超时怎么办 | 转 §7.3 判别流程 |

> ⚠️ 「5 分钟 / 30 分钟」是**本文档约定的操作阈值,不是企业微信官方承诺的生效上限**。
> 它的作用只是「什么时候该停止傻等、开始查配置」,不是「超过就一定是配错了」。

### 7.3 判别:是配错了,还是只是没生效

SRVF 侧区分不了(§0.4)。按下面顺序排除,**每一步都是独立证据**:

1. **逐字符比对**:后台登记的 IP vs §7.1 第 2 步在服务器上取到的 IP。
   - **不一致 ⇒ 配错了,等多久都没用。** 改掉,重新开始 §7.2 的等待。
   - 一致 ⇒ 进入第 2 步。
2. **看错误有没有变过形**。如果中途 `test-connection` 的失败从 `36030` 变成了**别的**表现
   (例如 200 但 `agentMatched:false`),说明 **IP 这一关已经过了**,现在卡的是别的配置项 —— 去查 §3 / §2。
3. **拿原始 errcode**(最后手段;会把 CorpSecret 放进命令行,须按 §3.2 的免历史写法):
   在**服务器上**直接调企业微信 `gettoken`,看返回的 `errcode`。
   - `60020` ⇒ 确实还是 IP 问题(要么没生效,要么后台登记的和服务器实际出口仍不一致);
   - `40001` ⇒ CorpSecret 错,回 §3.2;
   - `40013` ⇒ CorpID 错,回 §3.1;
   - `0` 而 SRVF 仍失败 ⇒ 问题在 SRVF 侧(`credentialStatus` / `enabled`),回 §3 的判据表。

   跑完**立刻**清掉 shell 变量与任何临时文件。

✅ **判据**:`test-connection` 返回 200 且 `tokenAcquired:true`。
❌ **不符怎么办**:走完 §7.3 三步。三步都排除不了 ⇒ 停下来,按 [`process.md §4.1`](../process.md) 上报,
**不要**开始改代码或放宽任何校验。

---

## 8. production `WECOM_ENCRYPTION_KEY` 注入(§15.1 条 7)

- 生成:`openssl rand -base64 32`
- 注入:部署环境的 secret 管理(env `WECOM_ENCRYPTION_KEY`),**不进仓库、不进任何文档**。
- 启动校验已有执行位:production / smoke 下**为空或短于 32 字符会 fail-fast 拒绝启动**
  ([`app.config.ts`](../../src/config/app.config.ts))。
- 🔴 **这把 key 与 STORAGE / SMS / WECHAT / REALNAME 四把互不复用**(D-WC-12),派生 salt 也各不相同。
  共用会把「换掉小程序凭证」和「换掉企业微信凭证」绑成同一次运维动作。
- 🔴 **本版不支持在线轮换。** 换了这把 key,已存的 CorpSecret 密文就解不开,`credentialStatus` 变
  `invalid`,通道整体 fail-closed(不会静默用错的凭证)。想换 key = 换完之后重跑一次 §3.2。

✅ **判据**:服务能正常启动(说明启动校验过了)+ §3 的 `credentialStatus="configured"`(说明这把 key 和密文对得上)。
❌ **不符怎么办**:服务起不来看启动日志的 fail-fast 文案;`credentialStatus="invalid"` 见 §3 的处置。

---

## 9. 三条纯服务端条件(§15.1 条 8/9/10)

这三条**不需要企业微信后台参与**,但要在开总闸前确认。

| # | 条件 | 怎么验 |
|---|---|---|
| 8 | **DEV_STUB 双重禁用已 smoke** | 在生产尝试 `PATCH {"providerType":"DEV_STUB"}` ⇒ 期望被**拒绝**(第①重,写入口)。即便某种途径让它进了 DB,`test-connection` 仍会拒(第②重,运行时)。**两重都要在生产上真试一次**,不能只信测试 |
| 9 | state / ticket 表 migration 已部署 | 见 §1 第 2 条的 SQL(`wecom_auth_attempts` 在列即可) |
| 10 | 登录限流走 PostgreSQL shared storage | 见 §1 第 3 条 |

✅ **判据**:三行都验过。
❌ **不符怎么办**:第 8 条若 `PATCH DEV_STUB` **成功了**,这是严重问题 —— 立刻停止,按 §4.1 上报;
不要继续开任何开关。

---

## 10. 身份链启用顺序(三步,不可颠倒)

### 10.0 为什么是这个顺序

§15.1 最后一条要求:**`loginEnabled` 启用前必须 `enabled=true` 且 `messageEnabled=false`。**

代码侧还有一条从冻结稿读不出来、但决定了操作顺序的事实:

> **`test-connection` 自己就要求 `enabled=true`。**
> 它内部走 `routeFor()`,而 `routeFor()` 第一件事就是 `if (!enabled) throw`
> ([`wecom.service.ts`](../../src/modules/wecom/wecom.service.ts))。
> 所以**在开总闸之前,你没有任何办法验证凭证配对没配对。**

于是 `enabled=true && loginEnabled=false && messageEnabled=false` 是一个**刻意存在的安全诊断态**:
总闸开着让诊断跑得起来,两个二级闸关着让任何真实用户路径都走不通。

支撑这句话的执行位(全部在代码里,不靠自觉):

- **取授权 URL**:`getAuthorizeContext` 同时要求 `enabled && loginEnabled` ⇒ 拿不到授权 URL;
- **换会话**:`resolveLoginContext` 判 `loginEnabled` ⇒ `36030`;
- **绑定**:[`login-wecom.service.ts`](../../src/modules/auth/login-wecom.service.ts) 与
  [`user-wecom-binding.service.ts`](../../src/modules/users/user-wecom-binding.service.ts)
  **都在事务内锁后复判 `enabled && loginEnabled`** ⇒ 手握未过期 `bindingTicket` 的人也建不成身份;
- **消息**:`messageEnabled=false` ⇒ publish 时就不建 root intent。

### 10.1 第一步:开总闸

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"enabled":true}'
```

✅ **判据**:`GET wecom-settings` ⇒ `enabled:true` / `loginEnabled:false` / `messageEnabled:false`。
**这一步不会让任何人能登录,也不会发出任何消息。**

### 10.2 第二步:连接诊断(这是 §2–§9 的总验收)

```bash
curl -X POST https://<API_HOST>/api/system/v1/wecom-settings/test-connection -H "Authorization: Bearer <SA_TOKEN>"
```

期望响应:

| 字段 | 期望 | 不符时指向 |
|---|---|---|
| HTTP | `200`(不是 `36030`) | §7.3 |
| `ok` | `true` | 下面 `agentMatched` / `agentEnabled` 至少一条不对 |
| `credentialStatus` | `"configured"` | §3 / §8 |
| `tokenAcquired` | `true` | §7(**这就是可信 IP 已生效的证明**) |
| `agentMatched` | `true` | AgentId 填错,回 §3.1 |
| `agentEnabled` | `true` | 应用在后台被停用了,回 §2 |
| `visibilitySummary.directUsers` | = 试点人数 | §4 |
| `visibilitySummary.parties` / `.tags` | `0` / `0` | §4(加了部门或标签) |
| `redirectDomainConfigured` | `true` | §5 没配 `webBaseUrl`。⚠️ **它不代表可信域名配好了**(§6.1) |

> ⚠️ 这个接口**不写审计、不发消息、不读通讯录明细**,可以放心反复跑。
> 它每次都**强制跳过 token 缓存**取新 token —— 命中缓存等于用几小时前的配置冒充当前状态。

✅ **判据**:上表逐行满足。
❌ **不符怎么办**:按表右列回对应节。**在这一步没全绿之前,绝对不要开 `loginEnabled`** ——
开了之后失败的就不是你一个人的诊断请求,而是试点成员的登录。

### 10.3 第三步:开登录二级闸

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"loginEnabled":true}'
```

> ⚠️ **两个开关必须分两次开。** 一次 PATCH 里同时写 `enabled` 和 `loginEnabled`,
> 出问题时你分不清是「通道没通」还是「登录链有问题」。
> (代码侧有跨字段不变量:`loginEnabled=true` 必须 `enabled=true`,否则 `40000` ——
> 但那只保证你写不出自相矛盾的配置,不替你保证可诊断性。)

✅ **判据**:`GET wecom-settings` ⇒ `enabled:true` / `loginEnabled:true` / **`messageEnabled:false`**。
最后一项是 §15.1 末条的显式检查项 —— **身份链试点期间消息链必须是关的**。

### 10.4 第四步:工作台实跑(§15.1 条 12;这才是可信域名的唯一验收)

由 **1 名试点成员**(建议先用维护者自己的账号)在**企业微信客户端**内打开工作台里的 SRVF 应用:

| 步骤 | 期望 |
|---|---|
| 点开应用 | 落到 `<webBaseUrl>` 的 H5 页 |
| 页面发起授权 | 跳转企业微信授权页并自动回跳 `<webBaseUrl>/auth/wecom/callback?code=…&state=…` |
| 落地页 POST 换会话 | 首次(未绑定):`bindingRequired:true` + 一次性 `bindingTicket`;已绑定:`bindingRequired:false` + `session` |

✅ **判据**:能走到「拿到 `bindingTicket` 或 `session`」。**走到这里 = §6 可信域名这一条过了。**
❌ **不符怎么办**:

- 企业微信客户端里直接报错、根本没回跳 ⇒ 可信域名(§6);
- 回跳了但换会话返 `36030` ⇒ 开关或通道配置,回 §10.2 重跑诊断;
- 回跳了但换会话返 `36010` ⇒ 这是**防侧写归一码**:state 无效 / code 无效 / 上游返 `openid` 或
  `external_userid` / 跨企业 `CorpId/userid` / 绑定指向已停用或软删的 User / 锁后校验失败 ——
  六类原因**对外逐字段同形**。现实中最常见的是页面重复提交(code 只能用一次)或超时(5 分钟)。
  **重新发起一次登录**;连续复现再上报。
  **不要试图从响应里区分原因** —— 区分开就是账号存在性与状态探测器。

> 🔴 **落地页红线**:`code` / `state` **禁止**进入埋点、错误上报、`localStorage` / `sessionStorage` 或任何日志;
> 换完会话立刻 `history.replaceState` 清理地址栏。这条归前端,后端管不到 ——
> 见 [`handoff/miniapp.md`](../handoff/miniapp.md) §1.3。

### 10.5 ⚠️「Workbench 主页」不是后端交付物

冻结稿 T6 清单里的「Workbench 主页」指的是**企业微信客户端工作台里打开的那个 H5 落地页**,
归**前端仓 + 企业微信后台配置**(D-WC-29)。后端 OAuth 链在 T3 已全部备齐,**本期不新建任何后端端点**。

维护者在后台该填什么:自建应用详情页的**工作台应用主页 / 应用主页 URL**,填成 §5 的
`<webBaseUrl>` 加上前端约定的入口路径(具体路径由前端仓给出)。
FE 待适配清单已登记在 [`handoff/miniapp.md`](../handoff/miniapp.md) §1.3 与
[`handoff/admin-web.md`](../handoff/admin-web.md) §2.4。

🔴 **明确不在验收范围**:普通 PC 浏览器的企业微信扫码登录(D-WC-29 / 冻结稿 §17)。
PC 管理后台继续用密码 / 短信登录,一字不动。有人报「PC 上扫不了码」—— **那不是缺陷,是本版不做**。

---

## 11. 生命周期与兜底演练(§15.1 条 11/13)

这两条的**执行细节与留证格式**在 [`wecom-pilot-playbook.md`](wecom-pilot-playbook.md) §4,此处只列必须完成的集合:

- [ ] 条 11:试点账号完成 **SMS 首次绑定**;
- [ ] 条 11:**无绑定手机号 → 原账号登录 → step-up self-bind** 兜底演练;
- [ ] 条 13:`disable` / `enable`、`offboard` / 恢复、`soft-delete`、`account reopen`、`admin clear` 五类演练。

---

## 12. 日志红线核验(§15.1 条 14)

在完成 §10.4 与 §11 之后,**在生产日志里搜一遍**,确认下列内容一条都没有:

| 搜什么 | 期望 |
|---|---|
| 完整 OAuth URL(含 `code=` / `state=`) | 0 命中 |
| `corpsecret=` / `access_token=` | 0 命中 |
| 完整 `wecomUserId`(非掩码) | 0 命中 |
| binding ticket 原文 | 0 命中 |

代码侧已有执行位(不记完整 URL / body / 上游 errmsg 原文,只保留归一化标签;`recipientRef` 只存掩码),
**这一步是验证部署后的真实输出,不是重新审代码** —— 反向代理、APM、前端错误上报都可能在 SRVF 之外把这些记下来。

✅ **判据**:四行全 0 命中。
❌ **不符怎么办**:命中即视为凭证 / 身份泄露 —— 清理该日志源、按 §0.3 重置对应凭证,并上报。

---

## 13. 身份链回滚(§15.4)

### 13.1 怎么回滚

**一次 PATCH,关掉登录二级闸即可:**

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"loginEnabled":false}'
```

`enabled` **可以保留为 true**(留着才能继续跑 `test-connection` 诊断)。

### 13.2 🔴 回滚**不会**影响什么(这段是给「不敢按下去」的人看的)

按下去之前你需要确切知道它不碰什么。以下每条都有代码执行位:

| 不受影响的东西 | 为什么 |
|---|---|
| **已经签发的 JWT** | 继续按原规则运行到自然过期。`loginEnabled` 只挡**新签发**,不撤销既有会话 |
| **密码登录** | 完全独立的端点与链路,`wecom_settings` 碰不到它 |
| **短信验证码登录** | 同上 |
| **微信小程序登录** | 同上。`wecom` 与 `wechat` 是两个外部主体,表、错误码、身份键、通道全部分家 |
| **`wecom_identities` 历史** | 一行不删。回滚**禁止**删表、删身份历史、移动 tag |
| **schema / migration** | 一律保留 |
| **站内信 / 微信订阅 / 短信通知** | 全部照常 |

**会立刻停止的**:

- 新的企业微信 OAuth 授权 URL 签发(`36030`);
- 用 `code` 换会话(`36030`);
- **手里已经拿着未过期 `bindingTicket` 的人也绑不成** —— 绑定事务内锁后复判 `enabled && loginEnabled`,
  这一条有 e2e 钉住(少了它,关掉开关之后仍能建身份**并拿到会话**)。

### 13.3 回滚后怎么恢复

修好根因,重跑 §10.2 诊断全绿,再 `loginEnabled=true`。**不要跳过诊断直接开** ——
回滚通常意味着某项配置出了问题,不重验就开等于把同一个故障再放出去一次。

---

## 14. §15.1 十五条 GO 勾选清单

> 全部勾上才算身份链 GO。逐条对应冻结稿 §15.1 的十五个条目,**顺序即执行顺序**。

- [ ] 1. 企业微信自建应用已创建 → §2
- [ ] 2. CorpID / AgentId / CorpSecret 已由维护者录入(`credentialStatus="configured"`)→ §3
- [ ] 3. 应用可见范围只含已确认的 10–30 名分层试点成员(`parties=0` / `tags=0`)→ §4
- [ ] 4. `webBaseUrl` HTTPS origin 已配置 → §5
- [ ] 5. OAuth 可信域名已按后台届时规则配置,**并以真实 OAuth 成功为验收** → §6 + §10.4
- [ ] 6. 服务器静态出口 IP 已加入企业可信 IP,**且已确认生效**(`tokenAcquired:true`)→ §7
- [ ] 7. production `WECOM_ENCRYPTION_KEY` 已安全注入 → §8
- [ ] 8. DEV_STUB 双重禁用已在生产 smoke → §9
- [ ] 9. state / ticket 表 migration 已部署 → §1 + §9
- [ ] 10. 登录限流使用 PostgreSQL shared storage → §1 + §9
- [ ] 11. 试点账号完成 SMS 首次绑定 + 无手机号 step-up self-bind 兜底演练 → §11 · playbook §4
- [ ] 12. 企业微信客户端工作台 H5 登录已验收;**PC 扫码登录明确不在验收范围** → §10.4 / §10.5
- [ ] 13. disable/enable、offboard/恢复、soft-delete、account reopen、admin clear 演练完成 → §11 · playbook §4
- [ ] 14. 日志中无完整 URL / code / state / ticket / wecomUserId / token / secret → §12
- [ ] 15. **`loginEnabled` 启用前 `enabled=true`、`messageEnabled=false`** → §10.3 判据

签署(维护者):______________  日期:____________

---

## 15. 只有维护者能做的事(AI 一律碰不到)

本文件里所有 🔴 标记的动作,加上下表,构成「AI 做不了」的完整边界:

| 动作 | 为什么 AI 做不了 |
|---|---|
| 企业微信管理后台的**任何**操作(建应用 / 可见范围 / 可信域名 / 可信 IP / 应用主页 URL) | 外部系统,无凭证、无访问路径 |
| 取 CorpID / AgentId / **CorpSecret** | 凭证获取本身是维护者动作;红线 §0.3 禁止凭证进入任何 AI 会话 |
| 调 `PATCH` / `reset-credentials` 打开任何开关 | 需要生产 SUPER_ADMIN token;且开关即产品行为变更 |
| `prisma migrate deploy` / 生产环境任何读写 | 生产环境操作 |
| 注入 `WECOM_ENCRYPTION_KEY` | 部署环境 secret |
| 在企业微信客户端里实跑工作台 H5 | 需要真实企业微信账号与手机 |
| §7.3 第 3 步(直调 gettoken 拿原始 errcode) | 会接触 CorpSecret |
| 签署 §14 的 GO | 这是人的决定,不是检查项 |

---

## 16. 相关文档

- 冻结稿 §15 / §0.5:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
- 消息链上线与回滚:[`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md)
- 试点名单与十项留证:[`wecom-pilot-playbook.md`](wecom-pilot-playbook.md)
- 失败注入剧本:[`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)
- 通道层本地铁律:[`src/modules/wecom/CLAUDE.md`](../../src/modules/wecom/CLAUDE.md)
- 前端对接:[`handoff/miniapp.md`](../handoff/miniapp.md) §1.3 · [`handoff/admin-web.md`](../handoff/admin-web.md) §2.4
