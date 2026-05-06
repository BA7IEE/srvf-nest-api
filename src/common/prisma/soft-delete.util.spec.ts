import { notDeletedWhere } from './soft-delete.util';

// V2 A1:soft-delete.util 纯函数单测。
// 不启动 NestJS、不连数据库,仅断言函数输入 → 输出。
// 形态铁律详见 docs/srvf-foundation-baseline.md §10.2。

describe('notDeletedWhere', () => {
  it('未传参时返回仅含 deletedAt: null 的对象', () => {
    expect(notDeletedWhere()).toEqual({ deletedAt: null });
  });

  it('传入空对象时返回仅含 deletedAt: null 的对象', () => {
    expect(notDeletedWhere({})).toEqual({ deletedAt: null });
  });

  it('合并任意 where 条件并追加 deletedAt: null', () => {
    expect(notDeletedWhere({ id: 'cuid-123' })).toEqual({
      id: 'cuid-123',
      deletedAt: null,
    });
  });

  it('保留多字段 where 条件', () => {
    expect(notDeletedWhere({ status: 'ACTIVE', role: 'USER' })).toEqual({
      status: 'ACTIVE',
      role: 'USER',
      deletedAt: null,
    });
  });

  it('调用方传入的 deletedAt 会被 null 覆盖(显式语义:本函数永远只查未软删记录)', () => {
    expect(notDeletedWhere({ deletedAt: new Date('2026-01-01') })).toEqual({
      deletedAt: null,
    });
  });

  it('返回的对象与输入是不同的引用(防止意外突变调用方传入的对象)', () => {
    const input = { id: 'a' };
    const output = notDeletedWhere(input);
    expect(output).not.toBe(input);
    expect(input).toEqual({ id: 'a' }); // 入参未被改写
  });

  it('支持嵌套对象作为 where 字段(Prisma 关系过滤场景)', () => {
    const where = {
      organization: { is: { id: 'org-1' } },
    };
    expect(notDeletedWhere(where)).toEqual({
      organization: { is: { id: 'org-1' } },
      deletedAt: null,
    });
  });

  it('返回类型在编译期可被泛型推导(类型层契约)', () => {
    // 仅验证类型层:返回值必须保留入参字段 + 追加 deletedAt: null。
    // 这里通过赋值给精确类型变量,若类型推导错误 typecheck 会失败。
    const result: { id: string; deletedAt: null } = notDeletedWhere({ id: 'x' });
    expect(result.id).toBe('x');
    expect(result.deletedAt).toBeNull();
  });
});
