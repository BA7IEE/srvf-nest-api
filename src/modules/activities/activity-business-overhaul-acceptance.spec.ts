import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 活动业务改造 v1.1 —— 验收编号骨架 + 合同完整性守护(第 0 批交付项)。
 *
 * 合同 §14「第0批」要求 AC / ADV 编号先以 `it.todo` 入仓,**不让 main 长期红**。
 * 但纯 todo 列表会与合同悄悄漂移,所以本文件的 todo **全部由合同原文解析生成**:
 * 合同里加一条 AC,这里的待办自动多一条;合同被改动,下面的 SHA256 断言当场红。
 *
 * 每批实现落地时:把对应 `it.todo` 换成真实用例(或在 e2e 里实现并在此标注去向),
 * **不是**把它删掉 —— 删 todo 等于让验收编号静默消失。
 */

const CONTRACT_DIR = 'docs/archive/reviews/activity-business-overhaul-v1.1';

function readContractFile(fileName: string): string {
  return readFileSync(resolve(process.cwd(), CONTRACT_DIR, fileName), 'utf8');
}

const BUSINESS_PLAN = 'SRVF_活动业务全流程修正方案_正式版_v1.1.md';
const MATRIX = 'SRVF_活动业务规则_355项追踪矩阵_v1.1.md';
const SHA256_MANIFEST = 'SRVF_活动业务文档_v1.1_SHA256.txt';

const businessPlan = readContractFile(BUSINESS_PLAN);
const matrix = readContractFile(MATRIX);

/**
 * 解析验收条目定义行:`- **AC-001**` 后跟一个全角空格(U+3000)再跟一句话。
 * 分隔符写成 `[^\S\n]*`(除换行外的空白)而非 `\s*` —— 后者会吃掉行尾换行,
 * 把下一行的正文当成本条的标题。
 */
function parseAcceptanceDefinitions(prefix: 'AC' | 'ADV'): { id: string; title: string }[] {
  const pattern = new RegExp(`^- \\*\\*(${prefix}-\\d{3})\\*\\*[^\\S\\n]*(.+)$`, 'gm');
  const found: { id: string; title: string }[] = [];
  for (const match of businessPlan.matchAll(pattern)) {
    found.push({ id: match[1], title: match[2].trim() });
  }
  return found;
}

const acceptanceCases = parseAcceptanceDefinitions('AC');
const adversarialCases = parseAcceptanceDefinitions('ADV');

function expectedIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);
}

/**
 * 第 2 批验收编号回填（合同开发文档 §14）。
 *
 * `destination` 不是把旧测试的标题抄过来：每一项都以 file + 真实断言片段绑定，下面的
 * 链接完整性用例会读目标 spec，目标用例被删/改名会红。未达到合同完整口径的一律仍为 todo，
 * 不能拿“覆盖了一半”凑完成数。
 */
interface AcceptanceDestination {
  file: string;
  needle: string;
}

const BATCH2_ACCEPTANCE_IDS = [
  ...Array.from({ length: 19 }, (_, index) => `AC-${String(index + 47).padStart(3, '0')}`),
  'ADV-001',
  'ADV-008',
  'ADV-009',
  'ADV-010',
  'ADV-011',
  'ADV-012',
  'ADV-020',
  'ADV-021',
  'ADV-022',
] as const;

const BATCH2_ACCEPTANCE_DESTINATIONS: Readonly<Record<string, readonly AcceptanceDestination[]>> = {
  // AC-048 → test/e2e/activity-settlement-review.e2e-spec.ts ›「四项比对(§5.11)」
  // 一审四种锚点差异都已逐项 red-first；终审同用该共享校验路径，见同 spec 的终审流程用例。
  'AC-048': [
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '证据 / 人口版本在送审后前进',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '活动流程版本在送审后前进',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '审核人看到的 contentHash 与版本行不一致',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '终审 return ⇒ 版本转 returned',
    },
  ],
  // AC-050 → test/e2e/activity-settlement-draft.e2e-spec.ts ›「改场次上的阈值…」
  'AC-050': [
    {
      file: 'test/e2e/activity-settlement-draft.e2e-spec.ts',
      needle: '改场次上的阈值 → 标签跟着变(15/15 → 都命中;30/60 → 都不命中)',
    },
  ],
  // AC-051 → draft 的 blocker 生成 + submit 的 blocker 硬门，未产生可终审版本。
  'AC-051': [
    {
      file: 'test/e2e/activity-settlement-draft.e2e-spec.ts',
      needle: 'present 且算出 0 分 → 必须带 blocker 标记',
    },
    {
      file: 'test/e2e/activity-settlement-submit.e2e-spec.ts',
      needle: '结果行带 blocker → SETTLEMENT_SUBMIT_MISSING_RULE',
    },
  ],
  // AC-052 → review 动作闭集 + ⑨a working draft 零 version 写 + returned 后新版本。
  'AC-052': [
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '第三种动作 → 20074',
    },
    {
      file: 'test/e2e/activity-batch2-9a-settlement-workbench.e2e-spec.ts',
      needle: 'PATCH working item 的 transaction 内 SettlementVersion 写次数恒为 0',
    },
    {
      file: 'test/e2e/activity-batch2-9a-settlement-workbench.e2e-spec.ts',
      needle: 'resubmit 在 returned 后创建新的 SettlementVersion，而不是复活旧版',
    },
  ],
  // AC-053 → review service 的锁后复判 + 第 ⑩ 刀入口层短路探针。
  'AC-053': [
    {
      file: 'test/e2e/activity-batch2-10-action-constraints.e2e-spec.ts',
      needle: '入口层独立：一审 approve / return 共用 action',
    },
    {
      file: 'test/e2e/activity-batch2-10-action-constraints.e2e-spec.ts',
      needle: '锁后层独立：直接调用 service 时，三方分离仍按 20062 / 20063 / 20064 拒绝',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '提交人不可一审自己提交的版本',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '提交人不可终审自己提交的版本',
    },
    {
      file: 'test/e2e/activity-settlement-review.e2e-spec.ts',
      needle: '一审人不可再终审同一版本',
    },
    {
      file: 'test/e2e/activity-settlement-review-concurrency.e2e-spec.ts',
      needle: '一审在终审等锁期间落地 ⇒ 终审锁后复判恒拒 20064',
    },
  ],
  // AC-059 → test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts › 两组 append-only trigger。
  'AC-059': [
    {
      file: 'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
      needle: 'ParticipationLedgerEntry append-only trigger 四条判据',
    },
    {
      file: 'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
      needle: 'AttendancePunchEvent:本刀加列 importJobItemId 之后 trigger 四条判据重跑',
    },
  ],
  // AC-062 → test/e2e/activity-settlement-closure.e2e-spec.ts ›「30 人通过、0 结果」。
  'AC-062': [
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: '30 人通过、0 结果 ⇒ 拒绝,且缺口清单里带着那个「30」',
    },
  ],
  // ADV-009 → test/e2e/activity-ledger-posting.e2e-spec.ts ›「item 打回 pending 再跑一次」。
  'ADV-009': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '把 item 打回 pending 再跑一次 ⇒ 分录、day rows 都不翻倍',
    },
  ],
  // ADV-020 → 与 AC-059 同源：直接 SQL UPDATE / DELETE 两类正式事实均被 trigger 拒绝。
  'ADV-020': [
    {
      file: 'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
      needle: 'ParticipationLedgerEntry append-only trigger 四条判据',
    },
    {
      file: 'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
      needle: 'AttendancePunchEvent:本刀加列 importJobItemId 之后 trigger 四条判据重跑',
    },
  ],
  // ADV-021 → test/e2e/activity-settlement-review-concurrency.e2e-spec.ts ›「approve 与 return 并发」。
  'ADV-021': [
    {
      file: 'test/e2e/activity-settlement-review-concurrency.e2e-spec.ts',
      needle: 'approve 与 return 并发同一版本同一阶段 ⇒ 恰好一个成功,败者 20072',
    },
  ],
};

const BATCH2_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  // AC-047:现有 submit 仅覆盖开放段；与最后一次合法签退并发的端到端链属于第 5 批 Punch。
  'AC-047': '卡第 5 批最后一次合法签退/窗口并发链；当前只覆盖开放服务段拒绝。',
  // AC-049:当前覆盖人口数量，不覆盖 absent 零时长不得进入有效服务明细的完整投影。
  'AC-049': '缺 absent 零时长结果到有效服务明细的端到端断言。',
  // AC-054:现有规模用例为 8192，未覆盖合同固定的 10000 人与 0%/100%读面组合。
  'AC-054': '缺 10000 人准备期间的 0%/100%读面规模用例；现有上限是 8192。',
  // AC-055:现有重放覆盖一次，不是终审、恢复、更正各 100 次。
  'AC-055': '缺终审、任务恢复和更正各重复 100 次的总额恒等测试。',
  // AC-056:现有用例覆盖同活动同日多场次，未覆盖多活动稳定分配顺序。
  'AC-056': '缺同一北京日多活动的稳定分配顺序与 capped-out 展示断言。',
  // AC-057:跨北京零点的服务段来自第 5 批 Punch 链，当前第 2 批夹具未生产该形态。
  'AC-057': '卡第 5 批跨北京零点 Punch/服务段链。',
  // AC-058:合同明确把 overlap 检查放在第 5 批的 member lock 内。
  'AC-058': '卡第 5 批 member lock 内的跨活动时间重叠拒绝。',
  // AC-060:#9 requestedChangeJson 结构尚未定义，且 absent/present 与评价资格联动未形成可验收形态。
  'AC-060': '卡已知合同缺口 #9 requestedChangeJson 结构，以及 absent/present×评价资格联动。',
  // AC-061:关闭 suite 已覆盖多个单点，但缺 pending correction 与未生效账同时纳入完整五项红集。
  'AC-061': '缺 pending correction、未生效账与其余关账缺口的完整五项红集。',
  // AC-063:已有 close×close；未有 close 与最后终审/更正的真实并发屏障。
  'AC-063': '缺关账×最后终审、关账×最后更正的 Activity-lock 并发用例。',
  // AC-064:archive action 读写入口尚未在本刀开放，现有仅证明等待期不是永久截止。
  'AC-064': '卡后续 archive action；现有仅覆盖归档等待期不是更正永久截止。',
  // AC-065:当前 feedback 从活动 endAt 起算，未有最新 ClosureRevision 及更正资格联动。
  'AC-065': '卡最新 ClosureRevision 为评价窗口锚点及更正后资格联动。',
  // ADV-001:同 AC-047，需第 5 批真实最后签退的并发入口。
  'ADV-001': '卡第 5 批结算提交×最后一次合法签退的真并发入口。',
  // ADV-008:合同点名六个 10000 条 kill/recover 检查点，现有 8192 规模 test 不等价。
  'ADV-008': '缺 10000 条在 1/199/200/201/9999/10000 检查点 kill/recover 演练。',
  // ADV-010:入队进度刷新与多活动记分尚无同一事务/并发集成能力。
  'ADV-010': '卡多活动记分×入队进度刷新的并发集成链。',
  // ADV-011:现有 partial unique 是串行覆盖，未有同 target 两个更正申请的真并发屏障。
  'ADV-011': '缺同一结算项两份更正申请的双实例真并发用例。',
  // ADV-012:与 AC-060 相同的未定请求结构及评价资格联动。
  'ADV-012': '卡已知合同缺口 #9 requestedChangeJson 结构与缺席转出勤后的评价联动。',
  // ADV-022:archive 未开放，且尚缺更正×关闭的双实例并发屏障。
  'ADV-022': '卡 archive action 与更正提交/生效×关账的真并发链。',
};

const batch2ResolvedIds = new Set([
  ...Object.keys(BATCH2_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH2_ACCEPTANCE_BLOCKERS),
]);
if (
  batch2ResolvedIds.size !== BATCH2_ACCEPTANCE_IDS.length ||
  BATCH2_ACCEPTANCE_IDS.some((id) => !batch2ResolvedIds.has(id)) ||
  Object.keys(BATCH2_ACCEPTANCE_DESTINATIONS).some((id) => BATCH2_ACCEPTANCE_BLOCKERS[id])
) {
  throw new Error('第 2 批 28 条验收编号必须逐条有已标注去向或明确阻塞说明');
}

/**
 * 第 3 批第一刀先完成草稿地基，第二刀再回填发布链。这里仍故意不把「已覆盖其中一小段」
 * 的总验收号提前结案：AC-009 等跨表单/资格/定位的整项仍留 todo；已完成的 root/session/
 * position 直写拒绝与发布审核证据可被后续刀复用。
 */
const BATCH3_SLICE1_ACCEPTANCE_IDS = [
  ...Array.from({ length: 15 }, (_, index) => `AC-${String(index + 1).padStart(3, '0')}`),
  'ADV-004',
  'ADV-017',
  'ADV-018',
  'ADV-019',
] as const;

const BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  // AC-001:真实发起人资格由 policy 兜底；本刀补上管理员代建时 actor 与 initiator
  // 分离、且草稿责任表零写的端到端锚点。
  'AC-001': [
    {
      file: 'src/modules/activities/activity-initiation-policy.spec.ts',
      needle: 'rejects non-formal grade %s',
    },
    {
      file: 'src/modules/activities/activity-initiation-policy.spec.ts',
      needle: 'rejects a formal member without an ACTIVE non-deleted User',
    },
    {
      file: 'test/e2e/activity-batch3-1-draft-foundation.e2e-spec.ts',
      needle:
        'keeps the delegated creator and the real formal initiator distinct while anchoring the draft on the latter',
    },
    {
      file: 'test/e2e/activity-batch3-1-draft-foundation.e2e-spec.ts',
      needle: 'actorUserId: delegatedCreator.userId',
    },
  ],
  // AC-002:policy 的 scope 成功路径与 App 入口的跨组织拒绝共同覆盖，不以“知道 id”替代授权。
  'AC-002': [
    {
      file: 'src/modules/activities/activity-initiation-policy.spec.ts',
      needle: 'accepts cross-org initiation when authz matches %s scope',
    },
    {
      file: 'test/e2e/app-managed-activities.e2e-spec.ts',
      needle: 'rejects an A-member moving a draft to B without cross-org grant',
    },
  ],
  // AC-006: V2 review keeps the same self-review ban for a SUPER_ADMIN and replays return safely.
  'AC-006': [
    {
      file: 'test/e2e/activity-batch3-2-publish-review.e2e-spec.ts',
      needle: 'makes return idempotent and rejects a SUPER_ADMIN reviewing their own proposal',
    },
  ],
  // AC-007: the state machine has no direct transition and the public compatibility route remains draft
  // until an independent review approval creates the owner projection.
  'AC-007': [
    {
      file: 'src/modules/activities/activity-publish-review-state-machine.spec.ts',
      needle: 'does not expose a direct-publish transition',
    },
    {
      file: 'test/e2e/app-managed-activities.e2e-spec.ts',
      needle:
        'converts direct-publish compatibility calls into review, then projects owner after approval',
    },
  ],
  // AC-008: the V2 approval path compares its frozen base snapshot against the locked current state.
  'AC-008': [
    {
      file: 'test/e2e/activity-batch3-2-publish-review.e2e-spec.ts',
      needle: 'rejects stale change proposals and leaves critical published fields behind review',
    },
  ],
};

const BATCH3_SLICE1_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-003': '卡第 3 刀 clone 生命周期端点；本刀不建 clone。',
  'AC-004': '卡第 3 刀 archive 生命周期读写；本刀不新增归档动作或定时任务。',
  'AC-005': '缺“报名截止清空后页面与数据库均不出现 1970 年”的 App 端到端读写断言。',
  'AC-009':
    '发布链已覆盖根活动展示白名单与 Session/Position proposal；表单、资格、可见性、签到和计分规则仍卡第 4/5 批，整项不能提前结案。',
  'AC-010':
    '本刀已覆盖单场次 create/update/cancel 的变更审核；容量桶、二维码、人员影响、通知与结算人口仍是第 4/5/7 批接缝，整项不能提前结案。',
  'AC-011': '卡第 3 刀普通活动可见性/可报名原因读面。',
  'AC-012': '卡第 3 刀邀请可见性读面。',
  'AC-013': '卡 S6：draft_editor 七值责任模型另立 D 档刀；本刀不给协作人草稿编辑能力。',
  'AC-014': '卡第 3 刀 cancel 与现场事实并发语义。',
  'AC-015': '卡第 3 刀 terminate 后 30 分钟签退窗口。',
  'ADV-004': '卡第 3 刀普通取消×第一条现场签到真实并发。',
  'ADV-017': '卡第 1 批 allocation/reservation 占用事实与第 2 刀已发布变更审核链。',
  'ADV-018': '卡第 2/3 刀单场次取消的人员和通知影响链。',
  'ADV-019': '卡第 3 刀正式/停用/非正式/未受邀可见性组合读面。',
};

/** 第 4 批④只翻有真实端到端命令链证据的编号；三入口统一校验仍不得提前结案。 */
const BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_IDS = ['AC-016', 'AC-017', 'AC-029'] as const;

const BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-016': [
    {
      file: 'test/e2e/activity-batch4-registration-command.e2e-spec.ts',
      needle:
        'creates the v1.1 immutable chain, transfers the file, then replays consumed-session retry by hash',
    },
    {
      file: 'test/e2e/activity-batch4-registration-command.e2e-spec.ts',
      needle: 'expectBizError(invalidAnswer, BizCode.REGISTRATION_FORM_ANSWER_INVALID);',
    },
  ],
  'AC-029': [
    {
      file: 'test/e2e/activity-batch4-registration-command.e2e-spec.ts',
      needle: "ownerType: 'registration-form-answer'",
    },
    {
      file: 'test/e2e/activity-batch4-registration-command.e2e-spec.ts',
      needle: 'expectBizError(foreignUse, BizCode.ATTACHMENT_NOT_FOUND);',
    },
  ],
};

const BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-017': '后台代报名与导入未接入本刀，三入口共享答案 validator 仍未实现。',
};

if (
  Object.keys(BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 4 批④验收编号不能同时登记已完成与阻塞');
}

const batch3Slice1ResolvedIds = new Set([
  ...Object.keys(BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH3_SLICE1_ACCEPTANCE_BLOCKERS),
]);
if (
  batch3Slice1ResolvedIds.size !== BATCH3_SLICE1_ACCEPTANCE_IDS.length ||
  BATCH3_SLICE1_ACCEPTANCE_IDS.some((id) => !batch3Slice1ResolvedIds.has(id)) ||
  Object.keys(BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH3_SLICE1_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 3 批已落地切片的 19 条验收编号必须逐条有已标注去向或明确阻塞说明');
}

const batch4RegistrationCommandResolvedIds = new Set([
  ...Object.keys(BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS),
]);
if (
  batch4RegistrationCommandResolvedIds.size !== BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_IDS.length ||
  BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_IDS.some(
    (id) => !batch4RegistrationCommandResolvedIds.has(id),
  ) ||
  Object.keys(BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 4 批④三条验收编号必须逐条有真实证据去向或明确阻塞说明');
}

function registerAcceptanceCases(cases: readonly { id: string; title: string }[]): void {
  for (const { id, title } of cases) {
    const destinations =
      BATCH2_ACCEPTANCE_DESTINATIONS[id] ??
      BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS[id] ??
      BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS[id];
    if (destinations !== undefined) {
      it(`${id} ${title}（已标注去向）`, () => {
        for (const destination of destinations) {
          expect(readFileSync(resolve(process.cwd(), destination.file), 'utf8')).toContain(
            destination.needle,
          );
        }
      });
      continue;
    }

    const blocker = BATCH2_ACCEPTANCE_BLOCKERS[id] ?? BATCH3_SLICE1_ACCEPTANCE_BLOCKERS[id];
    const batch4Blocker = BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS[id];
    if (batch4Blocker !== undefined) {
      it.todo(`${id} ${title}（阻塞：${batch4Blocker}）`);
      continue;
    }
    if (blocker !== undefined) {
      it.todo(`${id} ${title}（阻塞：${blocker}）`);
      continue;
    }

    it.todo(`${id} ${title}`);
  }
}

describe('活动业务改造 v1.1 合同完整性', () => {
  it('四份合同与入仓时的 SHA256 清单逐字节一致', () => {
    const manifest = readContractFile(SHA256_MANIFEST)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // 清单本身也是判据:少一行就等于少守一份合同。
    expect(manifest).toHaveLength(4);

    for (const line of manifest) {
      const [expectedDigest, ...nameParts] = line.split(/\s+/);
      const fileName = nameParts.join(' ');
      const actualDigest = createHash('sha256')
        .update(readFileSync(resolve(process.cwd(), CONTRACT_DIR, fileName)))
        .digest('hex');
      expect(`${fileName}:${actualDigest}`).toBe(`${fileName}:${expectedDigest}`);
    }
  });

  it('验收编号恰为 AC-001..072 与 ADV-001..023,无缺号无重号', () => {
    expect(acceptanceCases.map((c) => c.id)).toEqual(expectedIds('AC', 72));
    expect(adversarialCases.map((c) => c.id)).toEqual(expectedIds('ADV', 23));
  });

  it('355 项追踪矩阵行数为 355 且编号唯一', () => {
    const rowIds = [...matrix.matchAll(/^\| ([A-Z]\d{2}) \|/gm)].map((m) => m[1]);
    expect(rowIds).toHaveLength(355);
    expect(new Set(rowIds).size).toBe(355);
  });

  it('矩阵引用的每个验收编号都真实存在(含 `AC-001..004` 区间写法的两个端点)', () => {
    const knownIds = new Set([
      ...acceptanceCases.map((c) => c.id),
      ...adversarialCases.map((c) => c.id),
    ]);
    const referenced = new Set<string>();

    for (const match of matrix.matchAll(/(AC|ADV)-(\d{3})(?:\.\.(\d{3}))?/g)) {
      const [, prefix, start, end] = match;
      referenced.add(`${prefix}-${start}`);
      if (end !== undefined) referenced.add(`${prefix}-${end}`);
    }

    // 矩阵必须真的引用了验收编号 —— 空集合会让下面的断言恒真。
    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it('活文档仍指向本合同目录(指针被删则红)', () => {
    const currentState = readFileSync(resolve(process.cwd(), 'docs/current-state.md'), 'utf8');
    const nextTasks = readFileSync(resolve(process.cwd(), 'docs/ai-harness/NEXT_TASKS.md'), 'utf8');

    for (const document of [currentState, nextTasks]) {
      expect(document).toContain('activity-business-overhaul-v1.1');
    }
    expect(nextTasks).toContain('P1-28');
  });
});

describe('活动业务改造 v1.1 验收编号(AC-001..072)—— 待实现', () => {
  registerAcceptanceCases(acceptanceCases);
});

describe('活动业务改造 v1.1 对抗测试(ADV-001..023)—— 待实现', () => {
  registerAcceptanceCases(adversarialCases);
});
