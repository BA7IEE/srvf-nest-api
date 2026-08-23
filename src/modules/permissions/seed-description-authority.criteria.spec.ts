import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

// P2-15(2026-08-23):`Permission.description` 的 seed 单向权威 —— 执行位。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// `Permission.description` 的权威源是代码常量 `RbacPermissionSeed.description`
// (`permission-catalog.ts`)。DB 与代码分叉有两条路:
//   V1 运行时 `PATCH /permissions/:id` 改 DB   → ✅ 已关(P1-32 PR 3b,30110)
//   V2 改代码里的字符串,seed 的 `update: {}` 保证既有库永远收不到 → 🔴 本闸的靶子
//
// V2 不是假想缺陷:本刀立项时实测本机开发库 `app`,**4 条已漂移**
// (member.offboard.record / member-profile.read.record / certificate.read.record /
//  recruitment-application.mark.threshold)—— 全部是「代码后来改对了、库停在旧文案」。
// 例如招新那条,代码早已把「红十字」改成「急救资质」,库里到今天还是「红十字」。
// ⚠️ 这类漂移**零症状**:没有任何测试、任何检查会因为它变红。
//
// ─── 判据的职责不是当期快照 ────────────────────────────────────────────────
// 不是「今天这 4 处都写了 description」,而是:
//   🔴 **将来任何一处新的 `permission.upsert`,不覆盖 description 就进不了主干。**
// 所以发现面是**结构性扫 AST 调用**,不写死 4 处、不按行号 —— 第 5 处加进来时判据必须看见它。
//
// ─── ⭐ 反向锚点:字典**故意**不跟着改 ──────────────────────────────────────
// `dictType` / `dictItem` 的 `update: {}` 与权限的**语义已经分岔**,长得像不代表是同一件事:
//
//   | | 运行时可改吗 | `update: {}` 的含义 |
//   |---|---|---|
//   | Permission  | ❌ PR 3b 之后已关 | 「代码改了库收不到」= **缺陷** |
//   | DictType / DictItem | ✅ 运营本就该能改(是功能) | 「不回退运营的调整」= **正确** |
//
// ⇒ 改完之后两处形状不同是**刻意的**。下一个人很可能把字典当成「漏改」顺手统一 ——
//   而那会把字典的运营编辑功能悄悄打掉。**正向的破坏会被人发现(文案不更新);
//   反向的破坏零症状。** 所以反向锚点比正向那条更重要,不是补充。
//
// ─── 刻意不守的东西(范围收窄是拍板,不是遗漏)────────────────────────────
// 只覆盖 `description`。`module` / `action` / `resourceType` 同样只能经 V2 漂移,但它们是
// **结构字段**(被查询与索引使用),覆盖它们的打击面与本刀不同族 ⇒ 另立项。
// 本判据**刻意不断言**「update 里只能有 description」—— 否则那个后续立项会先撞judge。

const ROOT = path.resolve(__dirname, '../../..');
const SEED_REL = 'prisma/seed.ts';

/** 地板锚点。刻意不写「恰 N 处」—— 那会让每次新增 upsert 都要改判据,而「改判据才能过」正是判据失效的起点。 */
const PERMISSION_UPSERT_FLOOR = 4;
const DICT_UPSERT_FLOOR = 7;

type UpdateShape =
  | { kind: 'absent' }
  | { kind: 'not-object' }
  | { kind: 'object'; keys: string[]; descriptionFromProperty: boolean };

interface UpsertCall {
  readonly model: string;
  readonly line: number;
  readonly update: UpdateShape;
}

/**
 * 结构性发现面:扫 `<任意表达式>.<model>.upsert({ ... })` 调用。
 *
 * ⚠️ 恒走 typed-AST,不用 grep/awk —— 注释与字符串里出现的同名文本**不计**
 *   (仓内已有教训:`awk|grep` 会匹配到注释,而 seed.ts 的注释里恰好反复出现 `update: {}`)。
 */
function scanUpserts(source: string, fileName = 'seed.ts'): UpsertCall[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const calls: UpsertCall[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'upsert' &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const model = node.expression.expression.name.text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const [arg] = node.arguments;
      let update: UpdateShape = { kind: 'absent' };

      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        const prop = arg.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && propertyName(p) === 'update',
        );
        if (prop !== undefined) {
          if (ts.isObjectLiteralExpression(prop.initializer)) {
            const keys = prop.initializer.properties
              .map((p) => propertyName(p))
              .filter((k): k is string => k !== undefined);
            const descProp = prop.initializer.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && propertyName(p) === 'description',
            );
            update = {
              kind: 'object',
              keys,
              // 只认「取自某个对象的 .description」(即代码常量),
              // 写死字面量 `description: '...'` 不算 —— 那不是让代码常量成为权威。
              descriptionFromProperty:
                descProp !== undefined &&
                ts.isPropertyAccessExpression(descProp.initializer) &&
                descProp.initializer.name.text === 'description',
            };
          } else {
            update = { kind: 'not-object' };
          }
        }
      } else if (arg !== undefined) {
        update = { kind: 'not-object' };
      }

      calls.push({ model, line, update });
    }
    node.forEachChild(visit);
  };

  visit(sf);
  return calls;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const name = p.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

const seedSource = fs.readFileSync(path.join(ROOT, SEED_REL), 'utf-8');
const allUpserts = scanUpserts(seedSource, SEED_REL);
const permissionUpserts = allUpserts.filter((c) => c.model === 'permission');
const dictUpserts = allUpserts.filter((c) => c.model === 'dictType' || c.model === 'dictItem');

const at = (c: UpsertCall): string => `${SEED_REL}:${c.line}`;

// ─────────────────────────────────────────────────────────────────────────────
// 自证:先证明仪器没瞎,再报数。
// 「判据失去输入 ≠ 通过」—— 扫不到东西必须当场红,而不是「没有可检查的项 ⇒ 全过」。
// ─────────────────────────────────────────────────────────────────────────────
describe('seed description 权威判据 —— 自证(仪器先过体检)', () => {
  it('seed 源码读得到且非空', () => {
    expect(seedSource.length).toBeGreaterThan(10_000);
  });

  it('扫描面没塌:permission / dict 两族 upsert 都不低于地板', () => {
    expect(permissionUpserts.length).toBeGreaterThanOrEqual(PERMISSION_UPSERT_FLOOR);
    expect(dictUpserts.length).toBeGreaterThanOrEqual(DICT_UPSERT_FLOOR);
  });

  it('扫描器确实在分辨 model,而不是把所有 upsert 混成一堆', () => {
    const models = new Set(allUpserts.map((c) => c.model));
    // 这三族必须都在(权限 / 字典 / 角色);只剩一族 ⇒ model 提取错了。
    expect(models.has('permission')).toBe(true);
    expect(models.has('dictItem')).toBe(true);
    expect(models.has('rbacRole')).toBe(true);
    expect(allUpserts.length).toBeGreaterThan(permissionUpserts.length + dictUpserts.length);
  });

  it('⭐ 扫描器对合成样本给出正确读数(尺子自己也要验)', () => {
    // 正样本:带 description(取自常量)
    const good = scanUpserts(`
      await prisma.permission.upsert({ where: { code: p.code },
        update: { description: p.description }, create: p });
    `);
    expect(good).toHaveLength(1);
    expect(good[0]?.model).toBe('permission');
    expect(good[0]?.update).toMatchObject({ kind: 'object', descriptionFromProperty: true });

    // 负样本 1:update: {} —— 必须被判成缺 description
    const empty = scanUpserts(`
      await prisma.permission.upsert({ where: { code: p.code }, update: {}, create: p });
    `);
    expect(empty[0]?.update).toMatchObject({ kind: 'object', keys: [] });
    expect(empty[0]?.update).toMatchObject({ descriptionFromProperty: false });

    // 负样本 2:写死字面量 —— 不算「代码常量成为权威」
    const literal = scanUpserts(`
      await prisma.permission.upsert({ update: { description: 'hardcoded' } });
    `);
    expect(literal[0]?.update).toMatchObject({ descriptionFromProperty: false });

    // 负样本 3:注释与字符串里的同名文本**不得**被计入(grep 会中招,AST 不会)
    const noise = scanUpserts(`
      // await prisma.permission.upsert({ update: {} });
      const s = "prisma.permission.upsert({ update: {} })";
      /* prisma.dictItem.upsert({ update: {} }) */
    `);
    expect(noise).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 正向:每一处 permission.upsert 都必须把代码常量的 description 写回去。
// ─────────────────────────────────────────────────────────────────────────────
describe('seed description 权威判据 —— 正向(代码常量单向成为权威)', () => {
  it('🔴 每一处 prisma.permission.upsert 的 update 都含 description(新增一处不带即红并点名)', () => {
    const offenders = permissionUpserts
      .filter((c) => !(c.update.kind === 'object' && c.update.descriptionFromProperty))
      .map((c) => {
        const why =
          c.update.kind === 'absent'
            ? '没有 update 子句'
            : c.update.kind === 'not-object'
              ? 'update 不是对象字面量(判据无法静态确认它覆盖了 description)'
              : c.update.keys.includes('description')
                ? 'update.description 不是取自常量的 `<x>.description`'
                : `update 缺 description(现有键:${c.update.keys.join(', ') || '空'})`;
        return `${at(c)} —— ${why}`;
      });
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 反向锚点:字典必须**保持** `update: {}`。
// 这条守的是「下一个人顺手统一」——  破坏它零症状,所以它比正向那条更重要。
// ─────────────────────────────────────────────────────────────────────────────
describe('seed description 权威判据 —— 反向锚点(字典刻意不跟着改)', () => {
  it('🔴 每一处 dictType / dictItem upsert 仍是 update: {}(被顺手统一即红并点名)', () => {
    const offenders = dictUpserts
      .filter((c) => !(c.update.kind === 'object' && c.update.keys.length === 0))
      .map((c) => {
        const why =
          c.update.kind === 'object'
            ? `update 被写成 { ${c.update.keys.join(', ')} }`
            : c.update.kind === 'absent'
              ? '没有 update 子句'
              : 'update 不是对象字面量';
        return (
          `${at(c)} —— ${why};字典的 update: {} 是**功能不是缺陷**` +
          '(运营可运行时改字典文案,seed 不得回退),不要跟着 permission 一起改'
        );
      });
    expect(offenders).toEqual([]);
  });
});
