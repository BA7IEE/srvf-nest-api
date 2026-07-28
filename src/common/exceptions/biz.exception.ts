import type { BizCodeEntry } from './biz-code.constant';

// 构造参数类型锁死为 BizCodeEntry,禁止裸数字 / 字符串 / 临时对象。
// 详见 docs/reference/response-pagination-errors.md §5。
export class BizException extends Error {
  constructor(public readonly biz: BizCodeEntry) {
    super(biz.message);
    this.name = 'BizException';
  }
}
