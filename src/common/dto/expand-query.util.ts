import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

// D6(admin-api-fe-integration-roadmap.md §3 / §11 已拍板):`expand` 仓库级约定,F2 首批落地
// (registrations/attendance-sheets),供 F3–F5 分页总表复用。语法:逗号分隔 token,每资源固定
// 白名单(见各调用方);默认(query 缺省/空串)返回空集 —— 调用方据此保持旧响应形状逐字不变。
// 白名单外 token 视为业务级入参错误,统一走 BizCode.BAD_REQUEST(沿本仓既有 DTO 校验惯例)。
export function parseExpandQuery<T extends string>(
  raw: string | undefined,
  whitelist: readonly T[],
): ReadonlySet<T> {
  if (raw === undefined || raw.trim() === '') return new Set();
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const token of tokens) {
    if (!(whitelist as readonly string[]).includes(token)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }
  return new Set(tokens as T[]);
}
