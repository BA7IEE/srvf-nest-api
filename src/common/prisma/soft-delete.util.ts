// V2 基线规范 §10 软删除显式封装。
//
// 沿用 v1 §10 / CLAUDE.md §10:仅显式调用,不引入 Prisma middleware /
// client extension / BaseRepository / 装饰器 / 拦截器 / Pipe 等隐式自动过滤。
// 形态铁律详见 docs/srvf-foundation-baseline.md §10.2.2。
//
// 用法:
//   prisma.user.findFirst({ where: notDeletedWhere({ id }) });
//   prisma.user.findMany({ where: notDeletedWhere() });
//   prisma.user.findMany({ where: notDeletedWhere({ status: 'ACTIVE' }) });
//
// 注意:本函数仅负责拼接 `deletedAt: null` 过滤条件,**不**绕过 Prisma 类型系统;
// 调用方仍需保证传入的 where 条件对目标 model 合法。

export function notDeletedWhere<T extends Record<string, unknown>>(
  where?: T,
): T & { deletedAt: null } {
  return {
    ...(where ?? ({} as T)),
    deletedAt: null,
  };
}
