import type { Response } from 'supertest';
import type { BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';

// 断言一个 supertest 响应符合 BizException 的标准错误结构:
//   - HTTP status === biz.httpStatus(反向验证 BizCode 与 HTTP 语义一致,
//     未来若有人改了 httpStatus 数值,所有用例会立刻挂)
//   - body.code === biz.code
//   - body.data === null
//   - body.message:默认严格相等 biz.message;若 message 由 ValidationPipe
//     透传字段错误细节(BAD_REQUEST 走 resolveHttpExceptionMessage 拼接),
//     调用方传 { strictMessage: false } 跳过严格断言。
//
// 刻意不写 expectOk:成功用例只有 health 一条,直接 toEqual 更显式。
export function expectBizError(
  res: Response,
  biz: BizCodeEntry,
  opts?: { strictMessage?: boolean },
): void {
  expect(res.status).toBe(biz.httpStatus);
  expect(res.body.code).toBe(biz.code);
  expect(res.body.data).toBeNull();
  if (opts?.strictMessage !== false) {
    expect(res.body.message).toBe(biz.message);
  }
}
