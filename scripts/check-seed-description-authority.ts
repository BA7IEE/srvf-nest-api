/**
 * check-seed-description-authority.ts —— `Permission.description` 的 seed 单向权威(P2-15)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/permissions/seed-description-authority.criteria.spec.ts`)。
 *
 * ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
 * `Permission.description` 的权威源是代码常量 `RbacPermissionSeed.description`
 * (`permission-catalog.ts`)。DB 与代码分叉有两条路:
 *   V1 运行时 `PATCH /permissions/:id` 改 DB   → ✅ 已关(P1-32 PR 3b,30110)
 *   V2 改代码里的字符串,seed 的 `update: {}` 保证既有库永远收不到 → 🔴 本闸的靶子
 *
 * V2 不是假想缺陷:本刀立项时实测本机开发库 `app`,**4 条已漂移**
 * (member.offboard.record / member-profile.read.record / certificate.read.record /
 *  recruitment-application.mark.threshold)—— 全部是「代码后来改对了、库停在旧文案」。
 * 例如招新那条,代码早已把「红十字」改成「急救资质」,库里到今天还是「红十字」。
 * ⚠️ 这类漂移**零症状**:没有任何测试、任何检查会因为它变红。
 *
 * ─── 判据的职责不是当期快照 ────────────────────────────────────────────────
 * 不是「今天这 4 处都写了 description」,而是:
 *   🔴 **将来任何一处新的 `permission.upsert`,不覆盖 description 就进不了主干。**
 * 所以发现面是**结构性扫 AST 调用**,不写死 4 处、不按行号 —— 第 5 处加进来时判据必须看见它。
 *
 * ─── ⭐ 反向锚点:字典**故意**不跟着改 ──────────────────────────────────────
 * `dictType` / `dictItem` 的 `update: {}` 与权限的**语义已经分岔**,长得像不代表是同一件事:
 *
 *   | | 运行时可改吗 | `update: {}` 的含义 |
 *   |---|---|---|
 *   | Permission  | ❌ PR 3b 之后已关 | 「代码改了库收不到」= **缺陷** |
 *   | DictType / DictItem | ✅ 运营本就该能改(是功能) | 「不回退运营的调整」= **正确** |
 *
 * ⇒ 改完之后两处形状不同是**刻意的**。下一个人很可能把字典当成「漏改」顺手统一 ——
 *   而那会把字典的运营编辑功能悄悄打掉。**正向的破坏会被人发现(文案不更新);
 *   反向的破坏零症状。** 所以反向锚点比正向那条更重要,不是补充。
 *
 * ─── 刻意不守的东西(范围收窄是拍板,不是遗漏)────────────────────────────
 * 只覆盖 `description`。`module` / `action` / `resourceType` 同样只能经 V2 漂移,但它们是
 * **结构字段**(被查询与索引使用),覆盖它们的打击面与本刀不同族 ⇒ 另立项。
 * 本判据**刻意不断言**「update 里只能有 description」—— 否则那个后续立项会先撞judge。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

export const SEED_REL = 'prisma/seed.ts';

/** 地板锚点。刻意不写「恰 N 处」—— 那会让每次新增 upsert 都要改判据,而「改判据才能过」正是判据失效的起点。 */
export const PERMISSION_UPSERT_FLOOR = 4;
export const DICT_UPSERT_FLOOR = 7;

/** seed 源码体量地板 —— 读到空文件 / 读错路径时必须红。 */
export const SEED_SOURCE_FLOOR = 10_000;

/** 反向锚点管辖的字典模型。 */
export const DICT_MODELS = ['dictType', 'dictItem'];

/** 扫描器必须分辨得出的三族 model;只剩一族 ⇒ model 提取错了。 */
export const REQUIRED_MODELS = ['permission', 'dictItem', 'rbacRole'];

export type UpdateShape =
  | { kind: 'absent' }
  | { kind: 'not-object' }
  | { kind: 'object'; keys: string[]; descriptionFromProperty: boolean };

export interface UpsertCall {
  readonly model: string;
  readonly line: number;
  readonly update: UpdateShape;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const name = p.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * 结构性发现面:扫 `<任意表达式>.<model>.upsert({ ... })` 调用。
 *
 * ⚠️ 恒走 typed-AST,不用 grep/awk —— 注释与字符串里出现的同名文本**不计**
 *   (仓内已有教训:`awk|grep` 会匹配到注释,而 seed.ts 的注释里恰好反复出现 `update: {}`)。
 */
export function scanUpserts(source: string, fileName = 'seed.ts'): UpsertCall[] {
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

export function readSeedSource(root: string = ROOT): string {
  return fs.readFileSync(path.join(root, SEED_REL), 'utf-8');
}

const at = (c: UpsertCall): string => `${SEED_REL}:${c.line}`;

export interface SeedDescriptionReport {
  seedSourceLength: number;
  allUpserts: UpsertCall[];
  permissionUpserts: UpsertCall[];
  dictUpserts: UpsertCall[];
  models: string[];
  /** 正向违规:permission.upsert 没把代码常量的 description 写回去。 */
  permissionOffenders: string[];
  /** 反向违规:字典 upsert 不再是 `update: {}`。 */
  dictOffenders: string[];
}

export function analyzeSeedDescriptionAuthority(root: string = ROOT): SeedDescriptionReport {
  const seedSource = readSeedSource(root);
  const allUpserts = scanUpserts(seedSource, SEED_REL);
  const permissionUpserts = allUpserts.filter((c) => c.model === 'permission');
  const dictUpserts = allUpserts.filter((c) => DICT_MODELS.includes(c.model));

  const permissionOffenders = permissionUpserts
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

  const dictOffenders = dictUpserts
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

  return {
    seedSourceLength: seedSource.length,
    allUpserts,
    permissionUpserts,
    dictUpserts,
    models: [...new Set(allUpserts.map((c) => c.model))].sort(),
    permissionOffenders,
    dictOffenders,
  };
}

// ============================================================================
// ⭐ 尺子自己也要验:合成样本对照
//
// 原先这四个样本以模板字符串写在 spec 里。它们是「扫描器读数正确」的证明本身 ——
// 放在无保护文件里等于证明可以被顺手删掉,而删掉之后判据看起来照样全绿。
// ============================================================================

/** 正样本:带 description(取自常量)。 */
export const SAMPLE_GOOD = `
      await prisma.permission.upsert({ where: { code: p.code },
        update: { description: p.description }, create: p });
    `;

/** 负样本 1:`update: {}` —— 必须被判成缺 description。 */
export const SAMPLE_EMPTY_UPDATE = `
      await prisma.permission.upsert({ where: { code: p.code }, update: {}, create: p });
    `;

/** 负样本 2:写死字面量 —— 不算「代码常量成为权威」。 */
export const SAMPLE_LITERAL_DESCRIPTION = `
      await prisma.permission.upsert({ update: { description: 'hardcoded' } });
    `;

/** 负样本 3:注释与字符串里的同名文本**不得**被计入(grep 会中招,AST 不会)。 */
export const SAMPLE_COMMENT_NOISE = `
      // await prisma.permission.upsert({ update: {} });
      const s = "prisma.permission.upsert({ update: {} })";
      /* prisma.dictItem.upsert({ update: {} }) */
    `;

/**
 * 自证:先证明仪器没瞎,再报数。
 * 「判据失去输入 ≠ 通过」—— 扫不到东西必须当场红,而不是「没有可检查的项 ⇒ 全过」。
 */
export function selfCheck(report: SeedDescriptionReport): string[] {
  const problems: string[] = [];

  if (report.seedSourceLength <= SEED_SOURCE_FLOOR) {
    problems.push(`seed 源码只有 ${report.seedSourceLength} 字节,地板是 >${SEED_SOURCE_FLOOR} —— 读错路径了。`);
  }
  if (report.permissionUpserts.length < PERMISSION_UPSERT_FLOOR) {
    problems.push(
      `permission.upsert 只扫到 ${report.permissionUpserts.length} 处,地板是 ${PERMISSION_UPSERT_FLOOR}。`,
    );
  }
  if (report.dictUpserts.length < DICT_UPSERT_FLOOR) {
    problems.push(`字典 upsert 只扫到 ${report.dictUpserts.length} 处,地板是 ${DICT_UPSERT_FLOOR}。`);
  }
  for (const model of REQUIRED_MODELS) {
    if (!report.models.includes(model)) {
      problems.push(`扫描器没分辨出 model「${model}」—— 它把所有 upsert 混成一堆了。`);
    }
  }
  if (report.allUpserts.length <= report.permissionUpserts.length + report.dictUpserts.length) {
    problems.push('扫描面只剩权限与字典两族 —— model 提取错了(角色等其余 upsert 消失了)。');
  }

  // ⭐ 合成样本对照:尺子自己也要验。
  const good = scanUpserts(SAMPLE_GOOD);
  if (
    good.length !== 1 ||
    good[0]?.model !== 'permission' ||
    good[0]?.update.kind !== 'object' ||
    !good[0].update.descriptionFromProperty
  ) {
    problems.push('合成正样本读错:带常量 description 的 upsert 没被认出来。');
  }

  const empty = scanUpserts(SAMPLE_EMPTY_UPDATE)[0]?.update;
  if (empty?.kind !== 'object' || empty.keys.length !== 0 || empty.descriptionFromProperty) {
    problems.push('合成负样本 1 读错:`update: {}` 没被判成缺 description。');
  }

  const literal = scanUpserts(SAMPLE_LITERAL_DESCRIPTION)[0]?.update;
  if (literal?.kind !== 'object' || literal.descriptionFromProperty) {
    problems.push('合成负样本 2 读错:写死字面量被当成了「代码常量成为权威」。');
  }

  if (scanUpserts(SAMPLE_COMMENT_NOISE).length !== 0) {
    problems.push('合成负样本 3 读错:注释 / 字符串里的同名文本被计入了(AST 退化成了文本匹配)。');
  }

  return problems;
}

function main(): void {
  const report = analyzeSeedDescriptionAuthority();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);
  for (const offender of report.permissionOffenders) console.error(`🔴 正向违规:${offender}`);
  for (const offender of report.dictOffenders) console.error(`🔴 反向锚点被破坏:${offender}`);

  const broken = problems.length + report.permissionOffenders.length + report.dictOffenders.length;
  if (broken === 0) {
    console.log(
      `✓ seed description 单向权威成立(permission ${report.permissionUpserts.length} 处全覆盖 / ` +
        `字典 ${report.dictUpserts.length} 处仍是 update: {})。`,
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
