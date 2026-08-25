import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 业务复合锚点闭合判据(第六轮评审 A-2 + B-03)+ 冻结记录改号锁(P2-11)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/activities/composite-anchor-closure.criteria.spec.ts`)。
 *
 * 规则两句话:
 *   ① **闭合**:凡是同时保存 ≥2 个业务锚点的模型,其指向同链对象的外键必须是复合的。
 *   ② **改号锁**(P2-11):「冻结记录 + 复合外键」这个集合里,不允许出现**既无
 *      `onUpdate: Restrict` 又无 append-only / immutable trigger** 的成员。
 *
 * 两句话是同一件事的两半:① 保证复合锚点**存在**,② 保证它**不会跟着上游偷偷改掉**。
 * 只有 ① 时,改上游主键会顺着 Prisma 默认的 `ON UPDATE CASCADE` 把冻结记录一起改写,
 * 而冻结记录按定义没有 `updatedAt`、事后无从发现。
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
  /** `@relation(... onDelete: X)`;未写时为 undefined(= Prisma 默认值,不是 'Cascade' 字面量)。 */
  onDelete?: string;
  /**
   * `@relation(... onUpdate: X)`。**未写时为 undefined,而 Prisma 的默认值是 `Cascade`** ——
   * 这正是本文件规则 ② 要抓的那个洞:漏写不是「保持不变」,是「静默级联」。
   */
  onUpdate?: string;
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

// ⚠️ 本文件从 `src/modules/activities/` 搬进 `scripts/` 时,这里的层级从三级变一级。
const SCHEMA_PATH = join(__dirname, '..', 'prisma', 'schema.prisma');

export function readSchemaText(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/** 取 `@relation(...)` 里的引用动作(`onDelete` / `onUpdate`);没写就是 undefined。 */
function referentialAction(source: string, key: string): string | undefined {
  const matched = new RegExp(`${key}\\s*:\\s*(\\w+)`).exec(source);
  return matched ? matched[1] : undefined;
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
        onDelete: relation ? referentialAction(relation[1], 'onDelete') : undefined,
        onUpdate: relation ? referentialAction(relation[1], 'onUpdate') : undefined,
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

// ============================================================================
// 规则 ②:冻结记录的改号锁(P2-11)
//
// 缺陷类:**冻结记录跟着上游改号一起被改掉,且不留痕**。
//
// Prisma 的 `onUpdate` 默认值是 `Cascade`(与被引用列可空与否无关)⇒ 关系上只写
// `onDelete: Restrict` 的复合外键,实际 DDL 落到 `ON UPDATE CASCADE`。对普通业务表这
// 无所谓(改代理主键本就不该发生,真发生了也有 `updatedAt` 留痕);对**冻结记录**则
// 是硬伤:它按定义不该被改,又恰恰没有任何一处能看出它被改过。
//
// ⚠️ 判据形状刻意**不是**「数全仓有几条 ON UPDATE CASCADE」—— 那个分母(全仓两百多条)
//    没有意义,而且会随任意一条无关外键的增减而漂移,最后只能被人调数字。
//    这里问的是一句**机制**话:该被锁住的那批里,有没有谁两道锁都没上。
// ============================================================================

/**
 * 「冻结记录」的结构判据:**有 `createdAt`、没有 `updatedAt`**。
 *
 * 这是 schema 文本里能读到的、最接近「这行写下去就不再改」的声明 —— 一张表若真的
 * 打算被更新,本仓的既有约定是给它 `updatedAt DateTime @updatedAt`。反过来,漏掉
 * `updatedAt` 的可更新表在本仓属于另一类缺陷,不由本判据兜底。
 *
 * ⚠️ 刻意不用「表名像不像快照 / 名册」这种词面判据:命名会漂,而这两列的有无是
 *    Prisma 生成物与迁移都跟着走的硬事实。
 */
export function isFrozenRecord(model: PrismaModel): boolean {
  return model.scalars.has('createdAt') && !model.scalars.has('updatedAt');
}

/** 冻结记录 ∩ 多锚点模型 —— 规则 ② 的管辖面,和规则 ① 一样动态取自 schema。 */
export function findFrozenAnchorHolders(models: Map<string, PrismaModel>): PrismaModel[] {
  return findAnchorHolders(models).filter(isFrozenRecord);
}

export interface ImmutabilityTrigger {
  table: string;
  trigger: string;
  /** 建它的那条 migration 目录名 —— 红了要能一眼找到出处。 */
  migration: string;
}

const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

/**
 * 从 `prisma/migrations/**` 里现算「哪些表挂了 BEFORE UPDATE 触发器」。
 *
 * ⚠️ 判的是**结构**不是名字:必须是 `CREATE TRIGGER … BEFORE … UPDATE … ON "<表>"`。
 *    按触发器名里有没有 `append_only` / `immutable` 来判会漏掉改了名的守卫,
 *    而漏判方向是「要求它写 onUpdate: Restrict」—— fail-closed,可接受;
 *    但按名字判还会**误收**一个叫 `_immutable` 却根本不管 UPDATE 的触发器,
 *    那是 fail-open,不可接受。故只认 BEFORE UPDATE 这个结构事实。
 *
 * ⚠️ 同时处理 `DROP TRIGGER`:migration 按目录名(时间戳)排序回放,后建后拆。
 *    否则「触发器早被后一条 migration 拆了,判据还以为它在」= 静默 fail-open,
 *    正是本仓已登记的「白名单指着已删东西」事故形状(#1184)。
 */
export function readImmutabilityTriggers(): Map<string, ImmutabilityTrigger[]> {
  const live = new Map<string, ImmutabilityTrigger>();
  for (const dir of listMigrationDirs()) {
    const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, 'utf8');

    const created = /CREATE\s+TRIGGER\s+(\w+)\s+BEFORE\s+([A-Za-z\s]+?)\s+ON\s+"(\w+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = created.exec(sql)) !== null) {
      const [, trigger, events, table] = match;
      if (!/\bUPDATE\b/i.test(events)) continue;
      live.set(`${table}.${trigger}`, { table, trigger, migration: dir });
    }

    const dropped = /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ON\s+"(\w+)"/gi;
    while ((match = dropped.exec(sql)) !== null) {
      live.delete(`${match[2]}.${match[1]}`);
    }
  }

  const byTable = new Map<string, ImmutabilityTrigger[]>();
  for (const entry of live.values()) {
    const bucket = byTable.get(entry.table) ?? [];
    bucket.push(entry);
    byTable.set(entry.table, bucket);
  }
  return byTable;
}

export function listMigrationDirs(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface RenumberingLeak {
  model: string;
  relation: string;
  target: string;
  /** 本地外键列 —— 上游一改号,这几列会被 CASCADE 静默改写。 */
  fkColumns: string[];
  /** 当前声明的 onUpdate;undefined = 压根没写 ⇒ Prisma 默认 Cascade。 */
  declaredOnUpdate?: string;
  line: number;
}

/** 规则 ② 认可的引用动作。`NoAction` 在 PostgreSQL 里可延迟,不足以当「锁」。 */
export const REQUIRED_ON_UPDATE = 'Restrict';

/**
 * 找出「冻结记录 + 复合外键」里两道锁都没上的成员。
 *
 * 两道锁**任一**成立即可(拍板:「先只锁编号」,不强推 trigger):
 *   · 关系上写了 `onUpdate: Restrict` ⇒ 改上游主键当场 23503;
 *   · 该表挂了 BEFORE UPDATE 触发器 ⇒ 级联下来的那条 UPDATE 也会被它挡掉。
 */
export function findRenumberingLeaks(
  models: Map<string, PrismaModel>,
  triggers: Map<string, ImmutabilityTrigger[]> = readImmutabilityTriggers(),
): RenumberingLeak[] {
  const leaks: RenumberingLeak[] = [];

  for (const model of findFrozenAnchorHolders(models)) {
    if ((triggers.get(model.name) ?? []).length > 0) continue;

    for (const relation of model.relations) {
      // 反向侧无本地外键列;单列外键指向的是代理主键,不承载业务锚点(拍板范围外)。
      if (relation.list || relation.fields.length < 2) continue;
      if (relation.onUpdate === REQUIRED_ON_UPDATE) continue;

      leaks.push({
        model: model.name,
        relation: relation.name,
        target: relation.target,
        fkColumns: [...relation.fields],
        declaredOnUpdate: relation.onUpdate,
        line: relation.line,
      });
    }
  }

  return leaks;
}

export function describeRenumberingLeak(leak: RenumberingLeak): string {
  const declared = leak.declaredOnUpdate ?? '(未写 ⇒ Prisma 默认 Cascade)';
  return (
    `  ${leak.model}.${leak.relation} -> ${leak.target}` +
    ` (schema.prisma:${leak.line})\n` +
    `      外键列: ${leak.fkColumns.join(', ')}\n` +
    `      当前 onUpdate: ${declared},要求 ${REQUIRED_ON_UPDATE}\n` +
    `      ${leak.model} 是冻结记录(有 createdAt 无 updatedAt)且未挂 BEFORE UPDATE 触发器 ——` +
    ` 上游改号会把这几列静默改写,事后无从发现`
  );
}

// ============================================================================
// 地板锚点 —— 原先以字面量写在 spec 里
//
// 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。下面几条用**地板锚点**
// (至少有多少)而不是「恰好 N 条」—— 写死数量的自证会在下次加表时过期,
// 然后被人顺手改大,判据就此失去意义。
//
// 放在这里而不是 spec 里的理由:它们是判据的**强度旋钮**。写在 spec 里的
// `toBeGreaterThan(80)` 可以被任何 PR 改成 `toBeGreaterThan(0)`,零授权零痕迹。
// ============================================================================

/** 解析出的模型数地板。低于它说明 schema 解析器坏了,不是「仓库真的只剩这么几张表」。 */
export const MIN_PARSED_MODELS = 80;

/** 持有 ≥2 个业务锚点的模型数地板 —— 管辖面远不止那四张具名表。 */
export const MIN_ANCHOR_HOLDERS = 15;

/** 被检查的 to-one 关系数地板 —— 证明判据真的逐条看过关系,不是空转。 */
export const MIN_INSPECTED_RELATIONS = 50;

/** 豁免理由的最短长度 —— 防止白名单里塞「TODO」「暂时」这种空理由。 */
export const MIN_EXEMPTION_REASON_LENGTH = 20;

/** 必须落在管辖内的具名表(地板,不是全集)。 */
export const NAMED_ANCHOR_TABLES = [
  'ActivityParticipationIdentity',
  'AttendancePunchEvent',
  'ParticipationLedgerEntry',
  'OfflinePackageParticipant',
];

/** 指向全局实体的操作者类关系 —— 这些**不该**被判红(Activity/User/Member 是链根)。 */
export const GLOBAL_ENTITY_TARGETS = ['User', 'Member', 'Activity'];

/**
 * 规则 ② 的管辖面地板:这些表必须被认成**冻结记录**。
 *
 * 同样是地板不是全集 —— 第五张「有 createdAt 无 updatedAt 的多锚点表」建出来时
 * 会自动进入管辖,不需要有人来改这份名单。写在这里只为守住一件事:
 * 若哪天 `isFrozenRecord` 的判据被改坏(比如把 `updatedAt` 拼错),
 * 管辖面会静默塌成空集、零 leak、全绿 —— 这条当场把它拦下。
 */
export const NAMED_FROZEN_ANCHOR_TABLES = [
  'ActivityAllocationApplicationProjection',
  'AttendancePunchEvent',
  'OfflinePackageParticipant',
  'ParticipationLedgerEntry',
];

/**
 * 触发器索引的地板。低于它说明 migration 扫描器坏了。
 *
 * ⚠️ 触发器索引塌掉的方向是 **fail-closed**(表变成「没挂触发器」⇒ 要求写
 *    onUpdate: Restrict ⇒ 判据变红),所以它不会造成假绿;这条地板只为把
 *    「为什么突然红了」的诊断从「你漏写 onUpdate」纠正成「扫描器坏了」。
 */
export const MIN_IMMUTABILITY_TRIGGERS = 5;

/** 被扫过的 migration 目录数地板 —— 证明 migration 扫描器真的看见了仓库。 */
export const MIN_SCANNED_MIGRATIONS = 90;

/**
 * 必须被认出挂了 BEFORE UPDATE 触发器的表(地板)。
 *
 * 这两张表是规则 ② 里**唯二**靠触发器过关的成员 —— 触发器这条豁免路径是否真的
 * 在做功,全靠它们证明。少了它们,豁免路径就成了「写着但从没被走过」的死代码。
 */
export const NAMED_TRIGGER_PROTECTED_TABLES = ['AttendancePunchEvent', 'ParticipationLedgerEntry'];

// ============================================================================
// 结论:把「扫 + 套白名单」合成一次调用
//
// 原先 spec 里写的是 `findAnchorViolations(models).filter((v) => !isExempt(...))` ——
// **白名单的应用**是判定口径的一部分,放在 spec 里意味着把 filter 改成
// `.filter(() => false)` 就能全绿。搬进来。
// ============================================================================

export interface AnchorClosureReport {
  models: Map<string, PrismaModel>;
  holders: PrismaModel[];
  /** 已套用豁免白名单的违规 —— 主断言看这个。 */
  violations: AnchorViolation[];
  /** 未套白名单的原始违规 —— 「豁免是否过期」要看这个。 */
  rawViolations: AnchorViolation[];
  /** 被逐条检查过的 to-one 关系数。 */
  inspectedRelations: number;
  /** 规则 ②:冻结记录 ∩ 多锚点模型。 */
  frozenHolders: PrismaModel[];
  /** 规则 ②:两道锁都没上的复合外键。 */
  renumberingLeaks: RenumberingLeak[];
  /** 规则 ②:现算出来的 BEFORE UPDATE 触发器索引(按表)。 */
  immutabilityTriggers: Map<string, ImmutabilityTrigger[]>;
  /** 规则 ②:被扫过的 migration 目录数。 */
  scannedMigrations: number;
  /** 规则 ②:被逐条检查过的复合外键数(冻结记录上的)。 */
  inspectedFrozenComposites: number;
}

export function analyzeAnchorClosure(
  schemaText: string = readSchemaText(),
  triggers: Map<string, ImmutabilityTrigger[]> = readImmutabilityTriggers(),
): AnchorClosureReport {
  const models = parsePrismaModels(schemaText);
  const holders = findAnchorHolders(models);
  const rawViolations = findAnchorViolations(models);
  const frozenHolders = findFrozenAnchorHolders(models);
  return {
    models,
    holders,
    rawViolations,
    violations: rawViolations.filter((v) => !isExempt(v.model, v.relation)),
    inspectedRelations: holders
      .flatMap((model) => model.relations)
      .filter((relation) => !relation.list && relation.fields.length > 0).length,
    frozenHolders,
    renumberingLeaks: findRenumberingLeaks(models, triggers),
    immutabilityTriggers: triggers,
    scannedMigrations: listMigrationDirs().length,
    inspectedFrozenComposites: frozenHolders
      .flatMap((model) => model.relations)
      .filter((relation) => !relation.list && relation.fields.length >= 2).length,
  };
}

/**
 * 已经没有对应违规的豁免 —— 留着会让人误以为「这几处是故意不闭合的」。
 *
 * 参数化 `exemptions` 只为一件事:让防腐自证(`bogusExemptionControl`)能往里塞一条
 * 指着不存在的表的条目,证明这条检查**真的会红**。生产路径恒用默认值。
 */
export function staleExemptions(
  report: AnchorClosureReport,
  exemptions: readonly AnchorExemption[] = ANCHOR_CLOSURE_EXEMPTIONS,
): string[] {
  return exemptions
    .filter(
      (exemption) =>
        !report.rawViolations.some(
          (violation) =>
            violation.model === exemption.model && violation.relation === exemption.relation,
        ),
    )
    .map((item) => `${item.model}.${item.relation}`);
}

/** 理由太短的豁免。 */
export function thinExemptionReasons(
  exemptions: readonly AnchorExemption[] = ANCHOR_CLOSURE_EXEMPTIONS,
): string[] {
  return exemptions
    .filter((exemption) => exemption.reason.length <= MIN_EXEMPTION_REASON_LENGTH)
    .map((item) => `${item.model}.${item.relation}`);
}

/** 操作者类关系被误判 —— 若「同链」判据改用「列名相同」就会大面积误红。 */
export function misflaggedActorRelations(report: AnchorClosureReport): AnchorViolation[] {
  return report.rawViolations.filter((violation) =>
    GLOBAL_ENTITY_TARGETS.includes(violation.target),
  );
}

// ============================================================================
// 变异对拍:正对照 / 反对照
//
// 没有这两条,一个恒返回 [] 的 findAnchorViolations 也会让主断言全绿。
// 它们原先带着正则与字符串替换写在 spec 里 —— 那正是判据「会不会红」的证明本身。
// ============================================================================

const CLOSED_RELATION_SNIPPET =
  'participationIdentity ActivityParticipationIdentity @relation(fields: [participationIdentityId, activityId, sessionId, memberId], references: [id, activityId, sessionId, memberId], onDelete: Restrict)';

const REVERTED_RELATION_SNIPPET =
  'participationIdentity ActivityParticipationIdentity @relation(fields: [participationIdentityId], references: [id], onDelete: Restrict)';

/** schema 文本里把连续空白压成单空格,便于按片段比对。 */
export function normaliseSchema(schemaText: string): string {
  return schemaText.replace(/[ \t]+/g, ' ');
}

/** 前置:被测的那处**当下确实是闭合的**(否则下面的变异是空变异)。 */
export function closedRelationIsPresent(schemaText: string = readSchemaText()): boolean {
  return normaliseSchema(schemaText).includes(CLOSED_RELATION_SNIPPET);
}

/**
 * 正对照:把一处已闭合的复合外键退回单列 ⇒ 判据必须当场红,并点名。
 */
export function revertedCompositeKeyControl(schemaText: string = readSchemaText()): {
  changed: boolean;
  violations: AnchorViolation[];
} {
  const normalised = normaliseSchema(schemaText);
  const reverted = normalised.replace(CLOSED_RELATION_SNIPPET, REVERTED_RELATION_SNIPPET);
  return {
    changed: reverted !== normalised,
    violations: analyzeAnchorClosure(reverted).violations,
  };
}

/** 新建的同形状表(证明扫描面是**动态**的,不是写死的四张表名单)。 */
export const INJECTED_FUTURE_TABLE = `
model FutureAnchorTable {
  id         String @id @default(cuid())
  activityId String
  sessionId  String
  memberId   String
  positionId String

  activity Activity                @relation(fields: [activityId], references: [id], onDelete: Restrict)
  position ActivitySessionPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)
}
`;

/**
 * 反对照:新建一张同形状的表 ⇒ 判据必须也管得住。
 * 若把管辖范围写死成四张表的名单,`FutureAnchorTable` 会被一声不吭放过。
 */
export function futureTableControl(schemaText: string = readSchemaText()): AnchorViolation[] {
  return analyzeAnchorClosure(`${schemaText}\n${INJECTED_FUTURE_TABLE}`).violations.filter(
    (violation) => violation.model === 'FutureAnchorTable',
  );
}

// ============================================================================
// 规则 ② 的变异对拍:四个维度,各自一条
//
// ⚠️ 调用方**必须把每一维放进各自的 `it`** —— jest 在一个 `it` 内首个失败即停,
//    塞在一起时后面几条从未被执行,而这在基线全绿时完全看不出来
//    (`docs/ai-harness/TOOL_TRAPS.md` §6.1)。
// ============================================================================

/** 被测的那一条改号锁 —— 变异对拍的靶子。 */
const LOCKED_RELATION_SNIPPET =
  'position ActivitySessionPosition? @relation(fields: [positionId, activityId, sessionId], references: [id, activityId, sessionId], onDelete: Restrict, onUpdate: Restrict)';

const UNLOCKED_RELATION_SNIPPET =
  'position ActivitySessionPosition? @relation(fields: [positionId, activityId, sessionId], references: [id, activityId, sessionId], onDelete: Restrict)';

/** 前置:被测的那处**当下确实上着锁**(否则下面的变异是空变异)。 */
export function lockedRelationIsPresent(schemaText: string = readSchemaText()): boolean {
  return normaliseSchema(schemaText).includes(LOCKED_RELATION_SNIPPET);
}

/**
 * 正对照:摘掉一条 `onUpdate: Restrict` ⇒ 判据必须当场红,并点名到表 + 关系。
 *
 * ⚠️ 只否定被测的那一维:`fields` / `references` / `onDelete` 一律不动 ⇒
 *    规则 ① 的闭合断言不受影响,红的只可能是规则 ②(TOOL_TRAPS §7.2)。
 */
export function droppedUpdateLockControl(schemaText: string = readSchemaText()): {
  changed: boolean;
  leaks: RenumberingLeak[];
} {
  const normalised = normaliseSchema(schemaText);
  const mutated = normalised.replace(LOCKED_RELATION_SNIPPET, UNLOCKED_RELATION_SNIPPET);
  return { changed: mutated !== normalised, leaks: findRenumberingLeaks(parsePrismaModels(mutated)) };
}

/**
 * 触发器豁免路径在做功的证据:把触发器索引清空 ⇒ 靠触发器过关的那两张表**必须**变红。
 *
 * 没有这一条,`readImmutabilityTriggers()` 恒返回一张「什么都算保护」的表也一样全绿。
 */
export function triggerlessFrozenControl(schemaText: string = readSchemaText()): RenumberingLeak[] {
  return findRenumberingLeaks(parsePrismaModels(schemaText), new Map());
}

/** 新建的冻结记录表(证明规则 ② 的扫描面也是**动态**的,不是四张表的名单)。 */
export const INJECTED_FUTURE_FROZEN_TABLE = `
model FutureFrozenRoster {
  id         String   @id @default(cuid())
  activityId String
  sessionId  String
  memberId   String
  positionId String
  createdAt  DateTime @default(now())

  activity Activity                @relation(fields: [activityId], references: [id], onDelete: Restrict)
  session  ActivitySession         @relation(fields: [activityId, sessionId], references: [activityId, id], onDelete: Restrict)
  position ActivitySessionPosition @relation(fields: [positionId, activityId, sessionId], references: [id, activityId, sessionId], onDelete: Restrict)
}
`;

/**
 * 反对照:一张全新的、谁也没登记过的冻结记录表 ⇒ 规则 ② 必须也管得住。
 */
export function futureFrozenTableControl(schemaText: string = readSchemaText()): RenumberingLeak[] {
  const models = parsePrismaModels(`${schemaText}\n${INJECTED_FUTURE_FROZEN_TABLE}`);
  return findRenumberingLeaks(models).filter((leak) => leak.model === 'FutureFrozenRoster');
}

/**
 * 具名触发器保护表里**没被触发器索引认出来**的那些;空数组 = 全部认出来了。
 *
 * 结论算在这里而不是 spec 里:遍历名单、判「认没认出来」都是判定口径的一部分,
 * 放进 spec 就等于把它挪出 selfGuard(`scripts/check-criteria-spec-purity.ts` 的
 * `control-flow` 规则实测当场点名过这一处)。
 */
export function unrecognisedTriggerTables(report: AnchorClosureReport): string[] {
  return NAMED_TRIGGER_PROTECTED_TABLES.filter(
    (table) => (report.immutabilityTriggers.get(table) ?? []).length === 0,
  );
}

/** 触发器索引里的条目总数 —— spec 侧不必自己 flat,少一层可被改松的算法。 */
export function immutabilityTriggerCount(report: AnchorClosureReport): number {
  return [...report.immutabilityTriggers.values()].flat().length;
}

/** 塞进白名单做防腐自证用的假条目 —— 指着一张**不存在的表**。 */
export const BOGUS_EXEMPTION: AnchorExemption = {
  model: 'NoSuchModelDoesNotExistAnywhere',
  relation: 'noSuchRelation',
  reason: '防腐自证专用的假条目:它指的模型根本不存在,`staleExemptions` 必须当场报出来。',
};

/**
 * 防腐自证:往白名单塞一条指着不存在的表的豁免 ⇒ 必须被 `staleExemptions` 抓到。
 *
 * 这补的是本仓已登记的事故形状(#1184):**豁免名单指着已删掉的东西,
 * 不生效、不报错、不改判定、没有任何机器发现它烂了**。
 * 原先只有「当前名单是干净的」这条断言 —— 那在 `staleExemptions` 被改成恒返回 `[]`
 * 时也照样全绿。
 */
export function bogusExemptionControl(report: AnchorClosureReport): string[] {
  return staleExemptions(report, [...ANCHOR_CLOSURE_EXEMPTIONS, BOGUS_EXEMPTION]);
}

/** 自证:仪器没瞎才报数。返回空数组 = 自证通过。 */
export function selfCheck(report: AnchorClosureReport): string[] {
  const problems: string[] = [];

  if (report.models.size <= MIN_PARSED_MODELS) {
    problems.push(`schema 解析塌了:只解析出 ${report.models.size} 个模型,地板是 >${MIN_PARSED_MODELS}。`);
  }
  if (report.holders.length < MIN_ANCHOR_HOLDERS) {
    problems.push(
      `管辖面塌了:只找到 ${report.holders.length} 个多锚点模型,地板是 ${MIN_ANCHOR_HOLDERS}。`,
    );
  }
  if (report.inspectedRelations < MIN_INSPECTED_RELATIONS) {
    problems.push(
      `检查过的 to-one 关系只有 ${report.inspectedRelations} 条,地板是 ${MIN_INSPECTED_RELATIONS} —— 判据在空转。`,
    );
  }
  for (const table of NAMED_ANCHOR_TABLES) {
    if (!report.holders.some((model) => model.name === table)) {
      problems.push(`具名表 ${table} 掉出了管辖面 —— 锚点识别逻辑坏了。`);
    }
  }
  if (!closedRelationIsPresent()) {
    problems.push('正对照的前置不成立:被测的那处复合外键当下不是闭合的 ⇒ 变异会变成空变异。');
  }

  // --- 规则 ② 的自证 ---
  if (report.scannedMigrations < MIN_SCANNED_MIGRATIONS) {
    problems.push(
      `migration 扫描面塌了:只看到 ${report.scannedMigrations} 个 migration 目录,` +
        `地板是 ${MIN_SCANNED_MIGRATIONS}。`,
    );
  }
  const triggerCount = [...report.immutabilityTriggers.values()].flat().length;
  if (triggerCount < MIN_IMMUTABILITY_TRIGGERS) {
    problems.push(
      `BEFORE UPDATE 触发器索引塌了:只认出 ${triggerCount} 条,地板是 ${MIN_IMMUTABILITY_TRIGGERS}` +
        ' —— 是扫描器坏了,不是仓库真的把触发器删光了。',
    );
  }
  for (const table of NAMED_TRIGGER_PROTECTED_TABLES) {
    if ((report.immutabilityTriggers.get(table) ?? []).length === 0) {
      problems.push(`具名表 ${table} 的 BEFORE UPDATE 触发器没被认出来 —— 触发器豁免路径失明。`);
    }
  }
  for (const table of NAMED_FROZEN_ANCHOR_TABLES) {
    if (!report.frozenHolders.some((model) => model.name === table)) {
      problems.push(`具名表 ${table} 掉出了冻结记录管辖面 —— isFrozenRecord 判据坏了。`);
    }
  }
  if (!lockedRelationIsPresent()) {
    problems.push('改号锁正对照的前置不成立:被测的那处当下没上 onUpdate: Restrict ⇒ 空变异。');
  }
  if (bogusExemptionControl(report).length === 0) {
    problems.push(
      '豁免防腐自证失效:往名单里塞一条**指着不存在的表**的豁免,staleExemptions 竟然没报出来' +
        ' —— 那说明「豁免过期即红」这条检查已经不会红了(#1184 的形状)。',
    );
  }

  return problems;
}

function main(): void {
  const report = analyzeAnchorClosure();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  for (const violation of report.violations) {
    console.error(`🔴 ${describeViolation(violation)}`);
  }
  for (const stale of staleExemptions(report)) {
    console.error(`🔴 豁免已过期(不再对应任何真实违规,应删掉):${stale}`);
  }
  for (const leak of report.renumberingLeaks) {
    console.error(`🔴 冻结记录的改号锁缺失:\n${describeRenumberingLeak(leak)}`);
  }

  const broken =
    problems.length +
    report.violations.length +
    staleExemptions(report).length +
    report.renumberingLeaks.length;
  if (broken === 0) {
    console.log(
      `✓ 多锚点表的同链外键全部闭合(${report.holders.length} 个多锚点模型 / ` +
        `${report.inspectedRelations} 条 to-one 关系)。`,
    );
    console.log(
      `✓ 冻结记录的复合外键全部锁住改号(${report.frozenHolders.length} 张冻结多锚点表 / ` +
        `${report.inspectedFrozenComposites} 条复合外键 / ` +
        `${[...report.immutabilityTriggers.values()].flat().length} 条 BEFORE UPDATE 触发器 / ` +
        `扫过 ${report.scannedMigrations} 个 migration)。`,
    );
  } else {
    console.error(
      '\n规则 ① 修法二选一:' +
        '\n  1) 把缺失的锚点列加进 @relation 的 fields/references(并在被引用侧补 @@unique);' +
        '\n  2) 确属正确的单列外键 ⇒ 加进 ANCHOR_CLOSURE_EXEMPTIONS,并写明**指向权威源**的理由。' +
        '\n规则 ② 修法二选一(冻结记录 = 有 createdAt 无 updatedAt):' +
        '\n  1) 给那条复合外键补 `onUpdate: Restrict`,并同 PR 加一条 DROP+ADD CONSTRAINT 的 migration;' +
        '\n  2) 给那张表建 BEFORE UPDATE 触发器(级联下来的 UPDATE 同样会被它挡掉)。' +
        '\n  ⚠️ 本规则**没有白名单** —— 要放宽只能改这个文件本身,而它在红区 selfGuard 内。',
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
