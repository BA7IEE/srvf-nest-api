import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 字典 seed 登记表(`docs/ai-harness/DICTIONARY_SEED_REGISTRY.md`)双向对拍 —— **薄运行器**。
 *
 * 判据本体在 `scripts/check-dictionary-seed-registry.ts`(selfGuard 红区;2026-08-27
 * 维护者令牌收编,见 NEXT_TASKS P2-23a「形态取舍」)。本文件只做两件事:
 *   1. 真读数:对真源(seed.ts + 登记表)跑六维,全绿才作数;
 *   2. 常驻变异对拍(M1–M6):喂假输入,断言红集精确(只红目标维、其余全绿)
 *      —— 判据没判别力会被当场抓到,而不是等真事故才发现。
 * 仪器自证(S1–S4,合成样本)验证提取器/解析器的判别力。
 */

import {
  DICT_REGISTRY_PATH,
  DICT_SEED_PATH,
  allDimensions,
  extractSeedDictionaries,
  parseRegistry,
} from '../../../scripts/check-dictionary-seed-registry';

const SEED_SOURCE = readFileSync(path.resolve(__dirname, '../../..', DICT_SEED_PATH), 'utf8');
const REGISTRY_TEXT = readFileSync(path.resolve(__dirname, '../../..', DICT_REGISTRY_PATH), 'utf8');

type Dim = 'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

/** 变异对拍的公共断言:目标维点名、且**只有**目标维红(红集精确、两两不相交)。 */
function expectOnlyRed(dims: Record<Dim, string[]>, target: Dim, mustMention: string): void {
  for (const [dim, defects] of Object.entries(dims)) {
    if (dim === target) {
      expect(defects.length).toBeGreaterThan(0);
      expect(defects.join('\n')).toContain(mustMention);
    } else {
      expect(defects).toEqual([]);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 测试
// ══════════════════════════════════════════════════════════════════════════

describe('P2-23a 字典 seed 登记表 —— 仪器自证(合成样本,不落盘)', () => {
  it('S1 提取器:具名数组 + upsert 站点能被读出来', () => {
    const synthetic = [
      "const ARR = [{ type: { code: 't1', label: '甲' }, items: [{ code: 'a', label: 'A' }] }] as const;",
      'async function f(prisma: any) {',
      "  const t = await prisma.dictType.upsert({ where: { code: 't1' }, update: {}, create: { code: 't1', label: '甲', sortOrder: 0 } });",
      '  for (const item of ARR[0].items) {',
      '    await prisma.dictItem.upsert({ where: { typeId_code: { typeId: t.id, code: item.code } }, update: {}, create: { typeId: t.id, code: item.code, label: item.label } });',
      '  }',
      '}',
    ].join('\n');
    // 直接用「该合成源的配置」跑提取:census 对未知函数开火是 D1 的职责;
    // 这里只验「数据读得出来」。
    const e = extractSeedDictionaries(synthetic, {}, { flatArrays: ['ARR'], siteTyped: [] });
    expect(e.defects).toEqual([]);
    expect(e.types.get('t1')).toEqual({ label: '甲', items: [{ code: 'a', label: 'A' }] });
    expect(e.sites).toEqual([
      { model: 'dictType', fn: 'f', itemCodeLiteral: null },
      { model: 'dictItem', fn: 'f', itemCodeLiteral: false },
    ]);
  });

  it('S2 提取器:未绑定标识符 ⇒ 记缺陷(新外部化常量不登记就过不去)', () => {
    const synthetic =
      "const ARR = [{ type: { code: GHOST_TYPE, label: '甲' }, items: [] }] as const;";
    const e = extractSeedDictionaries(synthetic, {}, { flatArrays: ['ARR'], siteTyped: [] });
    expect(e.defects.join('\n')).toContain("未绑定的标识符 'GHOST_TYPE'");
  });

  it('S3 解析器:合法小节能解析出计数 / 小节 / 空表标注', () => {
    const synthetic = [
      '**字典 type(机器核对):2 个 · item(机器核对):1 项**',
      '',
      '## t1 — 甲',
      '',
      '| code | label |',
      '|---|---|',
      '| a | A |',
      '',
      '## t2 — 乙',
      '',
      '> seed 不预置 items(运营自填;依据见 seed.ts 该条目注释)。',
    ].join('\n');
    const r = parseRegistry(synthetic);
    expect(r.defects).toEqual([]);
    expect(r.declaredTypes).toBe(2);
    expect(r.declaredItems).toBe(1);
    expect(r.sections.get('t1')?.items).toEqual([{ code: 'a', label: 'A' }]);
    expect(r.sections.get('t2')?.emptyMarked).toBe(true);
  });

  it('S4 解析器:坏行 / 缺声明行 / 小节外表格行 ⇒ 各记缺陷(fail-closed)', () => {
    const r = parseRegistry('## t1 — 甲\n\n| a | A | extra |\n| 坏行\n');
    expect(r.defects.join('\n')).toContain('无法解析的表格行');
    expect(r.declaredTypes).toBeNull();
    const r2 = parseRegistry('**字典 type(机器核对):1 个 · item(机器核对):1 项**\n\n| a | A |');
    expect(r2.defects.join('\n')).toContain('小节之外');
  });
});

describe('P2-23a 字典 seed 登记表 —— 真读数(六维,全绿才作数)', () => {
  it('D0 仪器健康:提取器与解析器零缺陷(真源非退化)', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D0).toEqual([]);
  });

  it('D1 🔴 站点闭集:dictType/dictItem upsert 只在四个已知函数、数量精确、item code 非字面量', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D1).toEqual([]);
  });

  it('D2 🔴 声明行:自报计数与解析数一致,全集非空', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D2).toEqual([]);
  });

  it('D3 🔴 正向:seed 的每个字典 type/item 都已登记(漏登记即红)', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D3).toEqual([]);
  });

  it('D4 🔴 反向:登记表没有多余条目(多登记/已消失即红)', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D4).toEqual([]);
  });

  it('D5 🔴 label 镜像:登记表 label 与 seed 逐字相等', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D5).toEqual([]);
  });

  it('D6 🔴 空表标注:seed 空字典显式标注「不预置」,非空字典不带标注', () => {
    expect(allDimensions(SEED_SOURCE, REGISTRY_TEXT).D6).toEqual([]);
  });
});

describe('P2-23a 字典 seed 登记表 —— 常驻变异对拍(做错时必须红,且只红自己)', () => {
  it('M1 漏登记一条 item(声明行同步改,攻击者不会留着计数不不符)⇒ 只有 D3 红,点名那条', () => {
    const mutated = REGISTRY_TEXT.replace('| level-7 | 正式队员7级 |\n', '').replace(
      '**字典 type(机器核对):30 个 · item(机器核对):277 项**',
      '**字典 type(机器核对):30 个 · item(机器核对):276 项**',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(SEED_SOURCE, mutated), 'D3', "'member_grade' 的 item 'level-7'");
  });

  it('M2 多登记一条幽灵 item(声明行同步改)⇒ 只有 D4 红,点名那条', () => {
    const mutated = REGISTRY_TEXT.replace(
      '| reserve | 后备队员 |',
      '| reserve | 后备队员 |\n| level-8 | 幽灵级 |',
    ).replace(
      '**字典 type(机器核对):30 个 · item(机器核对):277 项**',
      '**字典 type(机器核对):30 个 · item(机器核对):278 项**',
    );
    expectOnlyRed(allDimensions(SEED_SOURCE, mutated), 'D4', "'member_grade' 的 item 'level-8'");
  });

  it('M3 改一个 label ⇒ 只有 D5 红,点名漂移', () => {
    const mutated = REGISTRY_TEXT.replace('| reserve | 后备队员 |', '| reserve | 后备队员x |');
    expectOnlyRed(
      allDimensions(SEED_SOURCE, mutated),
      'D5',
      "'member_grade' 的 item 'reserve' label 漂移",
    );
  });

  it('M4 seed 里冒出新的 upsert 站点(未知函数 + 字面量 code)⇒ 只有 D1 红', () => {
    const mutated = `${SEED_SOURCE}\nasync function seedGhostDict(prisma: PrismaClient): Promise<void> {\n  await prisma.dictType.upsert({ where: { code: 'ghost' }, update: {}, create: { code: 'ghost', label: '幽灵', sortOrder: 99 } });\n  await prisma.dictItem.upsert({ where: { typeId_code: { typeId: 'x', code: 'g1' } }, update: {}, create: { typeId: 'x', code: 'g1', label: '幽灵项' } });\n}\n`;
    const dims = allDimensions(mutated, REGISTRY_TEXT);
    expectOnlyRed(dims, 'D1', 'seedGhostDict');
    expect(dims.D1.join('\n')).toContain('字符串字面量');
  });

  it('M5 声明行数字改错 ⇒ 只有 D2 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      '**字典 type(机器核对):30 个 · item(机器核对):277 项**',
      '**字典 type(机器核对):29 个 · item(机器核对):276 项**',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(SEED_SOURCE, mutated), 'D2', '实际解析到');
  });

  it('M6 去掉空字典的「不预置」标注 ⇒ 只有 D6 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      '> seed 不预置 items(运营自填;依据见 seed.ts 该条目注释)。',
      '> (标注被删)',
    );
    expectOnlyRed(allDimensions(SEED_SOURCE, mutated), 'D6', "'group_function'");
  });
});
