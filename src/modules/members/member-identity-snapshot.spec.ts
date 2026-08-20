import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// issue #1048 T4 · 历史身份快照盘点(§8 / §12)
//
// ── 盘点结论:**当前无需新增身份快照**,理由不是"没想到",而是下面三条实测事实 ──
//
//   ① 引用 member 的 31 个模型(34 条关系字段)里,**没有一个**持有队员姓名的副本 ——
//      全部只存 `memberId`,姓名由读侧 `select` 现取现渲染(唯一的例外是通知正文,
//      那是消息文本不是身份键)。计数是本次盘点的读数,判据**不依赖**它:
//      下面的 `offendersOf` 扫的是**全部**模型,比「引用 member 的那些」更宽,新增模型自动纳管。
//   ② 软删不影响历史渲染:软删只置 `deletedAt`,行仍在;结算/账本读 member 时不过滤软删,
//      姓名照样取得到。
//   ③ 硬删被结构性阻止:`ParticipationLedgerEntry.member` 等是**必填关系 + onDelete: Restrict**,
//      有历史分录时队员行根本删不掉。
//
//   ⇒ 身份**永久可达**。再建一份 `MemberIdentitySnapshotV1` 只会制造第二份可漂移的姓名,
//     而它要解决的问题(历史记录找不到人是谁)在本仓根本不成立。
//     issue §12 允许这一分支,前提是**写出盘点证据** —— 本文件就是那份证据的可执行形态。
//
// ── 为什么把结论写成判据,而不是写进文档 ────────────────────────────────────
// "我们盘点过、当时没有"是一句**会过期**的话:下一个人往结算表上加一列 `memberName`
// 做冗余展示,盘点结论就悄悄失效了,而没有任何东西会报错。
// 本判据把结论钉成「schema 上不得出现队员姓名的反规范化副本」——
// 真要加,必须先来改这里的白名单,那时才是一次**有意识**的决定。
//
// ⚠️ 本判据**不**声称「永远不需要快照」。它声称的是:**当下不需要,且新增副本必须显式过闸**。
// 若将来出现真实需求(例如已签发的法律文书要逐字复现),改白名单并在此写明理由即可。

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA = path.join(REPO_ROOT, 'prisma', 'schema.prisma');

/** 姓名类列名。`name` 不在内 —— 组织/职务/字典的 `name` 与队员身份无关,收进来会全是噪声。 */
const MEMBER_NAME_COLUMNS = ['realName', 'nickname', 'memberName', 'displayName', 'fullName'];

/**
 * 允许持有姓名类列的模型 —— 每一条都必须有理由。
 *
 * 这三个都**不是**「历史身份快照」:
 * - `Member`         —— 身份主档本体(活档,issue #1048 T1 之后的唯一日常事实源)
 * - `User`           —— `nickname` 是**登录昵称**,与 `Member.nickname`(队内外号)同名不同物
 * - `RecruitmentApplication` —— 申请人**入队前**自报的姓名;promote 后由 promote 事务清空脱敏,
 *                       它是报名链路的自有事实,不是队员身份的副本
 */
const NAME_COLUMN_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['Member', '身份主档本体(活档)'],
  ['User', 'nickname = 登录昵称,与 Member.nickname 同名不同物'],
  ['RecruitmentApplication', '申请人入队前自报姓名,promote 后清空脱敏'],
  // 下面两个的 `displayName` **不是队员姓名** —— issue #1048 T1 已机核确认它分属另外两个模型
  // (删掉 `Member.displayName` 后,这两个模块一个 TS 错都没报)。
  // 把它们登记在这里,顺带把那次归属结论永久钉住:`displayName` 这个名字在本仓
  // 曾同时属于三个模型,靠字段名搜索区分不了,已经张冠李戴过不止一次。
  ['RbacRole', 'displayName = 角色显示名,与队员无关(T1 机核确认)'],
  ['AttachmentTypeConfig', 'displayName = 附件类型显示名,与队员无关(T1 机核确认)'],
]);

interface ModelBlock {
  readonly name: string;
  readonly lines: readonly string[];
}

function parseModels(source: string): ModelBlock[] {
  const models: ModelBlock[] = [];
  const pattern = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let match = pattern.exec(source);
  while (match !== null) {
    models.push({ name: match[1], lines: match[2].split('\n') });
    match = pattern.exec(source);
  }
  return models;
}

/** 去掉行内注释后再判 —— 否则注释里提一句字段名就会被算成"有这列"。 */
function codeOf(line: string): string {
  const withoutComment = line.split('//')[0];
  return withoutComment.trim();
}

/** 判据本体:白名单外、且带姓名类列的模型。抽成函数是为了能对**它**做正对照。 */
function offendersOf(models: readonly ModelBlock[]): string[] {
  return models
    .map((model) => ({ model: model.name, columns: nameColumnsOf(model) }))
    .filter((row) => row.columns.length > 0 && !NAME_COLUMN_ALLOWLIST.has(row.model))
    .map((row) => `${row.model}.{${row.columns.join(',')}}`);
}

function nameColumnsOf(model: ModelBlock): string[] {
  const hits: string[] = [];
  for (const line of model.lines) {
    const code = codeOf(line);
    for (const column of MEMBER_NAME_COLUMNS) {
      // 只认「列声明」:行首就是列名 + 空白 + 类型。`@@index([realName])` / 关系行不算。
      if (new RegExp(`^${column}\\s+\\w`).test(code)) hits.push(column);
    }
  }
  return hits;
}

describe('issue #1048 T4 —— 历史身份快照盘点(结论:当前无需新增)', () => {
  const source = readFileSync(SCHEMA, 'utf-8');
  const models = parseModels(source);

  // ---- 自证 ①:解析器必须真的解析出模型,否则下面全是空绿 ----
  it('自证:schema 解析器解析出了足量模型,且认得出列声明', () => {
    expect(models.length).toBeGreaterThan(100);
    const member = models.find((model) => model.name === 'Member');
    expect(member).toBeDefined();
    expect(nameColumnsOf(member!)).toEqual(expect.arrayContaining(['realName', 'nickname']));
  });

  // ---- 自证 ②:探测器必须对「反规范化姓名副本」报阳 ----
  // 少了这条,下面那条阴性读数可能只是因为探测器什么都认不出来。
  // 这条正对照打在**判据本体** `offendersOf` 上,而不是只打在子探测器上:
  // 只证明"探测器认得出列"不足以说明"判据会红" —— 白名单那一步同样可能写反。
  it('自证:判据本体对合成的"结算表冗余姓名列"报阳', () => {
    const synthetic = parseModels(
      'model FakeSettlement {\n  id String @id\n  memberId String\n  memberName String\n}\n',
    );
    expect(nameColumnsOf(synthetic[0])).toEqual(['memberName']);
    // 白名单外 ⇒ 必须被判据本体列为 offender
    expect(offendersOf(synthetic)).toEqual(['FakeSettlement.{memberName}']);
  });

  it('自证:白名单内的同名列**不**被误报(否则判据会把主档本身判成违规)', () => {
    const synthetic = parseModels('model Member {\n  id String @id\n  realName String\n}\n');
    expect(offendersOf(synthetic)).toEqual([]);
  });

  it('自证:探测器不把 @@index / 关系行 / 注释误判成列声明', () => {
    const synthetic = parseModels(
      [
        'model FakeIndexOnly {',
        '  id String @id',
        '  // realName 只是注释里提了一句',
        '  member Member @relation(fields: [memberId], references: [id])',
        '  @@index([realName])',
        '}',
        '',
      ].join('\n'),
    );
    expect(nameColumnsOf(synthetic[0])).toEqual([]);
  });

  // ---- 真读数 ----
  it('🔴 全 schema 不得出现队员姓名的反规范化副本(白名单外一个都不许有)', () => {
    // 失败时把「是谁、加了哪列」直接说清楚 —— 判据的失败消息说错方向比不说更费人。
    expect(offendersOf(models)).toEqual([]);
  });

  it('白名单本身不得腐烂:登记的每个模型必须真实存在且确实带姓名列', () => {
    for (const [modelName] of NAME_COLUMN_ALLOWLIST) {
      const model = models.find((candidate) => candidate.name === modelName);
      expect(model).toBeDefined();
      expect(nameColumnsOf(model!).length).toBeGreaterThan(0);
    }
  });

  // ---- 盘点结论依赖的另外两条事实,同样钉住 ----
  it('账本分录到队员是**必填关系 + Restrict**(硬删被结构性阻止 ⇒ 身份永久可达)', () => {
    const ledger = models.find((model) => model.name === 'ParticipationLedgerEntry');
    expect(ledger).toBeDefined();
    const memberRelation = ledger!.lines.map(codeOf).find((line) => line.startsWith('member '));
    expect(memberRelation).toBeDefined();
    // 必填(无 `?`)+ Restrict:两者缺一,历史分录就可能失去它的人
    expect(memberRelation).toContain('Member ');
    expect(memberRelation).not.toContain('Member?');
    expect(memberRelation).toContain('onDelete: Restrict');
  });

  it('Member 用软删(deletedAt)而非硬删 —— 历史渲染仍取得到姓名', () => {
    const member = models.find((model) => model.name === 'Member');
    expect(member!.lines.map(codeOf).some((line) => line.startsWith('deletedAt '))).toBe(true);
  });
});
