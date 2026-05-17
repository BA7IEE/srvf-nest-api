# 第一版前端 BizCode / API 契约冻结(P0-G 全量翻译表)

> 用途:第一版前端联调阶段**唯一全量** BizCode 翻译表;每条 BizCode 给出 `code` / 常量名 / 后端 message / HTTP status / 触发场景 / 前端处理建议 / 第一版常见度。
>
> 本文与 [`first-release-frontend-scope.md`](first-release-frontend-scope.md) 配合使用:scope 决定"前端接哪些接口",本文决定"接口可能撞哪些 BizCode、撞了怎么处理"。
>
> 冲突优先级(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > `srvf-foundation-baseline.md` > `V2红线与复活路径.md` > 单批次评审稿 > handoff > `current-state.md` > `process.md` > [`first-release-frontend-scope.md`](first-release-frontend-scope.md) > 本文。冲突时本文让步。
>
> 本文不承载:接口字段(回 [`v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs`)、数据模型(回 [`prisma/schema.prisma`](../prisma/schema.prisma) + [`v2-data-model.md`](v2-data-model.md))、字典 item 真实取值(留 P0-C bootstrap SOP)、测试账号凭据(留 P0-C)、上传 / 下载 sequence 图(回 [`first-release-frontend-scope.md §7`](first-release-frontend-scope.md))、UI 文案字面(前端定)。

---

## 1. 用途与定位

### 1.1 本文是什么

- **第一版前端 BizCode 翻译表唯一权威源**:覆盖 `src/common/exceptions/biz-code.constant.ts` 中**全部 122 条** BizCode
- **包含起步包内不撞、但第一版生命周期内可能撞的码**:防止前端 P1 后接阶段遇到错误无文档可查
- **包含 RBAC / 配置三表等"暂不接"模块的码**:前端不接 ≠ 不知道存在;给前端一份"看到该 code 不必慌"的兜底参考

### 1.2 本文不是什么

- **不是接口契约**:接口字段 / 入参 / 出参 schema → [`v2-api-contract.md`](v2-api-contract.md) + Swagger
- **不是前端文案表**:本文给"语义提示"和"处理类别建议";UI 文案字面由前端按设计稿决定
- **不是 BizCode 维护台账**:新增 / 修改 BizCode 仍走 [`baseline §1.4`](srvf-foundation-baseline.md) 流程,本文随之滚动
- **不是错误处理代码示例**:不规定前端用 `axios interceptor` / `react-query` / 别的方式接管错误,只给"语义判断点"

### 1.3 BizCode 实数说明

撰写时(基于 `main` HEAD `a240e0a`)`biz-code.constant.ts` 实数 **122 条**(精确点数命令 `grep -cE "^  [A-Z][A-Z0-9_]+: \{" src/common/exceptions/biz-code.constant.ts`)。本文 §4 全量翻译表对应 122 条;若实数与本文记数不一致,以源码为准。

---

## 2. 错误响应统一形态

### 2.1 成功 / 失败两种响应体

**成功响应**(经 `ResponseInterceptor` 包装,沿 [`CLAUDE.md §4`](../CLAUDE.md)):

```json
{
  "code": 0,
  "message": "ok",
  "data": <T> | null
}
```

- HTTP status 由 controller 决定:GET / PATCH / PUT / DELETE 默认 200;POST 默认 201(以 NestJS 默认 + controller `@HttpCode(...)` 显式覆盖为准,详见 Swagger)
- `data` 字段为业务负载;**禁止**有 `code: 0` 但 `data` 内嵌另一份 `{ code, message, data }` 的"双层包装"
- 列表接口的 `data` 为 `PageResultDto<T>`(沿 [`frontend-scope.md §3.4`](first-release-frontend-scope.md))

**失败响应**(经 `AllExceptionsFilter` 包装):

```json
{
  "code": <BizCode.code>,
  "message": "<biz message>",
  "data": null
}
```

- HTTP status 由 `BizCode.httpStatus` 决定(沿 [`CLAUDE.md §5`](../CLAUDE.md));**不为"统一"返 HTTP 200**
- `message` 是后端权威语义;**前端可以直接显示给用户,也可以用 `code` 映射为本地化文案**(见 §6.2)
- `data` 始终为 `null`

### 2.2 HTTP status 与 code 关系

`AllExceptionsFilter` 按以下顺序判断异常类型并构造响应(沿 [`src/common/filters/all-exceptions.filter.ts`](../src/common/filters/all-exceptions.filter.ts)):

1. **`BizException`**:`response.status(biz.httpStatus).json({ code: biz.code, message: biz.message, data: null })`
   - HTTP status 与 `code` 一一对应,定义在 BizCode 常量(见 §4 全量表)
2. **NestJS `HttpException`(非 `BizException`)**:沿用 `exception.getStatus()`,`code` 用通用 BizCode 兜底:
   - 400 → `BAD_REQUEST = 40000`(`message` 透传 ValidationPipe 数组,见 §2.3)
   - 401 → `UNAUTHORIZED = 40100`
   - 403 → `FORBIDDEN = 40300`
   - 404 → `NOT_FOUND = 40400`
   - 其他 HTTP status(412 / 422 / 503 等)→ `code = INTERNAL_ERROR.code = 50000`,但 HTTP status **沿用原值**(注意:`code` 与 HTTP 不一一对应的唯一场景)
3. **未知异常**:HTTP 500 + `code: 50000` + `message`:
   - 生产环境(`APP_ENV=production`):用 `INTERNAL_ERROR.message`(`"服务器内部错误"`),**不暴露** `error.message`
   - 非生产环境:`message` 为 `error.message`(便于调试)

**铁律**:前端**应当**按 `code` 字段做业务判断,**不要**按 HTTP status 做主判断;HTTP status 在 401(LOGIN_FAILED / UNAUTHORIZED 共用)和上述 412 / 422 / 503 等罕见场景下,无法区分具体业务原因。

### 2.3 ValidationPipe 40000 与业务码区别

- **`40000 BAD_REQUEST`**(通用)由全局 `ValidationPipe` 抛出 → 字段级校验失败 / `forbidNonWhitelisted` 命中未声明字段:
  - `message` 为 ValidationPipe 输出的字段错误列表,**多条错误用 `; ` 拼接成单个字符串**(沿 `AllExceptionsFilter.resolveHttpExceptionMessage`)
  - 例:`"username must match /^[a-z0-9_-]{3,32}$/; password must be longer than or equal to 8 characters"`
  - 前端处理:可以直接展示给用户(便于排错);若需结构化(逐字段红框),后端不提供按字段 split 的 API,前端按 `; ` 切分自处理
- **业务级 `XX010-XX029` 输入校验**(沿 [`baseline §1.3`](srvf-foundation-baseline.md))由 service 显式抛出 `BizException` → 业务规则级校验:
  - 例:`MEMBER_PROFILE_GENDER_CODE_INVALID`(性别字典 code 不存在或已停用)
  - 出现这类码意味着**字段格式 OK 但业务规则不通过**;前端通常需要弹特定提示,而不是简单"参数错误"

### 2.4 不返 200 包装的端点

`ResponseInterceptor` 用前缀匹配跳过以下 URL,响应**不**包装,**前端不应**按 `{ code, message, data }` 解析(沿 [`src/common/interceptors/response.interceptor.ts`](../src/common/interceptors/response.interceptor.ts)):

| 前缀 | 用途 | 响应形态 |
|---|---|---|
| `/api/docs` | Swagger UI(HTML)/ `/api/docs-json` / `/api/docs-yaml`(OpenAPI spec) | HTML / JSON / YAML 原文 |
| `/favicon.ico` | 浏览器自动请求,非业务响应 | 二进制 |
| `/metrics` | Prometheus 文本(若启用) | text/plain |
| `StreamableFile` 类响应 | 文件下载流 | 二进制流(`application/octet-stream` 等) |

第一版前端**不直接调用**这些端点(Swagger 是开发工具;`/metrics` 不暴露给浏览器;`favicon.ico` 浏览器自请求);**但应当知道**自己拼接 URL 时不要按业务包装格式解析。

---

## 3. 段位地图

### 3.1 通用 HTTP 段(`4xxxx` / `5xxxx`)

沿 [`baseline §1.2`](srvf-foundation-baseline.md) 与 [`CLAUDE.md §5`](../CLAUDE.md):

| code | 段位归属 | 用途 |
|---|---|---|
| `40000` | 通用 HTTP | `ValidationPipe` 默认 / 业务级 `BAD_REQUEST` |
| `40100` | 通用 HTTP | token 无效 / 过期 / 用户被禁 / 用户被软删(`JwtStrategy.validate()`) |
| `40300` | 通用 HTTP | Guard 拒绝(`@Roles` 不满足);**业务级模块禁止**自创 `FORBIDDEN_*` 码(沿 baseline,Guard 拒绝走通用 403) |
| `40400` | 通用 HTTP | 路径不存在(NestJS 路由未匹配);**资源类不存在**用模块自有 `XX001` |
| `42900` | 通用 HTTP | 登录限流命中(V1.1);**不暴露**阈值 / 剩余配额 / 重置时间 |
| `50000` | 通用 HTTP | 服务器内部错误;生产环境不暴露 `error.message` |

**铁律**:模块业务码段(`100xx` 起)**不得**为通用 token / 鉴权 / 限流失败自创业务码;复用上述 6 个通用码即可。

### 3.2 V2 模块段位总表

沿 [`baseline §1.1`](srvf-foundation-baseline.md):

| 段位 | 模块 | 容量 | 状态 |
|---|---|---|---|
| `100xx` + `101xx` | `auth` + `users` | 200 | v1 已锁,不动 |
| `110xx` + `111xx` | `organizations` | 200 | 已实装 |
| `120xx` + `121xx` | `dictionaries` | 200 | 已实装 |
| `130xx` + `131xx` | `attachments`(主模块 + 配置三表 + 跨表 IN_USE + 系统级 MIME 黑名单) | 200 | 已实装 |
| `140xx` + `141xx` | `audit_logs` | 200 | 已实装 |
| `150xx` + `151xx` | `members` | 200 | 已实装 |
| `160xx` + `161xx` | `member_profiles` | 200 | 已实装 |
| `170xx` + `171xx` | `member_departments` | 200 | 已实装 |
| `180xx` + `181xx` | `certificates` | 200 | 已实装 |
| `190xx` + `191xx` | `emergency_contacts` | 200 | 已实装 |
| `200xx` + `201xx` | `activities` | 200 | 已实装 |
| `210xx` + `211xx` | `activity_registrations` | 200 | 已实装 |
| `220xx` + `221xx` | `attendances`(批次 3B + 批次 4-A) | 200 | 已实装 |
| `230xx` + `231xx` | `contribution_rules` | 200 | 已实装 |
| `240xx-290xx` | 未规划模块预留 | — | 未实装 |
| `300xx` + `301xx` | `permissions` / `rbac_roles` / `role_permissions` / `user_roles` / `rbac`(RBAC 主模块) | 200 | 已实装 |
| `310xx` 起 | 未规划模块预留 | — | 未实装 |

**前端识别规则**:看到 `code` 前两位即可定位是哪个模块的业务码;`4` / `5` 开头为通用 HTTP 段(详见 §3.1)。

### 3.3 子段语义(每模块 `XX001-XX199` 200 个号的内部细分)

沿 [`baseline §1.3`](srvf-foundation-baseline.md):

**`XX0xx` 段 — 实体级错误**

| 子段 | 用途 | 示例 |
|---|---|---|
| `XX001` | 资源不存在 | `ORGANIZATION_NOT_FOUND = 11001` |
| `XX002 ~ XX009` | 唯一约束冲突(逐字段一码,P2002 兜底) | `USERNAME_ALREADY_EXISTS = 10002` |
| `XX010 ~ XX029` | 业务级输入校验(超出 ValidationPipe 默认) | `ORGANIZATION_PARENT_CYCLE = 11012` |
| `XX030 ~ XX099` | 资源状态非法 / 引用约束 / 其他实体级 | `ORGANIZATION_HAS_CHILDREN = 11030` |

**`XX1xx` 段 — 权限 / 操作 / 完整性**

| 子段 | 用途 | 示例 |
|---|---|---|
| `XX101` | 通用权限拒绝 | `FORBIDDEN_AUDIT_LOG_READ = 14101` |
| `XX102` | 自我保护(操作目标 = 当前用户 / 当前实体) | `CANNOT_OPERATE_SELF = 10102` |
| `XX103 ~ XX119` | 系统约束保护(最后一个 SUPER_ADMIN / 最后一个根节点等) | `LAST_SUPER_ADMIN_PROTECTED = 10103` |
| `XX120 ~ XX199` | 操作冲突 / 跨实体完整性 | `ACTIVITY_NOT_PUBLIC_REGISTRATION = 20120` |

---

## 4. BizCode 全量翻译表

> 本节按段位顺序列出全部 **122 条** BizCode(2026-05-17 `main` HEAD `a240e0a` 实数)。
>
> 表列说明:
> - **code**:数值码,前端业务判断的**唯一权威字段**
> - **常量名**:后端 TypeScript 常量名,沿 [`baseline §6`](srvf-foundation-baseline.md) 命名规范
> - **后端 message**:`BizCode.message` 字段值,**直接照抄**自源码;**不等于** UI 展示文案
> - **HTTP**:`BizCode.httpStatus` 字段,以 NestJS `HttpStatus` 枚举数值表示
> - **触发场景**:从 `biz-code.constant.ts` 注释和模块语义提取;不清楚的标 ⚠️
> - **前端处理建议**:语义/分类提示,**不给文案字面**;前端按本地化策略自决
> - **阶段**:`起步` = 起步包接口可能撞 / `P1` = P1 后接接口可能撞 / `暂不接` = 第一版完全不接的接口才会撞(沿 [`frontend-scope.md §4-§6`](first-release-frontend-scope.md))

### 4.1 通用 HTTP 段(6 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 40000 | `BAD_REQUEST` | 请求参数错误 | 400 | ValidationPipe 字段校验失败 / forbidNonWhitelisted 命中未声明字段;message 透传字段错误列表(`; ` 拼接) | 表单红框 + 直接显示 message;若需逐字段定位,按 `; ` 切分 | 起步 |
| 40100 | `UNAUTHORIZED` | 未登录或登录已失效 | 401 | JwtStrategy 校验失败(token 无效 / 过期 / 用户被禁 / 已软删) | **跳登录页**;**不要**当成"账号密码错"(后者用 10004) | 起步 |
| 40300 | `FORBIDDEN` | 无权限访问 | 403 | Guard 拒绝(`@Roles` 不满足);业务模块层级权限不足 | 显示"无权限"提示;不需要重登录 | 起步 |
| 40400 | `NOT_FOUND` | 资源不存在 | 404 | 路径未匹配(NestJS 路由层);**资源类不存在**用模块自有 `XX001` | 通常是前端拼错 URL,提示"接口不存在"或回首页 | 起步 |
| 42900 | `TOO_MANY_REQUESTS` | 请求过于频繁，请稍后再试 | 429 | 登录接口限流命中(V1.1 IP 维度 5 次/60 秒) | 显示文案后**禁用提交按钮**一段时间;**不要**显示阈值或剩余次数(后端不暴露) | 起步 |
| 50000 | `INTERNAL_ERROR` | 服务器内部错误 | 500 | 未知异常 / 未匹配 HttpException 的非 4xx HTTP 错误 | 显示通用错误 + 引导用户报 `x-request-id`(见 §6.3) | 起步 |

### 4.2 `100xx + 101xx` users / auth(7 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 10001 | `USER_NOT_FOUND` | 用户不存在 | 404 | GET / PATCH / PUT / DELETE `/api/users/:id` 未命中或已软删(沿 v1 §10 信息泄漏防御) | 列表刷新 / 详情页提示"用户不存在" | 起步 |
| 10002 | `USERNAME_ALREADY_EXISTS` | username 已存在 | 409 | POST `/api/users` 时 username 撞唯一(含软删记录) | 表单红框提示 username 已被占用 | 起步 |
| 10003 | `EMAIL_ALREADY_EXISTS` | email 已存在 | 409 | POST / PATCH `/api/users` 时 email 撞唯一(含软删记录) | 表单红框提示 email 已被占用 | 起步 |
| 10004 | `LOGIN_FAILED` | 账号或密码错误 | 401 | POST `/api/auth/login` 四场景统一返(username 不存在 / password 错 / 已禁用 / 已软删,沿防账号枚举铁律) | 登录表单错误提示;**不要**区分账号与密码哪个错(后端故意不区分) | 起步 |
| 10101 | `FORBIDDEN_ROLE_OPERATION` | 无权对该用户执行此操作 | 403 | `assertCanManageUser` 拒绝(例:ADMIN 试图管理 ADMIN / SUPER_ADMIN) | 列表收起操作按钮 + 提示"无权限" | 起步 |
| 10102 | `CANNOT_OPERATE_SELF` | 不能对自己执行此操作 | 403 | DELETE / PATCH status / PATCH role 自操作 | 操作按钮置灰 + 提示"不能对自己执行" | P1 |
| 10103 | `LAST_SUPER_ADMIN_PROTECTED` | 系统必须保留至少一个活跃超级管理员 | 409 | DELETE / PATCH status DISABLED / PATCH role 降级 SUPER_ADMIN 时事务内 count < 1 | 提示"必须保留至少一个超级管理员",阻止操作 | P1 |

### 4.3 `110xx + 111xx` organizations(9 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 11001 | `ORGANIZATION_NOT_FOUND` | 组织节点不存在 | 404 | GET / PATCH / DELETE `/api/v2/organizations/:id` 未命中或已软删 | 列表刷新 / 详情提示节点不存在 | 起步 |
| 11010 | `ORGANIZATION_PARENT_NOT_FOUND` | 父级组织节点不存在 | 404 | POST 时 `parentId` 不存在 | 父节点选择器刷新 + 提示"父节点已不存在" | 起步 |
| 11011 | `ORGANIZATION_NODE_TYPE_INVALID` | 节点类别字典 code 不存在或已停用 | 400 | POST / PATCH 时 `nodeTypeCode` 不在 `node_type` 字典 ACTIVE 范围 | 节点类型下拉框刷新字典 | 起步 |
| 11012 | `ORGANIZATION_PARENT_CYCLE` | 组织节点父级形成环 | 400 | POST 时新节点 parent 链路形成环路 | 提示"组织结构存在循环引用",阻止保存 | 起步 |
| 11013 | `ORGANIZATION_PARENT_CHANGE_FORBIDDEN` | 不允许修改组织节点父级 | 400 | PATCH 时 DTO 透传 `parentId`(不允许改父级) | 表单不暴露父级编辑;若误传,提示"父级不可改" | 起步 |
| 11030 | `ORGANIZATION_HAS_CHILDREN` | 组织节点存在子节点,不能删除 | 409 | DELETE 时存在活跃子节点 | 提示"请先处理子节点" | P1 |
| 11031 | `ORGANIZATION_HAS_MEMBERS` | 组织节点存在成员归属,不能删除 | 409 | DELETE 时存在活跃 member_department 引用 | 提示"请先转移该节点下的成员" | P1 |
| 11032 | `ORGANIZATION_ROOT_ALREADY_EXISTS` | 系统已存在活跃根节点 | 409 | POST 根节点(`parentId=null`)且系统已有活跃根节点(单根上限) | 提示"已存在根节点,不可再建根" | 起步 |
| 11103 | `LAST_ROOT_ORGANIZATION_PROTECTED` | 系统必须保留至少一个活跃根节点 | 409 | DELETE / PATCH status 把最后一个活跃根节点改 INACTIVE / 软删 | 提示"必须保留至少一个根节点",阻止操作 | P1 |

### 4.4 `120xx + 121xx` dictionaries(9 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 12001 | `DICT_TYPE_NOT_FOUND` | 字典类型不存在 | 404 | GET / PATCH / DELETE `/api/v2/dict-types/:id`(或 GET items 时 `dictTypeCode` 不存在)未命中 | 字典 type 列表刷新 + 提示"字典类型已不存在" | 起步 |
| 12002 | `DICT_TYPE_CODE_ALREADY_EXISTS` | 字典类型 code 已存在 | 409 | POST `/api/v2/dict-types` 时 `code` 撞唯一(含软删) | 表单红框 + 提示 code 已占用 | P1 |
| 12010 | `DICT_ITEM_NOT_FOUND` | 字典项不存在 | 404 | GET / PATCH / DELETE 字典项未命中 | 字典项列表刷新 + 提示"字典项已不存在" | 起步 |
| 12011 | `DICT_ITEM_CODE_ALREADY_EXISTS` | 同类型下字典项 code 已存在 | 409 | POST item 时同类型下 `code` 撞唯一 | 表单红框提示 code 在该类型下已占用 | P1 |
| 12012 | `DICT_ITEM_PARENT_TYPE_MISMATCH` | 字典项父级跨类型 | 400 | POST / PATCH item 时 `parentId` 所属 type 与当前 type 不同 | 父级选择器仅展示同类型节点 | P1 |
| 12013 | `DICT_ITEM_PARENT_CYCLE` | 字典项父级形成环 | 400 | POST / PATCH item 时父级链路形成环 | 提示"父级存在循环引用" | P1 |
| 12014 | `DICT_ITEM_PARENT_IMMUTABLE` | 字典项父级不允许修改 | 400 | PATCH item 时 DTO 透传 `parentId`(沿组织节点设计) | 表单不暴露父级编辑 | P1 |
| 12030 | `DICT_TYPE_IN_USE` | 字典类型仍有项目引用,不能删除 | 409 | DELETE dict_type 时仍有活跃 dict_item | 提示"请先删除该类型下的字典项" | P1 |
| 12031 | `DICT_ITEM_IN_USE` | 字典项仍被业务表引用,不能删除 | 409 | DELETE dict_item 时仍被业务表(members / activities 等)引用 | 提示"该字典项仍在使用,无法删除" | P1 |

### 4.5 `130xx + 131xx` attachments(15 条)

#### 4.5.1 主模块(6 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 13001 | `ATTACHMENT_NOT_FOUND` | 附件不存在 | 404 | GET / PATCH / DELETE `/api/v2/attachments/:id` 未命中、已软删、或 USER 越权访问(沿信息泄漏防御统一返 NOT_FOUND) | 列表刷新 / 提示"附件不存在或无权访问" | 起步 |
| 13010 | `ATTACHMENT_OWNER_TYPE_INVALID` | 附件归属类型不合法 | 400 | POST upload-url / POST attachments 时 `ownerType` 不在 `attachment_type_configs.code` 白名单 | 业务场景 → ownerType 映射应由前端编码时确定;若动态推断,提示"上传场景不支持" | 起步 |
| 13011 | `ATTACHMENT_OWNER_NOT_FOUND` | 附件归属对象不存在或已软删 | 400 | POST upload-url / POST attachments 时 `ownerId` 对应业务对象不存在或已软删 | 通常是前端拿了过期的 ownerId;刷新业务对象后重试 | 起步 |
| 13012 | `ATTACHMENT_MIME_NOT_ALLOWED` | 附件 MIME 类型不在白名单 | 400 | upload-url 时 `mime` 不在 `attachment_mime_configs` 当前 ownerType 白名单 | 提示"该业务不允许此类型文件"(避免与系统级黑名单 13033 混淆,见 §5) | 起步 |
| 13013 | `ATTACHMENT_SIZE_EXCEEDED` | 附件大小超过上限 | 400 | upload-url 时 `size` 超过 `attachment_size_limit_configs` 当前 ownerType 上限 | 提示"文件超过上限",可在前端预先校验避免后端拒绝 | 起步 |
| 13015 | `ATTACHMENT_PII_DETECTED` | 附件元数据包含个人敏感信息(身份证号),已拒绝 | 400 | upload-url 时元数据(filename / 描述等)正则命中身份证号 | 提示"文件名含身份证号,请重命名后重传" | 起步 |

#### 4.5.2 配置三表(8 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 13020 | `ATTACHMENT_TYPE_CONFIG_NOT_FOUND` | 附件类型配置不存在 | 404 | GET / PATCH / DELETE `/api/v2/attachment-type-configs/:id` 未命中(或 mime / size 配置以 typeConfigId 关联未命中,沿信息泄漏防御复用) | 列表刷新 | 暂不接 |
| 13021 | `ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS` | 附件类型配置 code 已存在 | 409 | POST type config 时 `code` 撞唯一 | 表单红框 | 暂不接 |
| 13022 | `ATTACHMENT_MIME_CONFIG_NOT_FOUND` | 附件 MIME 配置不存在 | 404 | GET / PATCH / DELETE mime config 未命中 | 列表刷新 | 暂不接 |
| 13023 | `INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT` | 附件类型配置 code 格式不合法 | 400 | POST / PATCH type config 时 `code` 不符合命名正则 | 表单红框提示格式要求 | 暂不接 |
| 13024 | `ATTACHMENT_MIME_CONFIG_DUPLICATE` | 该附件类型下 MIME 已存在 | 409 | POST mime config 时 `(typeConfigId, mime)` 撞唯一 | 表单红框 | 暂不接 |
| 13025 | `INVALID_ATTACHMENT_MIME_FORMAT` | 附件 MIME 格式不合法 | 400 | POST / PATCH mime config 时 `mime` 不符合 `<type>/<subtype>` 格式 | 表单红框提示格式要求 | 暂不接 |
| 13026 | `ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND` | 附件尺寸限制配置不存在 | 404 | GET / PATCH / DELETE size limit config 未命中 | 列表刷新 | 暂不接 |
| 13027 | `ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS` | 该附件类型已有尺寸限制配置 | 409 | POST size limit config 时同 `typeConfigId` 已有配置(1:1 关系) | 表单提示"该类型已有上限配置,请直接编辑" | 暂不接 |

#### 4.5.3 跨表 IN_USE(3 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 13030 | `ATTACHMENT_TYPE_IN_USE` | 附件类型仍被附件引用,无法删除或停用 | 409 | DELETE / PATCH status INACTIVE type config 时存在活跃 attachment 引用 | 提示"该类型下仍有附件,请先处理" | 暂不接 |
| 13031 | `ATTACHMENT_MIME_CONFIG_IN_USE` | 附件 MIME 配置仍被附件引用,无法删除或停用 | 409 | DELETE / PATCH status INACTIVE mime config 时存在活跃 attachment 引用 | 同上 | 暂不接 |
| 13032 | `ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE` | 附件尺寸限制配置仍被附件引用,无法删除 | 409 | DELETE size limit config 时存在活跃 attachment 引用 | 同上 | 暂不接 |

#### 4.5.4 系统级 MIME 黑名单(1 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 13033 | `ATTACHMENT_SYSTEM_MIME_BLOCKED` | 附件 MIME 类型在系统级黑名单中,不允许上传 | 400 | upload-url / POST attachments 时 `mime` 命中 `SYSTEM_MIME_BLOCKLIST`(应用层硬编码,永久禁) | 提示"该文件类型系统级禁止上传"(与 13012"白名单未命中"是不同语义,前端应当区分) | 起步 |

### 4.6 `140xx + 141xx` audit_logs(2 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 14001 | `AUDIT_LOG_NOT_FOUND` | 审计记录不存在 | 404 | GET `/api/v2/audit-logs/:id` 未命中 | 列表刷新 | 暂不接 |
| 14101 | `FORBIDDEN_AUDIT_LOG_READ` | 无权查看该审计记录 | 403 | ADMIN 访问 SUPER_ADMIN 写入的审计 detail(已通过 Guard、但 detail 越级) | 列表过滤 SUPER_ADMIN 记录 + 详情页提示无权 | 暂不接 |

### 4.7 `150xx + 151xx` members(5 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 15001 | `MEMBER_NOT_FOUND` | 队员不存在 | 404 | GET / PATCH / DELETE `/api/v2/members/:id` 未命中、已软删 | 列表刷新 / 详情页提示 | 起步 |
| 15002 | `MEMBER_NO_ALREADY_EXISTS` | 队员编号已存在 | 409 | POST members 时 `memberNo` 撞唯一(含软删历史,全局不复用) | 表单红框 + 提示编号已被占用(包含历史,不复用) | 起步 |
| 15010 | `MEMBER_GRADE_CODE_INVALID` | 队员等级字典 code 不存在或已停用 | 400 | POST / PATCH 时 `gradeCode` 不在 `member_grade` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 15030 | `MEMBER_HAS_ACTIVE_DEPARTMENT` | 队员仍有部门归属,不能删除 | 409 | DELETE member 时存在活跃 member_department | 提示"请先解除部门归属" | P1 |
| 15031 | `MEMBER_HAS_LINKED_USER` | 队员已被 user 绑定,不能删除 | 409 | DELETE member 时存在 `users.memberId` 引用 | 提示"请先解除 user 绑定" | P1 |

### 4.8 `160xx + 161xx` member_profiles(7 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 16001 | `MEMBER_PROFILE_NOT_FOUND` | 队员档案不存在 | 404 | GET / PATCH `/api/v2/members/:memberId/profile` 1:1 子资源未建立 | 详情页提示"档案未建立,请先创建" | 起步 |
| 16002 | `MEMBER_PROFILE_ALREADY_EXISTS` | 队员档案已存在 | 409 | POST 时该 member 已有 profile(1:1 约束) | 跳转到编辑路径而非创建 | 起步 |
| 16010 | `MEMBER_PROFILE_GENDER_CODE_INVALID` | 性别字典 code 不存在或已停用 | 400 | POST / PATCH `genderCode` 不在 `gender` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 16011 | `MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID` | 证件类型字典 code 不存在或已停用 | 400 | POST / PATCH `documentTypeCode` 不在 `document_type` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 16012 | `MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID` | 政治面貌字典 code 不存在或已停用 | 400 | POST / PATCH `politicalStatusCode` 不在 `political_status` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 16013 | `MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID` | 血型字典 code 不存在或已停用 | 400 | POST / PATCH `bloodTypeCode` 不在 `blood_type` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 16014 | `MEMBER_PROFILE_WORK_NATURE_CODE_INVALID` | 工作性质字典 code 不存在或已停用 | 400 | POST / PATCH `workNatureCode` 不在 `work_nature` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |

### 4.9 `170xx + 171xx` member_departments(4 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 17001 | `MEMBER_DEPARTMENT_NOT_FOUND` | 队员当前无部门归属 | 404 | GET `/api/v2/members/:memberId/department` 时该 member 无活跃归属 | 详情页提示"未归属部门" + 提供"设置部门"入口 | 起步 |
| 17002 | `MEMBER_DEPARTMENT_ALREADY_EXISTS` | 队员已有活跃部门归属 | 409 | PUT department 并发兜底 partial unique 撞(一人一部门) | 重新拉取最新归属再决定是否覆盖 | 起步 |
| 17030 | `MEMBER_INACTIVE` | 队员状态非活跃,不能挂部门 | 409 | PUT department 时 member.status != ACTIVE | 提示"该队员已停用,无法分配部门" | 起步 |
| 17031 | `ORGANIZATION_INACTIVE` | 组织节点状态非活跃,不能挂队员 | 409 | PUT department 时目标 organization.status != ACTIVE | 提示"目标部门已停用" + 刷新组织树 | 起步 |

### 4.10 `180xx + 181xx` certificates(5 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 18001 | `CERTIFICATE_NOT_FOUND` | 证书不存在 | 404 | GET / PATCH `/api/v2/members/:memberId/certificates/:id` 未命中、已软删 | 列表刷新 | 起步 |
| 18010 | `CERTIFICATE_TYPE_CODE_INVALID` | 证书大类字典 code 不存在或已停用 | 400 | POST / PATCH `certTypeCode` 不在 `cert_type` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 18011 | `CERTIFICATE_SUB_TYPE_CODE_INVALID` | 证书子类型字典 code 不存在或已停用 | 400 | POST / PATCH `certSubTypeCode` 不在 `cert_sub_type` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 18030 | `CERTIFICATE_INVALID_STATE_TRANSITION` | 证书状态不允许此操作 | 409 | verify / reject / 改某些字段时状态机不允许(例:expired 证书走 verify) | 按钮置灰 + 提示"当前状态不允许此操作" | P1 |
| 18101 | `CERTIFICATE_NOT_BELONGS_TO_MEMBER` | 证书不属于该队员 | 403 | URL `:memberId` 与证书实际 `memberId` 不一致 | 通常是前端拼错;刷新到正确路径 | 起步 |

### 4.11 `190xx + 191xx` emergency_contacts(3 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 19001 | `EMERGENCY_CONTACT_NOT_FOUND` | 紧急联系人不存在 | 404 | GET / PATCH / DELETE 未命中、已软删 | 列表刷新 | 起步 |
| 19010 | `EMERGENCY_CONTACT_RELATION_CODE_INVALID` | 紧急联系人关系字典 code 不存在或已停用 | 400 | POST / PATCH `relationCode` 不在 `emergency_relation` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 19101 | `EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER` | 紧急联系人不属于该队员 | 403 | URL `:memberId` 与紧急联系人实际 `memberId` 不一致 | 通常是前端拼错;刷新到正确路径 | 起步 |

### 4.12 `200xx + 201xx` activities(10 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 20001 | `ACTIVITY_NOT_FOUND` | 活动不存在 | 404 | GET / PATCH 等未命中、已软删 | 列表刷新 | 起步 |
| 20011 | `ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN` | 活动不允许挂在组织根节点 | 400 | POST / PATCH 时 `organizationId` 指向根节点 | 组织选择器只展示非根节点 | 起步 |
| 20012 | `ACTIVITY_TYPE_CODE_INVALID` | 活动类型字典 code 不存在或已停用 | 400 | POST / PATCH `activityTypeCode` 不在 `activity_type` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 20013 | `ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID` | 活动性别要求字典 code 不存在或已停用 | 400 | POST / PATCH `genderRequirementCode` 不在 `gender_requirement` 字典 ACTIVE 范围 | 字典下拉框刷新 | 起步 |
| 20014 | `ACTIVITY_CAPACITY_INVALID` | 活动名额配置无效 | 400 | POST / PATCH 时 capacity 组合非法(例:min > max) | 表单前端可预校验 | 起步 |
| 20015 | `ACTIVITY_START_END_INVALID` | 活动起止时间无效(startAt 必须早于 endAt) | 400 | POST / PATCH 时 `startAt >= endAt` | 时间选择器前端预校验 | 起步 |
| 20030 | `ACTIVITY_STATUS_INVALID` | 活动当前状态不允许此操作 | 409 | PATCH publish / cancel 等状态机非法转移 | 按钮按状态置灰 + 提示原因 | 起步 |
| 20120 | `ACTIVITY_NOT_PUBLIC_REGISTRATION` | 活动未开放报名 | 409 | POST 报名时活动未发布 / 已结束 | 报名按钮按活动状态置灰 | 起步 |
| 20121 | `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN` | 活动已取消,禁止报名 | 409 | POST 报名时活动 status=cancelled | 报名按钮按活动状态置灰 | P1 |
| 20122 | `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` | 活动已取消,禁止录入考勤 | 409 | POST 考勤单时活动 status=cancelled | 考勤入口按活动状态置灰 | P1 |

### 4.13 `210xx + 211xx` activity_registrations(4 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 21001 | `ACTIVITY_REGISTRATION_NOT_FOUND` | 报名记录不存在 | 404 | GET / PATCH 未命中、已软删、或 USER 越权访问他人报名(沿信息泄漏防御统一返 NOT_FOUND) | 列表刷新 / 提示"报名不存在或无权访问" | 起步 |
| 21002 | `ACTIVITY_REGISTRATION_ALREADY_EXISTS` | 同一活动同一队员已有有效报名 | 409 | POST 报名时同活动同 member 已有 active 报名(partial unique 撞) | 提示"已报名,无需重复" | 起步 |
| 21030 | `ACTIVITY_REGISTRATION_STATUS_INVALID` | 报名记录当前状态不允许此操作 | 409 | PATCH approve / reject / cancel 状态机非法转移 | 按钮按状态置灰 | 起步 |
| 21032 | `ACTIVITY_CAPACITY_EXCEEDED` | 活动名额已满 | 409 | approve 报名时活动当前已通过数量 >= max | 提示"名额已满"+ 阻止 approve | 起步 |

### 4.14 `220xx + 221xx` attendances(15 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 22001 | `ATTENDANCE_SHEET_NOT_FOUND` | 考勤单据不存在 | 404 | GET / PATCH / DELETE 未命中、已软删、或 USER 越权(沿信息泄漏防御统一返) | 列表刷新 | 起步 |
| 22030 | `ATTENDANCE_SHEET_STATUS_INVALID` | 考勤单据当前状态不允许此操作 | 409 | PATCH 审核 / 终审 / 编辑 等状态机非法转移 | 按钮按状态置灰 | P1 |
| 22040 | `ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE` | 已审核通过的考勤单据不可修改 | 409 | PATCH 编辑或 DELETE 已审核通过的 sheet | 编辑入口按状态置灰 + 提示原因 | P1 |
| 22041 | `ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE` | 已驳回的考勤单据不可直接编辑 | 409 | PATCH 编辑已驳回的 sheet(需先打回到 draft) | 提示"驳回单不可直接编辑,请先重置为草稿" | P1 |
| 22043 | `ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE` | 终审驳回的考勤单据不可修改 | 409 | PATCH 编辑终审驳回的 sheet | 同上 | P1 |
| 22045 | `ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID` | 考勤单据当前状态不允许终审操作 | 409 | PATCH final-approve / final-reject 时 sheet 不在 pending_final_review 状态 | 按钮按状态置灰 | P1 |
| 22046 | `ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED` | 终审驳回须填写终审备注 | 409 | PATCH final-reject 时 `finalReviewNote` 缺失或为空 | 终审驳回弹框强制填备注 | P1 |
| 22051 | `ATTENDANCE_ROLE_CODE_INVALID` | 考勤角色字典 code 不存在或已停用 | 400 | POST / PATCH attendance record 时 `attendanceRoleCode` 不在 `attendance_role` 字典 ACTIVE 范围 | 字典下拉框刷新 | P1 |
| 22052 | `ATTENDANCE_STATUS_CODE_INVALID` | 考勤明细状态字典 code 不存在或已停用 | 400 | POST / PATCH attendance record 时 `attendanceStatusCode` 不在 `attendance_status` 字典 ACTIVE 范围 | 字典下拉框刷新 | P1 |
| 22060 | `ATTENDANCE_TIME_OVERLAP` | 出勤时间段与已有记录重叠 | 409 | POST / PATCH attendance record 时同 member 时间区间与已有 record 重叠 | 时间选择器前端预校验 + 弹出冲突明细 | P1 |
| 22061 | `CHECK_OUT_BEFORE_CHECK_IN` | 签退时间须晚于签到时间 | 400 | POST / PATCH attendance record 时 `checkOutAt <= checkInAt` | 时间选择器前端预校验 | P1 |
| 22070 | `ATTENDANCE_SERVICE_HOURS_INVALID` | 服务时长须大于 0 | 400 | POST / PATCH attendance record 时 `serviceHours <= 0` | 数值输入前端预校验 | P1 |
| 22071 | `ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN` | 服务时长不可超过签到签退跨度 | 400 | POST / PATCH attendance record 时 `serviceHours > (checkOutAt - checkInAt)` | 数值输入前端预校验,可按跨度自动填默认 | P1 |
| 22072 | `ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED` | 审核前须为所有出勤记录填写贡献值 | 409 | PATCH approve sheet 时存在 record `contributionPoints == null` | 审核按钮置灰 + 提示"请先补齐贡献值" | P1 |
| 22073 | `ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH` | 关联报名记录与考勤活动不一致 | 400 | POST / PATCH attendance record 时 `registrationId` 对应报名的活动与考勤 sheet 活动不一致 | 通常前端逻辑错;阻止保存 | P1 |

### 4.15 `230xx + 231xx` contribution_rules(5 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 23001 | `CONTRIBUTION_RULE_NOT_FOUND` | 贡献值规则不存在 | 404 | GET / PATCH / DELETE 未命中、已软删 | 列表刷新 | 暂不接 |
| 23002 | `CONTRIBUTION_RULE_ACTIVE_DUPLICATE` | 该维度已存在生效中的规则 | 409 | POST / PATCH 时 `(activityTypeCode, attendanceRoleCode, durationThreshold)` 撞 ACTIVE 维度唯一 | 表单红框 | 暂不接 |
| 23010 | `CONTRIBUTION_RULE_POINTS_INVALID` | 分值字段组合非法 | 400 | POST / PATCH 时分值字段组合不符合业务规则 | 表单前端预校验 | 暂不接 |
| 23011 | `CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID` | 活动类型字典 code 不存在或已停用 | 400 | POST / PATCH 时 `activityTypeCode` 不在字典 ACTIVE 范围 | 字典下拉框刷新 | 暂不接 |
| 23012 | `CONTRIBUTION_RULE_ROLE_CODE_INVALID` | 考勤角色字典 code 不存在或已停用 | 400 | POST / PATCH 时 `attendanceRoleCode` 不在字典 ACTIVE 范围 | 字典下拉框刷新 | 暂不接 |

### 4.16 `300xx + 301xx` RBAC(13 条)

#### 4.16.1 permissions(3 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 30001 | `PERMISSION_NOT_FOUND` | 权限点不存在 | 404 | GET / PATCH / DELETE permission 未命中 | 列表刷新 | 暂不接 |
| 30002 | `PERMISSION_CODE_ALREADY_EXISTS` | 权限点 code 已存在 | 409 | POST permission 时 `code` 撞唯一 | 表单红框 | 暂不接 |
| 30008 | `INVALID_PERMISSION_CODE_FORMAT` | 权限点 code 格式不合法 | 400 | POST / PATCH permission 时 `code` 不符合命名正则(service 层显式校验) | 表单红框提示格式要求 | 暂不接 |

#### 4.16.2 rbac_roles(4 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 30003 | `ROLE_NOT_FOUND` | 角色不存在 | 404 | GET role 完全不存在;PATCH / DELETE 角色不存在或已软删(沿 v1 §10 信息泄漏防御) | 列表刷新 | 暂不接 |
| 30004 | `ROLE_CODE_ALREADY_EXISTS` | 角色 code 已存在 | 409 | POST role 时 `code` 撞唯一(含软删历史) | 表单红框 | 暂不接 |
| 30005 | `ROLE_DELETED` | 角色已删除 | 410 | GET role/:id 命中已软删记录(detail 精确告知"曾在已删") | 提示"角色已删除,请重新创建" | 暂不接 |
| 30009 | `INVALID_ROLE_CODE_FORMAT` | 角色 code 格式不合法 | 400 | POST / PATCH role 时 `code` 不符合命名正则(service 层显式校验) | 表单红框提示格式要求 | 暂不接 |

#### 4.16.3 role_permissions / user_roles / RBAC 拒绝(6 条)

| code | 常量名 | 后端 message | HTTP | 触发场景 | 前端处理建议 | 阶段 |
|---|---|---|---|---|---|---|
| 30006 | `USER_ROLE_ALREADY_EXISTS` | 该用户已持有此角色 | 409 | POST user_role 时 `(userId, roleId)` 撞唯一(单角色分配报错,非幂等) | 提示"已持有",不重复分配 | 暂不接 |
| 30007 | `USER_ROLE_NOT_FOUND` | 该用户未持有此角色 | 404 | DELETE user_role 时 `(userId, roleId)` 关系不存在 | 列表刷新 | 暂不接 |
| 30011 | `ROLE_PERMISSION_NOT_FOUND` | 角色未持有此权限点 | 404 | DELETE role_permission 时关系不存在(POST 幂等成功,不返此码) | 列表刷新 | 暂不接 |
| 30100 | `RBAC_FORBIDDEN` | 无权执行此操作 | 403 | Service 层调用 `RbacService.can()` 返 false,调用方抛此码(业务级 RBAC 拒绝;当前仅 attachments 模块接入) | 显示"无权限"提示 | 暂不接 |
| 30101 | `LAST_OPS_ADMIN_PROTECTED` | 系统必须保留至少一个活跃运营管理员 | 409 | DELETE user_role 撤销 ops-admin 时事务内 count < 1 | 提示"必须保留至少一个运营管理员",阻止操作 | 暂不接 |
| 30102 | `CANNOT_ASSIGN_HIGHER_ROLE` | 无权分配或撤销该角色 | 403 | actor(非 SUPER_ADMIN / 非 ops-admin)试图分配 / 撤销 ops-admin 角色(Q7 角色分级 C2 中庸方案) | 列表收起按钮 + 提示"无权操作此角色" | 暂不接 |

---

## 5. 前端必须懂的后端模式

### 5.1 401 两阶段:`LOGIN_FAILED` 10004 vs `UNAUTHORIZED` 40100

两者 HTTP status 都是 401,但语义完全不同:

| 阶段 | 触发位置 | code | message | 前端动作 |
|---|---|---|---|---|
| 登录阶段 | POST `/api/auth/login` 校验 `username + password` 失败 | `10004 LOGIN_FAILED` | 账号或密码错误 | **登录表单内**提示,不跳页;不要清空 username |
| 已登录请求 | 任意已登录请求,`JwtStrategy.validate()` token / 用户状态失败 | `40100 UNAUTHORIZED` | 未登录或登录已失效 | **跳登录页**;清掉本地 token |

**铁律**:前端**必须**按 `code` 字段区分,**不要**按 HTTP status 区分。否则:

- 管理员重置密码后旧 token 失效 → 后端返 `40100`(登录已失效);若前端按 HTTP 401 当成"账号密码错",会停在错误页让用户输入旧密码反复重试
- 用户被禁用 → 后端返 `40100`(用户被禁);若前端误判为登录表单错,同上

### 5.2 防账号枚举:登录失败四场景统一返

POST `/api/auth/login` 在以下**四种**失败场景下,响应**完全相同**(`10004` + HTTP 401 + 相同 message + 相同响应耗时):

1. `username` 不存在(走 bcrypt.compare 抹平 timing)
2. `password` 错误
3. 账号已禁用(`status=DISABLED`)
4. 账号已软删除(`deletedAt != null`)

**前端做不到**(也**不应当做**)区分这四种场景:

- 任何"区分账号 vs 密码错"的 UI 文案都违反防账号枚举原则
- 任何"账号不存在请联系管理员"的提示都泄露了账号枚举信息
- 统一提示"账号或密码错误,请检查后重试"即可

### 5.3 信息泄漏防御:越权可能返回 NOT_FOUND

按 [`CLAUDE.md §10`](../CLAUDE.md) 信息泄漏防御铁律,以下场景**故意返回 `XX001 NOT_FOUND`(404)而非 `403 FORBIDDEN`**:

- 访问已软删用户的详情 / 修改 / 重置密码等接口 → `10001 USER_NOT_FOUND`
- USER 越权访问他人的报名记录 → `21001 ACTIVITY_REGISTRATION_NOT_FOUND`
- USER 越权访问他人的考勤单据 → `22001 ATTENDANCE_SHEET_NOT_FOUND`
- USER 越权访问他人的附件 detail / update / delete → `13001 ATTACHMENT_NOT_FOUND`
- 角色 detail / update / delete 不存在或已软删 → `30003 ROLE_NOT_FOUND`(显式存在的软删则返 `30005 ROLE_DELETED`,**仅** GET role/:id 路径)

**前端理解要点**:

- **看到 `XX001` 不一定真的"不存在"**;可能是越权;前端不应当试图区分这两种情况
- 不要按"先查存在,再查权限"的两步交互;一次请求拿到 `XX001` 就直接当"不存在或无权访问"处理
- 列表页通常已经按权限过滤,详情页拿到 `XX001` 多半是 URL 拼错或外部链接过期;直接列表刷新即可

### 5.4 唯一约束:P2002 → `ALREADY_EXISTS` 系列

后端在 service 层显式捕获 Prisma `P2002` 错误,根据 `error.meta?.target` 数组判定具体字段,转为对应 BizCode:

- `username` 撞 → `10002 USERNAME_ALREADY_EXISTS`
- `email` 撞 → `10003 EMAIL_ALREADY_EXISTS`
- `memberNo` 撞 → `15002 MEMBER_NO_ALREADY_EXISTS`
- `(activityId, memberId)` partial unique 撞 → `21002 ACTIVITY_REGISTRATION_ALREADY_EXISTS`
- `(memberId, status=ACTIVE)` partial unique 撞 → `17002 MEMBER_DEPARTMENT_ALREADY_EXISTS`
- 等等(见 §4 各模块 `XX002-XX009` 子段)

**前端处理要点**:

- 拿到 `XX002-XX009` 的码,**通常对应表单内某字段红框**;前端可以按 code → 字段映射做精准提示
- **不要**按通用 `409` 兜底显示,会丢失字段信息

### 5.5 字典字段非法:字段级 BizCode vs 通用 40000

后端对**字典字段引用**的非法值不使用通用 `40000`,而是**每字段一码**(沿 baseline §1.3 `XX010-XX029` 子段):

- 例如 `member_profiles` 6 个字典字段就有 6 个独立码(16010-16014)
- 例如 `activities` 3 个字典字段就有 3 个独立码(20012-20013)

**前端处理要点**:

- 拿到这类码意味着**该字段的字典值已不在 ACTIVE 范围**(可能是字典 item 被停用、被软删,或前端使用了过期的字典 code)
- 处理方式:**刷新该字段对应的字典(`GET /api/v2/dict-items?dictTypeCode=...`),让用户重选**
- 不要按通用 `40000` 兜底显示,会让用户不知道哪个字段错

### 5.6 软删除体感

- **列表 / 详情查询默认不返回已软删记录**(沿 [`CLAUDE.md §10`](../CLAUDE.md));前端**看不见**软删数据
- **DELETE 操作走软删**,不物理删除;**前端不需要二次确认"是否永久删除"**(后端无此能力)
- **`username` / `email` / `memberNo` 软删后不复用**;前端创建用户撞 `XX002 ALREADY_EXISTS` 时,即使列表里"看不到该账号",也不能让用户复用旧 code
- v1 不提供 restore 接口(沿 [`security.md`](security.md));误删需联系数据库管理员

### 5.7 限流 42900

POST `/api/auth/login` 配置 IP 维度限流(V1.1 默认 5 次 / 60 秒,可配置);超限响应 `42900` + HTTP 429:

- 后端**不返回** `Retry-After` 头(沿 [`CLAUDE.md §17.7`](../CLAUDE.md))
- 后端**不暴露**阈值数字 / 剩余配额 / 重置时间(message 故意只说"请求过于频繁,请稍后再试")
- **前端处理**:命中后禁用登录按钮一段时间(前端自定,例:30 秒);倒计时不要展示"X 秒后可重试"(后端不暴露重置时间,前端写死的倒计时可能与后端不同步)

### 5.8 500 / requestId 引导

未知异常 → `50000 INTERNAL_ERROR` + HTTP 500;生产环境**不**暴露 `error.message`:

- 后端日志条目有 `reqId`(由 `nestjs-pino` 自动注入,沿 [`baseline §7.6`](srvf-foundation-baseline.md))
- 响应 header 有 `x-request-id`(同一值)
- **前端处理**:遇到 500 时,提示"系统错误,请稍后重试"+ **附上 `x-request-id`**(让用户截图反馈,运维可凭此 reqId 在日志中精确定位)

---

## 6. 前端兜底策略

### 6.1 未列出的 code 怎么办

理论上不应该出现 §4 未列出的 code(已覆盖 122 条全部);但仍有几种边界场景:

- **后端新增了 BizCode 但本文未同步**:前端兜底显示 `message`(后端权威)即可;同时反馈给后端维护者
- **第三方 / 反向代理返回的 5xx**:HTTP status 是 5xx 但响应体不是 `{ code, message, data }`(例:Nginx 502)→ 前端按 HTTP status 兜底显示
- **网络层错误 / 浏览器 abort**:没有响应体 → 前端按"网络异常"兜底,不要尝试解析 BizCode

### 6.2 message 是否直接展示

后端 `message` 是**语义权威**,但**不是** UI 文案:

- **可以直接展示的**:大部分业务码 message 文案够清晰(例:"账号或密码错误" / "组织节点存在子节点,不能删除"),前端无定制需求时直接显示即可
- **建议前端重写文案的场景**:
  - `40000` 的 message 是 ValidationPipe 输出(`; ` 拼接的字段错误列表),展示不友好;前端应当按字段红框展示
  - `50000` 生产环境 message 是 `"服务器内部错误"`,前端应当补充 `requestId` 引导(见 §5.8)
  - `42900` message 不暴露阈值,前端应当补充倒计时(见 §5.7)
  - `13015 ATTACHMENT_PII_DETECTED` 文案有些技术化,前端可重写为"文件名含身份证号,请重命名"
- **不要在前端重写的场景**:`10004 LOGIN_FAILED` 故意模糊,前端**不要**重写为"账号不存在"或"密码错误"(违反防账号枚举铁律)

### 6.3 requestId 透出位置

每个响应(成功 / 失败 / 包装 / 不包装)header 都有 `x-request-id`,由 `nestjs-pino` 在请求处理链路开始时注入:

- **成功响应**:前端通常**不需要**透出
- **失败响应**(尤其 500):前端**应当**在错误提示 UI 中显示 `requestId`,便于用户反馈给运维
- **运维定位**:运维侧用 `requestId` 在日志中 `grep` 即可拿到完整请求 trace(method / url / status / duration / userId 等)

---

## 7. 最小 HTTP 示例

> 仅给最小响应体示例;**完整字段以 Swagger `/api/docs-json` / `/api/docs-yaml` + 对应 controller 的 DTO 定义为准**。

### 7.1 成功响应(POST 登录)

```
HTTP/1.1 201 Created
content-type: application/json; charset=utf-8
x-request-id: <opaque-cuid>

{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "<jwt>",
    "user": { ... }
  }
}
```

> 完整 `data` 字段以 [`auth.dto.ts`](../src/modules/auth/auth.dto.ts) + Swagger 为准。

### 7.2 失败响应(登录失败)

```
HTTP/1.1 401 Unauthorized
content-type: application/json; charset=utf-8
x-request-id: <opaque-cuid>

{
  "code": 10004,
  "message": "账号或密码错误",
  "data": null
}
```

> 失败响应**始终** `data: null`,无论是哪种 BizException / HttpException / 未知异常。前端**不应**尝试在 `data` 中解析任何字段。

---

## 8. 第一版前端联调包齐备勾选

本文产出后,[`first-release-frontend-scope.md §11`](first-release-frontend-scope.md) 的 P0-G 一项可置 `[x]`:

- [x] **P0-A 起步包**:[`first-release-frontend-scope.md`](first-release-frontend-scope.md) 已落地(2026-05-16)
- [x] **P0-G** BizCode 完整翻译表(本文档,2026-05-17)
- [ ] **P0-C** bootstrap SOP — 字典 `dict_type` seed 清单与 item 真实内容(14 个 type)
- [ ] **P0-C** bootstrap SOP — 测试账号矩阵实际创建(≥ 3 个账号)
- [ ] **P0-B** 上传下载闭环验收(真实 Storage Provider 上 5 步流程跑通)

前 2 项齐备(本文档归口);后 3 项待 P0-C / P0-B 立项。**齐备前**前端可对照本文做 BizCode → 错误处理路径 review 与本地 mock 联调,**但不大规模铺设业务接入**。

---

## 附录:本文不承载

| 类型 | 权威源 |
|---|---|
| 接口字段 / OpenAPI / DTO schema | [`v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 数据模型 / 字段约束 | [`prisma/schema.prisma`](../prisma/schema.prisma) + [`v2-data-model.md`](v2-data-model.md) |
| BizCode 实地源码 | [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) |
| BizCode 段位 / 命名规范 | [`baseline §1`](srvf-foundation-baseline.md) / [`§6`](srvf-foundation-baseline.md) |
| 响应包装与异常过滤实现 | [`src/common/interceptors/response.interceptor.ts`](../src/common/interceptors/response.interceptor.ts) + [`src/common/filters/all-exceptions.filter.ts`](../src/common/filters/all-exceptions.filter.ts) |
| 字典 item 真实取值 | P0-C bootstrap SOP(待立项)+ 运维侧 seed |
| 测试账号真实凭据 | P0-C bootstrap SOP(待立项;凭据**不进仓库**) |
| 上传 / 下载 sequence 图 | [`first-release-frontend-scope.md §7`](first-release-frontend-scope.md) |
| 安全策略 / refresh token / logout | [`docs/security.md`](security.md) + P0-D / P0-E 评审 |
| UI 文案字面 | 前端按设计稿决定;后端不规定 |
| 错误处理代码示例 | 前端按所选框架决定;后端不规定 |

冲突时按本文开头冲突优先级处理;本文让步。
