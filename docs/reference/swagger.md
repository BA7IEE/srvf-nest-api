# Swagger 100% 覆盖(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §6 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:contract snapshot(schema 漂移即红)。

## 6. Swagger 100% 覆盖

- 每个 Controller 方法必须 `@ApiOperation({ summary })`
- 每个 DTO 字段必须 `@ApiProperty({ description })`
- 需鉴权方法必须 `@ApiBearerAuth()`
- 响应类型按返回结构选用,**禁止裸写** `@ApiOkResponse({ type: Dto })`:
  - 单对象:`@ApiWrappedOkResponse(Dto)`
  - 创建成功(HTTP 201):`@ApiWrappedCreatedResponse(Dto)`
  - 可空单对象(HTTP 200,`data: Dto | null`):`@ApiWrappedNullableResponse(Dto)`
  - 数组:`@ApiWrappedArrayResponse(Dto)`
  - **分页:`@ApiWrappedPageResponse(Dto)`**(必须用此装饰器)
- CSV / 204 响应分别用集中定义的 `@ApiCsvResponse()` / `@ApiNoContentResponse()`；不伪装成统一 JSON envelope
- 所有响应装饰器集中放在 `common/decorators/api-response.decorator.ts`
- POST 创建资源保持 Nest 默认 201 并声明 Created response；action / command 若约定 200 必须显式 `@HttpCode(HttpStatus.OK)`，禁止只改文档状态
- `PageResultDto<T>` 是 TS 泛型,`@nestjs/swagger` 无法 reflect 泛型参数,因此分页接口**必须**用 `@ApiWrappedPageResponse(Dto)`,装饰器内部用 `getSchemaPath(Dto)` + `allOf` 显式描述 `data: { items, total, page, pageSize }`,否则前端 SDK 生成器拿到的是单对象 schema。需要在 controller 类上配套 `@ApiExtraModels(Dto, PageResultDto)`

## 7. 路由权限声明

- 新增 Controller 路由必须带一项结构化权限声明装饰器；在 enforce 模式下，未声明路由会由 `AuthzDeclarationGuard` 在 handler 执行前以 `AUTHZ_UNDECLARED` 拒绝。
- 声明族、scope canonical 和示例以 [`ROUTE_AUTHZ`](../ai-harness/ROUTE_AUTHZ.md) 为准。

## 8. 两道语义门（架构治理 Phase 5 起生效）

> **改动端点授权声明或破坏契约 = 需维护者审批，不能自批。**

- **R14 授权语义门**：`ROUTE_AUTHZ` manifest 的 base↔head 四态比对。判成 `BROADER`（保护等级降级）或
  `INCOMPARABLE`（证明不了强弱）时，必须在 `changelog.d/` 补 `authz-downgrade` 申报块
  （`route` / `reason` / `impact` / `migration` 四行），并由维护者在 `harness-review` 环境点批。
  `NARROWER` / `EQUIVALENT` 放行，但恒进全量迁移清单（收紧同样改变前端可见行为）。
- **R11 契约语义门**：`docs/handoff/openapi.json` 的 base↔head 语义分类。判成 breaking（九类判定表见
  `scripts/contract-semantic-diff.ts` 头注）时，必须补 `contract-breaking` 申报块
  （`operation` / `reason` / `impact` / `migration` / `rollback` 五行），同样需环境审批。
- **两级结构，顺序不可颠倒**：申报完整性是**硬闸**——缺申报时 `Red-zone trusted scan` 直接失败，
  审批 job 被跳过，**没有可点的按钮**；补齐申报后才轮到 Environment 人工审批。
  **申报只是记录载体，不构成批准**；`rollback` 填的是真回滚手段（revert / feature gate / 兼容层），
  changelog 文件本身不是回滚。
- 本地自查：`pnpm gate:authz:semantic` / `pnpm gate:contract:semantic`（权威裁决恒在 CI 的 base-trusted 裁判）。
