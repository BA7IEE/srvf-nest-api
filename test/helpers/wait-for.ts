// 通用异步状态轮询工具:在 timeoutMs 内反复执行 predicate,直到返回 true。
//
// 主要场景:被测代码用 fire-and-forget(如 auth.service 里 lastLoginAt 的
// `void prisma.update().catch()`)异步写库,接口响应返回时数据库可能还没落,
// 直接 findUnique 拿不到——此时用 waitFor 取代 sleep + 一次查询的脆弱写法。
//
// 默认 500ms 超时 / 20ms 间隔:fire-and-forget 在正常事件循环 tick 内通常 < 50ms 完成,
// 500ms 是宽裕值;真 timeout 说明 fire-and-forget 失败,这正是用例要发现的。
export interface WaitForOpts {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  opts: WaitForOpts = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const intervalMs = opts.intervalMs ?? 20;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(opts.message ?? `waitFor timed out after ${timeoutMs}ms`);
}
