# Swagger 100% 覆盖(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §6 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:contract snapshot(schema 漂移即红)。

## 6. Swagger 100% 覆盖

- 每个 Controller 方法必须 `@ApiOperation({ summary })`
- 每个 DTO 字段必须 `@ApiProperty({ description })`
- 需鉴权方法必须 `@ApiBearerAuth()`
- 响应类型按返回结构选用,**禁止裸写** `@ApiOkResponse({ type: Dto })`:
  - 单对象:`@ApiWrappedOkResponse(Dto)`
  - 数组:`@ApiWrappedArrayResponse(Dto)`
  - **分页:`@ApiWrappedPageResponse(Dto)`**(必须用此装饰器)
- 三个装饰器集中放在 `common/decorators/api-response.decorator.ts`
- `PageResultDto<T>` 是 TS 泛型,`@nestjs/swagger` 无法 reflect 泛型参数,因此分页接口**必须**用 `@ApiWrappedPageResponse(Dto)`,装饰器内部用 `getSchemaPath(Dto)` + `allOf` 显式描述 `data: { items, total, page, pageSize }`,否则前端 SDK 生成器拿到的是单对象 schema。需要在 controller 类上配套 `@ApiExtraModels(Dto, PageResultDto)`

