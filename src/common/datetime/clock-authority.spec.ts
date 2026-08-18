import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// ===== 统一时间权威 —— 「写用库时钟、判用应用时钟」这一**缺陷类**的执行位 =====
//
// 缺陷类定义:**同一个业务事实,写入时刻用一个时钟,判定时刻用另一个时钟。**
//
// 后果不是「差几毫秒」,而是**判定可能恒假**:`availableAt`(库钟)`<= now`(应用钟)
// 在库钟持续快于应用钟时永不成立 ⇒ 任务永不可领;任期 `startedAt <= now` 同理 ⇒ 刚发的
// 角色在判权侧「尚未生效」。没有报错、没有异常,只是「什么都不发生」—— 最难查的一类。
//
// 本 spec 不修实例,它让这个类**长不回来**。三道断言:
//
//   ① 完整性硬闸:`prisma/schema.prisma` 里每一个非审计的 `@default(now())` 列,必须**要么**
//      登记在 CLOCK_CRITICAL_COLUMNS(参与判定),**要么**登记在 NOT_CLOCK_CRITICAL(不参与,
//      附理由)。清单从 schema **反推**,不写「恰 N 条」—— 本仓栽过:少登记一条不产生坏链接,
//      既有守护看不见它。新加一个 `@default(now())` 列 ⇒ 本条当场红,逼人做一次决定。
//
//   ② 判定点仍在:每条登记项声明自己的判定点(文件 + 判定表达式原文 + 时钟来源)。判定点
//      被删/被改写 ⇒ 红。防的是「把判定悄悄换成库时钟、登记表还写着应用时钟」。
//
//   ③ 写侧显式:登记列所在的每一个 `create / createMany / upsert` 写点,其**每一个行对象**
//      都必须显式写出该列,且值表达式与登记表逐字一致。
//      - 漏写 ⇒ 吃 DB 的 `@default(now())`(库时钟)⇒ 红,失败信息给出 file:line。
//      - 改写成别的表达式 ⇒ 登记表对不上 ⇒ 红,逼人把新的时钟来源写进登记表。
//      - 新增写点 ⇒ 不在登记表 ⇒ 红。
//      判据走 TypeScript AST,不是文本匹配 ⇒ 注释里写 `availableAt: now` 骗不过它
//      (「剥注释」在 AST 下是天然的,而不是一个可能写错的正则)。
//
// ⚠️ 不覆盖 127 个 `@default(now())` 中的 113 个 `createdAt`:它们是审计列,无人拿来判定,
//    纳入只会扩大爆炸半径。这条豁免本身由 ① 的 AUDIT_COLUMNS 具名声明,不是隐式跳过。

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA = path.join(REPO_ROOT, 'prisma', 'schema.prisma');
const SRC = path.join(REPO_ROOT, 'src');

/** 审计列:只被展示/审计,从不参与判定。豁免必须具名,不能靠「看起来像 createdAt」。 */
const AUDIT_COLUMNS: ReadonlySet<string> = new Set(['createdAt']);

interface WriteSite {
  /** 仓库相对路径 */
  readonly file: string;
  /** 该列在 data 行对象里的值表达式**原文**(AST 打印后的规范形态) */
  readonly valueExpr: string;
  /** 这个表达式取的是哪个时钟 —— 人写的,机器只保证它与代码同步 */
  readonly clockSource: string;
}

interface ClockCriticalColumn {
  readonly model: string;
  /** Prisma delegate(camelCase),写点扫描按它匹配 */
  readonly delegate: string;
  readonly column: string;
  readonly judge: {
    /** 仓库相对路径 */
    readonly file: string;
    /** 判定表达式原文;必须在该文件剥注释后逐字出现 */
    readonly marker: string;
    readonly clock: 'application';
  };
  readonly writeSites: readonly WriteSite[];
}

// ---------------------------------------------------------------------------
// 登记表 ①:参与判定的时间列
// ---------------------------------------------------------------------------
const CLOCK_CRITICAL_COLUMNS: readonly ClockCriticalColumn[] = [
  {
    model: 'ActivityBatchJob',
    delegate: 'activityBatchJob',
    column: 'availableAt',
    judge: {
      file: 'src/modules/activities/activity-batch.worker.ts',
      marker: `("statusCode" = 'pending' AND "availableAt" <= \${now})`,
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/modules/activities/correction-application.service.ts',
        valueExpr: 'now',
        clockSource: '同方法内 const now = new Date()(应用时钟)',
      },
      {
        file: 'src/modules/activity-registrations/registration-reconciliation.service.ts',
        valueExpr: 'now',
        clockSource: '由 ActivityBatchWorker 传入本轮的应用时钟(本刀之前唯一已经写对的一处)',
      },
      {
        file: 'src/modules/activities/ledger-preparation.service.ts',
        valueExpr: 'availableAt',
        clockSource:
          '同方法内 const availableAt = new Date((options.now ?? new Date()).getTime() + 1);' +
          ' options.now 由 ActivityBatchWorker 传入 = 判定用的那个应用时钟,+1ms 是两轮协议的显式表达',
      },
      {
        file: 'src/modules/activities/settlement-draft-dispatch.service.ts',
        valueExpr: 'now',
        clockSource: '同方法内 const now = new Date()(应用时钟)',
      },
      {
        file: 'src/modules/attendances/attendance-import-preview.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(入队即可领)',
      },
      {
        file: 'src/modules/attendances/attendance-import-preview.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(入队即可领)',
      },
      {
        file: 'src/modules/attendances/attendance-onsite-batch-job.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(入队即可领)',
      },
    ],
  },
  {
    model: 'StorageObjectOperation',
    delegate: 'storageObjectOperation',
    column: 'availableAt',
    judge: {
      file: 'src/modules/storage/storage-object-ledger.service.ts',
      marker: `(op."status" = 'pending' AND op."availableAt" <= \${now})`,
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/modules/attachments/attachment-content-boundary.ts',
        valueExpr: 'availableAt',
        clockSource: '由 unboundExpiresAt 与应用时钟 now 取较晚者(见同文件 const availableAt)',
      },
      {
        file: 'src/modules/attachments/attachment-manual-intake.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟',
      },
      {
        file: 'src/modules/attachments/attachment-reconciliation.service.ts',
        valueExpr: 'now',
        clockSource: '同方法内应用时钟 now',
      },
      {
        file: 'src/modules/attachments/attachment-storage-orchestrator.ts',
        valueExpr: 'now',
        clockSource: '同方法内应用时钟 now',
      },
      {
        file: 'src/modules/storage/storage-object-ledger.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟',
      },
      {
        file: 'src/modules/storage/storage-object-ledger.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟',
      },
    ],
  },
  {
    model: 'NotificationOutboxIntent',
    delegate: 'notificationOutboxIntent',
    column: 'availableAt',
    judge: {
      file: 'src/modules/notifications/notification-outbox.service.ts',
      marker: `AND "availableAt" <= \${now}`,
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/modules/notifications/notification-outbox.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(enqueue)',
      },
      {
        file: 'src/modules/notifications/notification-outbox.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(enqueueMany)',
      },
      {
        file: 'src/modules/notifications/notification-outbox.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(active-slot 重试)',
      },
      {
        file: 'src/modules/notifications/notification-outbox.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(admin SMS 槽位)',
      },
    ],
  },
  {
    model: 'RoleBinding',
    delegate: 'roleBinding',
    column: 'startedAt',
    judge: {
      file: 'src/modules/authz/authz.service.ts',
      marker: 'isWithinTerm(b.startedAt, b.endedAt, now)',
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/local-activity-frontend-fixture.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(本地夹具)',
      },
      {
        file: 'src/modules/activities/activity-responsibility-grant-projector.ts',
        valueExpr: 'args.now',
        clockSource: '调用方传入的应用时钟',
      },
      {
        file: 'src/modules/role-bindings/role-bindings.service.ts',
        valueExpr: 'startedAt',
        clockSource: '同方法内 dto.startedAt(用户显式指定)?? new Date()(应用时钟)',
      },
      {
        file: 'src/modules/permissions/user-roles.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟',
      },
    ],
  },
  {
    model: 'MemberOrganizationMembership',
    delegate: 'memberOrganizationMembership',
    column: 'startedAt',
    judge: {
      file: 'src/modules/activities/activity-initiation-policy.ts',
      marker: 'startedAt: { lte: now },',
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/local-activity-frontend-fixture.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟(本地夹具)',
      },
      {
        file: 'src/modules/member-departments/member-departments.service.ts',
        valueExpr: 'startedAt',
        clockSource: '同方法内 const startedAt = new Date()(应用时钟)',
      },
      {
        file: 'src/modules/member-departments/memberships.service.ts',
        valueExpr: 'startedAt',
        clockSource: '同方法内 startedAt(应用时钟)',
      },
      {
        file: 'src/modules/member-departments/memberships.service.ts',
        valueExpr: 'now',
        clockSource: '同方法内应用时钟 now(调岗)',
      },
      {
        file: 'src/modules/recruitment/recruitment-promotion.service.ts',
        valueExpr: 'new Date()',
        clockSource: '应用时钟',
      },
      {
        file: 'src/modules/team-join/team-join-enrollment.service.ts',
        valueExpr: 'now',
        clockSource: '同方法内应用时钟 now',
      },
    ],
  },
  {
    model: 'ActivityResponsibilityAssignment',
    delegate: 'activityResponsibilityAssignment',
    column: 'startedAt',
    judge: {
      file: 'src/modules/authz/authz.service.ts',
      marker: 'isWithinTerm(a.startedAt, a.endedAt, now)',
      clock: 'application',
    },
    writeSites: [
      {
        file: 'src/modules/activities/activity-responsibility.service.ts',
        valueExpr: 'args.now',
        clockSource: '调用方传入的应用时钟(owner)',
      },
      {
        file: 'src/modules/activities/activity-responsibility.service.ts',
        valueExpr: 'args.now',
        clockSource: '调用方传入的应用时钟(collaborator)',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 登记表 ②:判定只拿它和**自己同列的兄弟行**比,不与任何墙钟比 —— 单一权威即可,
// 于是正确性条件不是「显式写」而是「**所有写点用同一个来源**」。
//
// 本仓当前这类只有一条:候补排位 `registeredAt ASC, id ASC`。三个写点齐齐吃 DB 默认值 ⇒
// 全队列同一个库时钟,排序自洽。⚠️ 一旦**任一**写点改成显式写应用时钟,同一条队列里就出现
// 两个权威,先来的可能排到后面 —— 所以这里的执行位是反过来的:**不许任何写点显式写**。
// 真要改成应用时钟,得三处一起改,并把本条移进 CLOCK_CRITICAL_COLUMNS。
// ---------------------------------------------------------------------------
const UNIFORM_DB_DEFAULT_COLUMNS: readonly Omit<ClockCriticalColumn, 'writeSites'>[] = [
  {
    model: 'ActivityRegistration',
    delegate: 'activityRegistration',
    column: 'registeredAt',
    judge: {
      file: 'src/modules/activity-registrations/activity-registration-waitlist-query.service.ts',
      marker: '{ registeredAt: { lt: row.registeredAt } },',
      clock: 'application',
    },
  },
];

// ---------------------------------------------------------------------------
// 登记表 ②:非审计但**不参与判定**的 `@default(now())` 列 —— 显式豁免,附理由
// ---------------------------------------------------------------------------
const NOT_CLOCK_CRITICAL: ReadonlyArray<{
  readonly model: string;
  readonly column: string;
  readonly why: string;
}> = [
  {
    model: 'ActivityPublishReview',
    column: 'submittedAt',
    why: '只被展示,以及按用户传入的 submittedFrom/submittedTo 过滤;不与任何时钟比较',
  },
  {
    model: 'AttendanceSheet',
    column: 'submittedAt',
    why: '只被展示与按用户传入区间过滤;不与任何时钟比较',
  },
  { model: 'Attachment', column: 'uploadedAt', why: '只被展示与审计,不参与任何判定' },
  { model: 'MemberAudienceTagAssignment', column: 'assignedAt', why: '只被展示,不参与任何判定' },
  { model: 'WecomIdentity', column: 'boundAt', why: '只被展示与审计,不参与任何判定' },
  {
    model: 'ThrottlerBucket',
    column: 'windowExpiresAt',
    why: '写与判在**同一条 SQL** 内完成,基线是该语句的 clock_timestamp() —— 单一权威,不存在跨时钟',
  },
  {
    model: 'ThrottlerBucket',
    column: 'retentionAt',
    why: '同 windowExpiresAt:写与判同在一条 SQL 的 clock_timestamp() 基线上',
  },
];

// ---------------------------------------------------------------------------
// schema 解析(纯函数 —— 阳性对照可以直接喂字符串)
// ---------------------------------------------------------------------------
export function parseDefaultNowColumns(
  schemaSource: string,
): Array<{ model: string; column: string }> {
  const out: Array<{ model: string; column: string }> = [];
  let model: string | null = null;
  for (const raw of schemaSource.split('\n')) {
    const line = raw.trim();
    const modelStart = /^model\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
    if (modelStart) {
      model = modelStart[1];
      continue;
    }
    if (line === '}') {
      model = null;
      continue;
    }
    if (model === null || !line.includes('@default(now())')) continue;
    const column = /^([A-Za-z0-9_]+)/.exec(line);
    if (column) out.push({ model, column: column[1] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写点扫描(TypeScript AST)
// ---------------------------------------------------------------------------
const WRITE_METHODS: ReadonlySet<string> = new Set(['create', 'createMany', 'upsert']);

export interface DiscoveredWrite {
  readonly file: string;
  readonly line: number;
  readonly delegate: string;
  /** 该行对象里该列的值表达式;缺失时为 null */
  readonly valueExpr: string | null;
  /** 行对象里存在无法静态展开的 spread */
  readonly hasSpread: boolean;
}

/**
 * 从 `data` / `create` 的值表达式里取出**行对象**。
 *
 * 只取「最外层」的对象字面量:遇到对象字面量即收下且**不再往里走** —— 于是
 * `[{…}]`、`xs.map((x) => ({…}))`、`cond ? {…} : {…}` 都能取到行,而 `payload: {…}`
 * 这类行内嵌套对象不会被误当成行。
 */
function collectRowObjects(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const walk = (current: ts.Node): void => {
    if (ts.isObjectLiteralExpression(current)) {
      out.push(current);
      return;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return out;
}

function propertyValue(
  row: ts.ObjectLiteralExpression,
  column: string,
): { found: true; expr: ts.Node | null } | { found: false } {
  for (const property of row.properties) {
    const name = property.name;
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      name !== undefined &&
      (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
      name.text === column
    ) {
      return { found: true, expr: ts.isPropertyAssignment(property) ? property.initializer : null };
    }
  }
  return { found: false };
}

/** 扫一份源码,返回该 delegate 上所有写点里 `column` 的落点。 */
export function scanWrites(
  fileLabel: string,
  source: string,
  delegate: string,
  column: string,
): DiscoveredWrite[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  const out: DiscoveredWrite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression;
      const targetName = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isIdentifier(target)
          ? target.text
          : null;
      if (WRITE_METHODS.has(method) && targetName === delegate) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          const dataKey = method === 'upsert' ? 'create' : 'data';
          for (const property of argument.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isIdentifier(property.name) ||
              property.name.text !== dataKey
            ) {
              continue;
            }
            for (const row of collectRowObjects(property.initializer)) {
              const hit = propertyValue(row, column);
              out.push({
                file: fileLabel,
                line: sourceFile.getLineAndCharacterOfPosition(row.getStart(sourceFile)).line + 1,
                delegate,
                valueExpr: !hit.found
                  ? null
                  : hit.expr === null
                    ? column
                    : printer
                        .printNode(ts.EmitHint.Unspecified, hit.expr, sourceFile)
                        .replace(/\s+/g, ' ')
                        .trim(),
                hasSpread: row.properties.some((p) => ts.isSpreadAssignment(p)),
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listProductionTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const PRODUCTION_FILES: ReadonlyArray<{ rel: string; source: string }> = listProductionTsFiles(SRC)
  .map((full) => ({
    rel: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
    source: fs.readFileSync(full, 'utf8'),
  }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

function discoverAll(entry: Omit<ClockCriticalColumn, 'writeSites'>): DiscoveredWrite[] {
  return PRODUCTION_FILES.filter(({ source }) => source.includes(`${entry.delegate}.`))
    .flatMap(({ rel, source }) => scanWrites(rel, source, entry.delegate, entry.column))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

describe('统一时间权威 —— 「写用库时钟、判用应用时钟」缺陷类的执行位', () => {
  // ===== ① 完整性硬闸:登记表从 schema 反推,不写「恰 N 条」 =====
  it('①schema 里每个非审计的 @default(now()) 列都已做过一次决定(判定列 / 显式豁免)', () => {
    const declared = parseDefaultNowColumns(fs.readFileSync(SCHEMA, 'utf8')).filter(
      ({ column }) => !AUDIT_COLUMNS.has(column),
    );
    const key = (model: string, column: string): string => `${model}.${column}`;
    const registered = new Set([
      ...CLOCK_CRITICAL_COLUMNS.map((e) => key(e.model, e.column)),
      ...UNIFORM_DB_DEFAULT_COLUMNS.map((e) => key(e.model, e.column)),
      ...NOT_CLOCK_CRITICAL.map((e) => key(e.model, e.column)),
    ]);

    const unregistered = declared
      .map(({ model, column }) => key(model, column))
      .filter((k) => !registered.has(k));
    expect({ '未登记的时间列': unregistered }).toEqual({ '未登记的时间列': [] });

    // 反向:登记表里不许有 schema 已不存在的列(改名/删列后留下的死条目)
    const declaredKeys = new Set(declared.map(({ model, column }) => key(model, column)));
    const stale = [...registered].filter((k) => !declaredKeys.has(k));
    expect({ 'schema 中已不存在的登记项': stale }).toEqual({ 'schema 中已不存在的登记项': [] });

    // 三张登记表两两互斥:同一列只能有一种处置
    const all = [
      ...CLOCK_CRITICAL_COLUMNS.map((e) => key(e.model, e.column)),
      ...UNIFORM_DB_DEFAULT_COLUMNS.map((e) => key(e.model, e.column)),
      ...NOT_CLOCK_CRITICAL.map((e) => key(e.model, e.column)),
    ];
    const duplicated = all.filter((k, i) => all.indexOf(k) !== i);
    expect({ '被多张登记表同时收录': duplicated }).toEqual({ '被多张登记表同时收录': [] });
  });

  // ===== ② 判定点仍在 =====
  const JUDGED = [...CLOCK_CRITICAL_COLUMNS, ...UNIFORM_DB_DEFAULT_COLUMNS];
  it.each(JUDGED.map((e) => [`${e.model}.${e.column}`, e] as const))(
    '②%s 的判定点仍在登记的位置上,且仍读应用时钟',
    (_label, entry) => {
      const full = path.join(REPO_ROOT, entry.judge.file);
      expect(fs.existsSync(full)).toBe(true);
      const code = stripComments(fs.readFileSync(full, 'utf8'));
      // 判定表达式必须在**代码**里逐字出现(注释已剥离 ⇒ 注释里写一遍骗不过)
      expect({ file: entry.judge.file, marker: code.includes(entry.judge.marker) }).toEqual({
        file: entry.judge.file,
        marker: true,
      });
    },
  );

  // ===== ③ 写侧显式,且值表达式与登记表逐字一致 =====
  it.each(CLOCK_CRITICAL_COLUMNS.map((e) => [`${e.model}.${e.column}`, e] as const))(
    '③%s 的每个写点都显式写出该列(不吃 DB 默认),值表达式与登记表一致',
    (_label, entry) => {
      const discovered = discoverAll(entry);

      // 3a. 漏写 ⇒ 吃 `@default(now())`(库时钟)。这是缺陷类本体。
      const missing = discovered
        .filter((w) => w.valueExpr === null)
        .map((w) => `${w.file}:${w.line} 未显式写 ${entry.column} ⇒ 落到 DB @default(now())(库时钟)`);
      expect({ '吃了库时钟默认值的写点': missing }).toEqual({ '吃了库时钟默认值的写点': [] });

      // 3b. spread 无法静态核验来源 ⇒ 要求显式(有 3a 兜底时才允许)
      const spread = discovered
        .filter((w) => w.hasSpread && w.valueExpr === null)
        .map((w) => `${w.file}:${w.line}`);
      expect({ '只靠 spread 传入无法核验': spread }).toEqual({ '只靠 spread 传入无法核验': [] });

      // 3c. 写点集合 + 值表达式必须与登记表逐字对齐 ——
      //     新增写点 / 改写值表达式,都逼人回到登记表写下新的时钟来源。
      const actual = discovered.map((w) => `${w.file} → ${w.valueExpr ?? '(缺失)'}`).sort();
      const expected = entry.writeSites.map((s) => `${s.file} → ${s.valueExpr}`).sort();
      expect(actual).toEqual(expected);

      // 3d. 值表达式不得取库时钟
      const dbClock = discovered
        .filter((w) => w.valueExpr !== null && /now\(\)|authoritativeNow|\$queryRaw/.test(w.valueExpr))
        .map((w) => `${w.file}:${w.line} → ${w.valueExpr ?? ''}`);
      expect({ '值表达式取了库时钟': dbClock }).toEqual({ '值表达式取了库时钟': [] });
    },
  );

  // ===== ④ 单一权威列:反过来 —— **不许**任何写点显式写 =====
  it.each(UNIFORM_DB_DEFAULT_COLUMNS.map((e) => [`${e.model}.${e.column}`, e] as const))(
    '④%s 的所有写点齐齐吃同一个 DB 默认值(任一处显式写入即出现第二个权威)',
    (_label, entry) => {
      const discovered = discoverAll(entry);
      // 判定只与同列兄弟行比较 ⇒ 只要来源统一就自洽。破坏统一性的是「有的显式、有的不显式」。
      expect(discovered.length).toBeGreaterThan(0);
      const explicit = discovered
        .filter((w) => w.valueExpr !== null)
        .map(
          (w) =>
            `${w.file}:${w.line} 显式写了 ${entry.column}(=${w.valueExpr ?? ''})—— 同一队列出现两个时钟权威;` +
            '要改成应用时钟须三处一起改,并把本列移进 CLOCK_CRITICAL_COLUMNS',
        );
      expect({ '打破单一权威的写点': explicit }).toEqual({ '打破单一权威的写点': [] });
    },
  );

  // ===== ⑤ 反方向:**故意**用库时钟的那几处,不许被「统一成应用时钟」顺手改掉 =====
  //
  // 断点②-a(封场)不属于本缺陷类:封场比的是 `checkOutCloseAt` / `terminationCheckOutDeadline`,
  // 那是**用户排的日程**,不是任何时钟写的 —— 不存在「写用一个钟、判用另一个钟」。真实形态是
  // 「同一批日程列,第 1–10 站用应用钟判、第 11 站用库钟判」。
  //
  // 这里**不动**封场,理由是它的库时钟更强而不是更弱:`now()` 取事务开始时刻,全事务恒定,
  // 八步之间不会自己往前走,也不受进程钟漂影响(该理由写在 evidence-seal 的注释里)。
  // 改成应用时钟 = 主动降级;把 `authoritativeNow` 反向灌给上游十站 = 全仓时钟注入框架,
  // 本仓恒禁。于是这里只留一道**反向闸**:锁住这个选择,别让后来者拿「统一时间权威」当理由
  // 把它一并改掉 —— 那会把一个正确的决定当成缺陷来「修」。
  const SQL_CLOCK_BY_DESIGN: ReadonlyArray<{
    readonly file: string;
    readonly marker: string;
    readonly why: string;
  }> = [
    {
      file: 'src/modules/activities/evidence-seal.service.ts',
      marker: 'SELECT "workflowRevision", now() AS "authoritativeNow"',
      why: '封场八步共用一个「现在」= 事务开始时刻;抗进程钟漂,且八步之间不自走',
    },
    {
      file: 'src/modules/activities/activity-closure.service.ts',
      marker: 'now() AS "authoritativeNow"',
      why: '关账判定与封场同源,同一事务单一「现在」',
    },
    {
      file: 'src/modules/activities/activity-lifecycle.service.ts',
      marker: 'SELECT now() AS "authoritativeNow"',
      why: '生命周期推进与封场同源',
    },
  ];

  it.each(SQL_CLOCK_BY_DESIGN.map((e) => [e.file, e] as const))(
    '⑤%s 仍显式取库时钟(这是刻意的,不是本缺陷类的实例)',
    (_label, entry) => {
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, entry.file), 'utf8'));
      expect({ file: entry.file, '保留库时钟': code.includes(entry.marker) }).toEqual({
        file: entry.file,
        '保留库时钟': true,
      });
    },
  );

  // ===== 阳性对照:判据自己必须能红 =====
  // 不做正对照的结构断言等于没有 —— 下面三条各自把一种规避手法喂给同一套分析器。
  describe('阳性对照(判据自身的真阳性)', () => {
    it('正对照 A:写点漏写该列 ⇒ 分析器报缺失', () => {
      const mutated = `
        await tx.activityBatchJob.create({
          data: { jobTypeCode: 'x', statusCode: 'pending', total: 1 },
        });
      `;
      const found = scanWrites('fixture.ts', mutated, 'activityBatchJob', 'availableAt');
      expect(found).toHaveLength(1);
      expect(found[0].valueExpr).toBeNull();
    });

    it('正对照 B:该列只出现在注释里 ⇒ 分析器仍报缺失(AST 天然剥注释)', () => {
      const mutated = `
        await tx.activityBatchJob.create({
          // availableAt: now,
          data: { jobTypeCode: 'x' /* availableAt: now */, statusCode: 'pending' },
        });
      `;
      const found = scanWrites('fixture.ts', mutated, 'activityBatchJob', 'availableAt');
      expect(found).toHaveLength(1);
      expect(found[0].valueExpr).toBeNull();
    });

    it('正对照 C:createMany 里 map 出的行漏写 ⇒ 分析器逐行都能看到', () => {
      const mutated = `
        await tx.activityBatchJob.createMany({
          data: rows.map((row) => ({ jobTypeCode: row.kind, availableAt: now })),
        });
        await tx.activityBatchJob.createMany({
          data: [{ jobTypeCode: 'a' }, { jobTypeCode: 'b', availableAt: new Date() }],
        });
      `;
      const found = scanWrites('fixture.ts', mutated, 'activityBatchJob', 'availableAt');
      expect(found.map((w) => w.valueExpr)).toEqual(['now', null, 'new Date()']);
    });

    it('正对照 D:嵌套在 payload 里的同名键不算数(不能靠内层对象蒙混)', () => {
      const mutated = `
        await tx.activityBatchJob.create({
          data: { jobTypeCode: 'x', payload: { availableAt: 'nope' } },
        });
      `;
      const found = scanWrites('fixture.ts', mutated, 'activityBatchJob', 'availableAt');
      expect(found).toHaveLength(1);
      expect(found[0].valueExpr).toBeNull();
    });

    it('正对照 E:单一权威列被某个写点显式写入 ⇒ 分析器看得见那一处', () => {
      const mutated = `
        await tx.activityRegistration.create({
          data: { activityId: 'a', memberId: 'm', registeredAt: now },
        });
        await tx.activityRegistration.create({
          data: { activityId: 'b', memberId: 'n' },
        });
      `;
      const found = scanWrites('fixture.ts', mutated, 'activityRegistration', 'registeredAt');
      expect(found.map((w) => w.valueExpr)).toEqual(['now', null]);
    });

    it('正对照 F:schema 新增一个 @default(now()) 判定列 ⇒ 完整性闸看得见它', () => {
      const fixture = `
model Widget {
  id        String   @id
  createdAt DateTime @default(now())
  readyAt   DateTime @default(now())
}
`;
      const parsed = parseDefaultNowColumns(fixture).filter((c) => !AUDIT_COLUMNS.has(c.column));
      expect(parsed).toEqual([{ model: 'Widget', column: 'readyAt' }]);
    });
  });
});
