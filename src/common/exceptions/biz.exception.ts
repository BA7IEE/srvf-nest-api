import type { BizCodeEntry } from './biz-code.constant';

// 构造参数类型锁死为 BizCodeEntry,禁止裸数字 / 字符串 / 临时对象。
// 详见 ARCHITECTURE.md §7.3。
export class BizException extends Error {
  constructor(public readonly biz: BizCodeEntry) {
    super(biz.message);
    this.name = 'BizException';
  }
}
