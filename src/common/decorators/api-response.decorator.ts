import { Type, applyDecorators } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { PageResultDto } from '../dto/pagination.dto';
import type { BizCodeEntry } from '../exceptions/biz-code.constant';

// 三个包装装饰器统一描述业务响应外层 { code, message, data } 结构,
// 详见 ARCHITECTURE.md §7.4 + CLAUDE.md §6。
//
// 用法:
//   @ApiWrappedOkResponse(UserResponseDto)
//   @ApiWrappedArrayResponse(UserResponseDto)
//   @ApiWrappedPageResponse(UserResponseDto)
//
// 内部用 getSchemaPath + allOf 组合,Controller 类上还需配套 @ApiExtraModels(Dto)
// 让 Swagger 找到泛型实参 schema。本工厂自动把 Dto 加进 @ApiExtraModels。

const wrapEnvelope = (dataSchema: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  required: ['code', 'message', 'data'],
  properties: {
    code: { type: 'integer', example: 0, description: '业务码,0 表示成功' },
    message: { type: 'string', example: 'ok' },
    data: dataSchema,
  },
});

export const ApiWrappedOkResponse = <T extends Type<unknown>>(dto: T): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(dto),
    ApiOkResponse({
      schema: wrapEnvelope({ $ref: getSchemaPath(dto) }),
    }),
  );

export const ApiWrappedCreatedResponse = <T extends Type<unknown>>(dto: T): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(dto),
    ApiCreatedResponse({
      schema: wrapEnvelope({ $ref: getSchemaPath(dto) }),
    }),
  );

export const ApiWrappedNullableResponse = <T extends Type<unknown>>(dto: T): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(dto),
    ApiOkResponse({
      schema: wrapEnvelope({
        type: 'object',
        allOf: [{ $ref: getSchemaPath(dto) }],
        nullable: true,
        example: null,
      }),
    }),
  );

export const ApiWrappedArrayResponse = <T extends Type<unknown>>(dto: T): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(dto),
    ApiOkResponse({
      schema: wrapEnvelope({
        type: 'array',
        items: { $ref: getSchemaPath(dto) },
      }),
    }),
  );

// 找回密码 T2(2026-06-11):成功响应 data 恒为 null 的端点专用
// (评审稿 password-reset-by-sms-review.md E-9:reset 成功不返 token / 用户字段)。
// data 的 nullable object 形状与 ApiBizErrorResponse 的 data 描述一致;
// 不复用 ApiWrappedOkResponse(后者强制 $ref 一个 DTO,会让 snapshot 撒谎)。
//
// 用法:
//   @ApiWrappedNullResponse()
export const ApiWrappedNullResponse = (): MethodDecorator =>
  ApiOkResponse({
    schema: wrapEnvelope({ type: 'object', nullable: true, example: null }),
  });

export const ApiCsvResponse = (): MethodDecorator =>
  ApiResponse({
    status: 200,
    description: 'CSV file',
    content: {
      'text/csv': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  });

export const ApiNoContentResponse = (): MethodDecorator =>
  ApiResponse({ status: 204, description: 'No content' });

// V1.3-4 Contract Hardening:错误响应 schema 装饰器。
//
// 错误响应外层结构由 AllExceptionsFilter 保证为 { code, message, data: null },
// HTTP status 由 BizCode.httpStatus 决定(详见 ARCHITECTURE.md §7.4 / CLAUDE.md §5)。
//
// 用法:
//   @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
//   @ApiBizErrorResponse(BizCode.USER_NOT_FOUND, BizCode.FORBIDDEN_ROLE_OPERATION)
//
// 多个相同 httpStatus 的 BizCode 会被合并到同一条响应描述,`code` 字段用 `enum` 列出
// 全部可能值,description 列出每个 code 的语义。不同 httpStatus 的 BizCode 拆成多条
// @ApiResponse 注解,各自独立。
//
// 故意不引入 success path 的字段示例(避免与 @ApiWrappedXxxResponse 重复职责)。
const buildErrorSchema = (codes: ReadonlyArray<BizCodeEntry>): Record<string, unknown> => ({
  type: 'object',
  required: ['code', 'message', 'data'],
  properties: {
    code: {
      type: 'integer',
      enum: codes.map((c) => c.code),
      description: codes.map((c) => `${c.code}: ${c.message}`).join('; '),
      example: codes[0].code,
    },
    message: { type: 'string', example: codes[0].message },
    data: { type: 'object', nullable: true, example: null },
  },
});

export const ApiBizErrorResponse = (...bizCodes: BizCodeEntry[]): MethodDecorator => {
  if (bizCodes.length === 0) {
    throw new Error('ApiBizErrorResponse 至少需要一个 BizCode 入参');
  }
  const groups = new Map<number, BizCodeEntry[]>();
  for (const c of bizCodes) {
    const arr = groups.get(c.httpStatus) ?? [];
    arr.push(c);
    groups.set(c.httpStatus, arr);
  }
  const decorators = Array.from(groups.entries()).map(([status, codes]) =>
    ApiResponse({
      status,
      description: codes.map((c) => `${c.message}(code=${c.code})`).join(' / '),
      schema: buildErrorSchema(codes),
    }),
  );
  return applyDecorators(...decorators);
};

export const ApiWrappedPageResponse = <T extends Type<unknown>>(dto: T): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(PageResultDto, dto),
    ApiOkResponse({
      schema: wrapEnvelope({
        allOf: [
          { $ref: getSchemaPath(PageResultDto) },
          {
            type: 'object',
            required: ['items', 'total', 'page', 'pageSize'],
            properties: {
              items: { type: 'array', items: { $ref: getSchemaPath(dto) } },
            },
          },
        ],
      }),
    }),
  );
