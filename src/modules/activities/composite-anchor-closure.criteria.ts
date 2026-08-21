import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 业务复合锚点闭合判据(第六轮评审 A-2 + B-03)。
 *
 * 规则一句话:**凡是同时保存 ≥2 个业务锚点的模型,其指向同链对象的外键必须是复合的**。
 *
 * 为什么这是一类缺陷而不是若干实例:多张表同时存 activity / session / member 等多个
 * 锚点,但只有部分关系用了复合外键 —— 数据库因此只证明这些 ID **各自存在**,不证明
 * 它们属于**同一条业务主链**。committed 账本分录是服务时长与贡献值的正式真相,
 * 脏组合写进去之后会被冲正逻辑当作可信基线,形成难以修复的跨活动污染。
 *
 * ⚠️ 扫描面**从 schema.prisma 动态解析**,刻意不写死模型名单 —— 第五张同形状的表建
 *    出来时必须也被管住。写死名单的判据在新表出现时静默失明,这是本仓已登记的事故形状
 *    (「至少一处」型判据在第二个采纳者之后失明)。
 *
 * ⚠️ 本判据读的是 schema **文本**,一行 SQL 都没跑过。它只能证明「schema 写对了」,
 *    证明不了「数据库真的在挡」—— 迁移漏跑 / 约束建在错列上 / ADD CONSTRAINT 静默失败
 *    这三种形状它一个都发现不了。那一格由 `test/e2e/business-composite-anchor-closure`
 *    的 SQL 负例负责,两者缺一不可。
 */

/**
 * 业务主链的锚点列。这是**领域词表**,不是模型名单 —— 规则对任何持有其中 ≥2 列的
 * 模型一律生效,包括本文件写完之后才建出来的表。
 */
export const CHAIN_ANCHORS = ['activityId', 'sessionId', 'memberId'] as const;

/**
 * 「同链对象」的结构判据:目标模型自己带 `activityId` 标量列 ⇒ 它是活动域内的对象。
 *
 * 这一条同时把三类**正确的**单列外键排除在外,不需要为它们逐个写豁免:
 *   - `Activity` 自身(它没有 activityId 列,它就是锚点本身);
 *   - `Member` / `User` 等全局实体(不属于任何一个活动);
 *   - 一切 operator / reviewer / assignedBy 类**操作者**关系 —— 它们指向 User,
 *     而 `User.memberId` 是账号与队员的绑定关系,**不是本行的业务主体**。
 *     (若改用「列名相同即同链」,这些关系会因 User 也有 memberId 而被误判成漏闭合。)
 */
const CHAIN_SCOPE_COLUMN = 'activityId';

export interface PrismaRelationField {
  name: string;
  target: string;
  optional: boolean;
  list: boolean;
  fields: string[];
  references: string[];
  line: number;
}

export interface PrismaModel {
  name: string;
  scalars: Set<string>;
  relations: PrismaRelationField[];
  uniques: string[][];
  line: number;
}

export interface AnchorViolation {
  model: string;
  relation: string;
  target: string;
  /** 缺失的锚点列 —— 本该跟着外键一起走、却没走的那几列。 */
  missing: string[];
  /** 该用的外键列集合。 */
  requiredFkColumns: string[];
  /** 被引用侧需要的 unique(PostgreSQL 复合外键要求精确匹配)。 */
  requiredUniqueOnTarget: string[];
  line: number;
}

/** 例外:必须逐条写明理由,且理由要指向**权威源**,不能只写「历史原因」。 */
export interface AnchorExemption {
  model: string;
  relation: string;
  reason: string;
}

/**
 * 刻意**不**闭合的关系。全部四条同一个根因,都来自第 78 migration
 * (`20260807154000_activity_v11_batch4_capacity_reservation_member_activity_unique`)
 * 的拍板:`CapacityReservation.memberId / activityId` **只对 active 且
 * activity_person 的行必填**,session / position reservation 保持可空、零回填,
 * 「避免改写 session / position 历史」。
 *
 * 该拍板直接导致两个方向都走不通:
 *   - 出向(CapacityReservation 自己的外键):Prisma 拒绝**必填关系**含可空标量列;
 *     要闭合就得把 `identity` / `bucket` 改成可选 —— 那是放宽既有的 NOT NULL 保证。
 *   - 入向(投影指回 reservation):投影侧 activityId / memberId 均 NOT NULL,而被指向的
 *     session / position reservation 两列为 NULL ⇒ 复合外键**永远匹配不上**,
 *     每一次插入都会 23503。闭合等于把这条写路径整个焊死。
 *
 * 两条路都要求先改业务语义,超出本刀范围(goal §2「明确不做」第三条)。
 */
export const ANCHOR_CLOSURE_EXEMPTIONS: readonly AnchorExemption[] = [
  {
    model: 'CapacityReservation',
    relation: 'identity',
    reason:
      '第 78 migration 拍板 activityId/memberId 仅 active+activity_person 行必填;' +
      '闭合需把必填关系改为可选(Prisma 禁止必填关系含可空列)= 放宽既有保证。',
  },
  {
    model: 'CapacityReservation',
    relation: 'bucket',
    reason:
      '同上:activityId 可空 ⇒ Prisma 拒绝必填关系含可空标量列;' +
      '闭合需改 bucket 为可选,等于放宽「占位必属某容量桶」这条既有保证。',
  },
  {
    model: 'ActivityAllocationApplicationProjection',
    relation: 'sessionReservation',
    reason:
      '被指向的 session reservation 按第 78 migration 两锚点恒为 NULL,' +
      '而投影侧两列 NOT NULL ⇒ 复合外键永不匹配,闭合会让该写路径恒 23503。',
  },
  {
    model: 'ActivityAllocationApplicationProjection',
    relation: 'positionReservation',
    reason: '同上:position reservation 两锚点恒为 NULL,闭合会让该写路径恒 23503。',
  },
];

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

export function readSchemaText(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

function bracketList(source: string, key: string): string[] {
  const matched = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!matched) return [];
  return matched[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 解析 schema.prisma 的 model 块。
 *
 * 只取本判据用得着的四样:标量列名、to-one 关系(含 fields/references)、
 * 复合 unique、行号。刻意不做完整 Prisma DSL 解析 —— 用不上的东西不解析,
 * 少一份会悄悄解析错的代码。
 */
export function parsePrismaModels(schemaText: string): Map<string, PrismaModel> {
  const lines = schemaText.split('\n');
  const models = new Map<string, PrismaModel>();

  const declared = new Set<string>();
  const enums = new Set<string>();
  for (const line of lines) {
    const block = /^(model|enum|type)\s+(\w+)\s*\{/.exec(line);
    if (block) declared.add(block[2]);
    const enumBlock = /^enum\s+(\w+)\s*\{/.exec(line);
    if (enumBlock) enums.add(enumBlock[1]);
  }

  let current: PrismaModel | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opened = /^model\s+(\w+)\s*\{/.exec(line);
    if (opened) {
      current = {
        name: opened[1],
        scalars: new Set(),
        relations: [],
        uniques: [],
        line: index + 1,
      };
      models.set(current.name, current);
      continue;
    }
    if (!current) continue;
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }

    const body = line.replace(/\/\/.*$/, '').trim();
    if (!body) continue;

    if (body.startsWith('@@unique') || body.startsWith('@@id')) {
      const cols = /@@(?:unique|id)\(\s*\[([^\]]*)\]/.exec(body);
      if (cols) {
        current.uniques.push(
          cols[1]
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        );
      }
      continue;
    }
    if (body.startsWith('@@')) continue;

    const field = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(body);
    if (!field) continue;
    const [, fieldName, fieldType, isList, isOptional, rest] = field;

    if (declared.has(fieldType) && !enums.has(fieldType)) {
      const relation = /@relation\((.*)\)\s*$/.exec(rest);
      current.relations.push({
        name: fieldName,
        target: fieldType,
        optional: Boolean(isOptional),
        list: Boolean(isList),
        fields: relation ? bracketList(relation[1], 'fields') : [],
        references: relation ? bracketList(relation[1], 'references') : [],
        line: index + 1,
      });
      continue;
    }

    current.scalars.add(fieldName);
    if (/@unique\b/.test(rest)) current.uniques.push([fieldName]);
  }

  return models;
}

/** 持有 ≥2 个业务锚点的模型 —— 判据的管辖范围,动态取自 schema。 */
export function findAnchorHolders(models: Map<string, PrismaModel>): PrismaModel[] {
  return [...models.values()].filter(
    (model) => CHAIN_ANCHORS.filter((anchor) => model.scalars.has(anchor)).length >= 2,
  );
}

export function findAnchorViolations(models: Map<string, PrismaModel>): AnchorViolation[] {
  const violations: AnchorViolation[] = [];

  for (const model of findAnchorHolders(models)) {
    const held = CHAIN_ANCHORS.filter((anchor) => model.scalars.has(anchor));

    for (const relation of model.relations) {
      // 反向侧(1:1 被指向端)没有本地外键列,不承载任何约束,跳过。
      if (relation.list || relation.fields.length === 0) continue;

      const target = models.get(relation.target);
      if (!target || !target.scalars.has(CHAIN_SCOPE_COLUMN)) continue;

      const shared = held.filter((anchor) => target.scalars.has(anchor));
      if (shared.length === 0) continue;

      const missing = shared.filter(
        (anchor) => !(relation.fields.includes(anchor) && relation.references.includes(anchor)),
      );
      if (missing.length === 0) continue;

      violations.push({
        model: model.name,
        relation: relation.name,
        target: relation.target,
        missing,
        requiredFkColumns: [...new Set([...relation.fields, ...missing])],
        requiredUniqueOnTarget: [...new Set([...relation.references, ...shared])],
        line: relation.line,
      });
    }
  }

  return violations;
}

const exemptionKey = (model: string, relation: string) => `${model}.${relation}`;

export function isExempt(model: string, relation: string): boolean {
  return ANCHOR_CLOSURE_EXEMPTIONS.some(
    (item) => exemptionKey(item.model, item.relation) === exemptionKey(model, relation),
  );
}

export function describeViolation(violation: AnchorViolation): string {
  return (
    `  ${violation.model}.${violation.relation} -> ${violation.target}` +
    ` (schema.prisma:${violation.line})\n` +
    `      缺锚点: ${violation.missing.join(', ')}\n` +
    `      该用外键: fields: [${violation.requiredFkColumns.join(', ')}]` +
    ` references: [${violation.requiredUniqueOnTarget.join(', ')}]\n` +
    `      被引用侧需 ${violation.target} 上有 @@unique([${violation.requiredUniqueOnTarget.join(', ')}])`
  );
}
