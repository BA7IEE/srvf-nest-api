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
  // AC-058:账本批次在既有 member lock 内比较本活动待生效段与其他活动 committed 段。
  'AC-058': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: 'AC-058 rejects a cross-activity service-time overlap inside the member commit lock',
    },
  ],
  // AC-061:离线待复核既挡 EvidenceSeal，也进入关账 pending-work；五种缺口一次返回且零写。
  'AC-061': [
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle:
        'AC-061 blocks evidence seal on a pending offline review and releases it after rejection',
    },
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: 'AC-061 五种未完成事实一次返回完整结构化缺口且整事务零写',
    },
  ],
  // AC-065:评价窗口与资格都绑定最新 active closure；更正可新增资格，并标注被撤销资格的历史评价。
  'AC-065': [
    {
      file: 'test/e2e/activity-feedbacks.e2e-spec.ts',
      needle: 'AC-065 以最新 active closure 为窗口和资格真相，纠错后新增资格且撤销资格保留历史评价',
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
  // AC-060:#9 requestedChangeJson 结构尚未定义；评价资格联动已由 AC-065 独立收口。
  'AC-060': '卡已知合同缺口 #9 requestedChangeJson 结构。',
  // AC-063:已有 close×close；未有 close 与最后终审/更正的真实并发屏障。
  'AC-063': '缺关账×最后终审、关账×最后更正的 Activity-lock 并发用例。',
  // AC-064:archive action 读写入口尚未在本刀开放，现有仅证明等待期不是永久截止。
  'AC-064': '卡后续 archive action；现有仅覆盖归档等待期不是更正永久截止。',
  // ADV-001:同 AC-047，需第 5 批真实最后签退的并发入口。
  'ADV-001': '卡第 5 批结算提交×最后一次合法签退的真并发入口。',
  // ADV-008:合同点名六个 10000 条 kill/recover 检查点，现有 8192 规模 test 不等价。
  'ADV-008': '缺 10000 条在 1/199/200/201/9999/10000 检查点 kill/recover 演练。',
  // ADV-010:入队进度刷新与多活动记分尚无同一事务/并发集成能力。
  'ADV-010': '卡多活动记分×入队进度刷新的并发集成链。',
  // ADV-011:现有 partial unique 是串行覆盖，未有同 target 两个更正申请的真并发屏障。
  'ADV-011': '缺同一结算项两份更正申请的双实例真并发用例。',
  // ADV-012:缺席转出勤后的评价联动已由 AC-065 覆盖，仍卡未定请求结构。
  'ADV-012': '卡已知合同缺口 #9 requestedChangeJson 结构。',
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
  // AC-005:null 走真实 App PATCH，数据库保持 NULL，不再投影成 1970。
  'AC-005': [
    {
      file: 'test/e2e/app-managed-activities.e2e-spec.ts',
      needle: 'AC-005 clears registrationDeadline to database NULL without a 1970 projection',
    },
  ],
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
  // AC-011:正式会员可见普通活动；志愿者/非正式会员不可枚举，正式会员仍拿到资格原因。
  'AC-011': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle:
        'AC-011 exposes ordinary activities only to formal members while preserving qualification reasons',
    },
  ],
  // AC-015:终止事务落 30 分钟 deadline、只撤签到码；在线/离线签退与员工清场均有 HTTP/PG 证据。
  'AC-015': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle:
        'AC-015 persists a 30-minute termination checkout deadline and revokes only unfinished check-in QR credentials',
    },
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'AC-015 keeps normal checkout for 30 minutes after termination, then requires staff early-close',
    },
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: 'AC-015 accepts an already-issued offline checkout within the termination deadline',
    },
  ],
  // ADV-017:发布审核已在同一事务内投影真实 capacity bucket；活动和场次降容各有
  // “occupied=capacity 放行 → 降一拒 20147” 的 HTTP 针对性证据。
  'ADV-017': [
    {
      file: 'test/e2e/activity-batch4-capacity-projection.e2e-spec.ts',
      needle:
        'allows activity-person occupancy at its current capacity and rejects an activity capacity reduction below it',
    },
    {
      file: 'test/e2e/activity-batch4-capacity-projection.e2e-spec.ts',
      needle:
        'allows session participation occupancy at its current capacity and rejects a session capacity reduction below it',
    },
  ],
};

const BATCH3_SLICE1_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-003': '卡第 3 刀 clone 生命周期端点；本刀不建 clone。',
  'AC-004': '卡第 3 刀 archive 生命周期读写；本刀不新增归档动作或定时任务。',
  'AC-009':
    '发布链已覆盖根活动展示白名单与 Session/Position proposal；表单、资格、可见性、签到和计分规则仍卡第 4/5 批，整项不能提前结案。',
  'AC-010':
    '本刀已覆盖单场次 create/update/cancel 的变更审核；容量桶、二维码、人员影响、通知与结算人口仍是第 4/5/7 批接缝，整项不能提前结案。',
  'AC-012': '卡第 3 刀邀请可见性读面。',
  'AC-013': '卡 S6：draft_editor 七值责任模型另立 D 档刀；本刀不给协作人草稿编辑能力。',
  'AC-014': '卡第 3 刀 cancel 与现场事实并发语义。',
  'ADV-004': '卡第 3 刀普通取消×第一条现场签到真实并发。',
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

/** 第 4 批⑪把已冻结 D83 规则接入 display / submit / onsite / review 四阶段。 */
const BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_IDS = ['AC-018'] as const;

const BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-018': [
    {
      file: 'test/e2e/activity-batch4-qualification-runtime.e2e-spec.ts',
      needle:
        'AC-018 qualification runtime evaluates all seven D83 rule types across display, submit, onsite, and review',
    },
    {
      file: 'test/e2e/activity-batch4-qualification-runtime.e2e-spec.ts',
      needle:
        'does not leak qualification facts into immutable snapshots and keeps their count and hashes unchanged for failed displays',
    },
  ],
};

/**
 * 第 4 批 reservation kernel 只交付同一事务内的事实原语，不能把 service 直调误记为
 * 最终报名链。AC-022/023 仍必须保留 todo，直到 HTTP request、状态写与分配 policy caller
 * 在同一条用户链中接入。
 */
const BATCH4_RESERVATION_KERNEL_ACCEPTANCE_IDS = ['AC-022', 'AC-023'] as const;

const BATCH4_RESERVATION_KERNEL_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-022':
    '三层 reservation 内核已有真实 PostgreSQL 100人×3场与释放证据；尚缺 HTTP request、canonical 状态写和分配 policy caller。',
  'AC-023':
    '内核已有两 pool、capacity=1、100 并发的最后一席证据；尚缺 HTTP/policy caller，不能把 service 直调当最终用户链。',
};

/**
 * 第 4 批⑧只将现场临时参加的窄安全子集接成真实 HTTP caller。Form/资格 evaluator、
 * invitation accept 和 allocation 仍不在本 destination 的完成口径里。
 */
const BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_IDS = ['AC-026'] as const;

const BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-026': [
    {
      file: 'test/e2e/activity-batch4-onsite-participation.e2e-spec.ts',
      needle:
        'red-first destination creates one header with three capacity layers and replays 20 concurrent calls exactly',
    },
    {
      file: 'test/e2e/activity-batch4-onsite-participation.e2e-spec.ts',
      needle:
        'fails closed before all writes for Form fields and qualification configuration drift',
    },
  ],
};

/**
 * 第 4 批⑦只翻访客名单的完整零串入证据。邀请 accept 仍依赖未裁定的资格/容量 caller，
 * 因而 AC-019 必须保留 todo；活动开始批量 expiry 由独立的 AC-028 destination 结案。
 */
const BATCH4_INVITATION_VISITOR_ACCEPTANCE_IDS = ['AC-019', 'AC-027'] as const;

const BATCH4_INVITATION_VISITOR_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-027': [
    {
      file: 'test/e2e/activity-batch4-invitation-visitor.e2e-spec.ts',
      needle:
        'creates an external visitor in the visitor list only, keeps attendanceCode null, and rejects an uncontracted attendanceCode input',
    },
    {
      file: 'test/e2e/activity-batch4-invitation-visitor.e2e-spec.ts',
      needle: 'expect(await externalParticipantSnapshot()).toEqual(before);',
    },
  ],
};

const BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-019':
    'create/list/revoke/decline 与过期可见性已接；accept 仍缺其自身的资格/保险/容量 caller，活动开始批量 expiry 已由 AC-028 覆盖。',
};

/** 第 4 批⑱只结案活动开始时 unresolved canonical participation 与 pending invitation 的事务性 expiry。 */
const BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_IDS = ['AC-028'] as const;

const BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-028': [
    {
      file: 'test/e2e/activity-batch4-expiry.e2e-spec.ts',
      needle:
        'red-first: activity start expires a canonical pending identity and a pending invitation',
    },
    {
      file: 'test/e2e/activity-batch4-expiry.e2e-spec.ts',
      needle:
        'red-first: activity start expires only the first_come waitlist and preserves an occupied pass',
    },
    {
      file: 'test/e2e/activity-batch4-expiry.e2e-spec.ts',
      needle:
        'fails closed on a canonical pointer drift: business facts and audits remain unchanged',
    },
  ],
};

/** 第 4 批永久头 runtime 只翻真实十轮取消/重报闭环；资格、分配与整单取消旁路不借此结案。 */
const BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_IDS = ['AC-021', 'ADV-005'] as const;

const BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-021': [
    {
      file: 'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
      needle: 'reuses one permanent head and identity through ten cancel/reapply rounds',
    },
    {
      file: 'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
      needle:
        'expect(await prisma.activityParticipationIdentity.count({ where: { id: identityId } })).toBe(1);',
    },
  ],
  'ADV-005': [
    {
      file: 'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
      needle:
        'expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(21);',
    },
    {
      file: 'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
      needle:
        'expect(await prisma.activityParticipationRevision.count({ where: { identityId } })).toBe(21);',
    },
  ],
};

/**
 * 第 5 批只交付 App 自助二维码与现场事实主链。每个编号都指向真实 HTTP/PostgreSQL
 * 断言或既有 append-only/关账硬门；不把第 6 批的 staff_scan、代签、导入或离线项目
 * 提前记到本批。ADV-006 的前三段由本批 QR 主链钉住，最终关账仍复用既有机器关账
 * 实证，下面明确列出两处而不伪称它们是同一夹具。
 */
const BATCH5_SELF_PUNCH_ACCEPTANCE_IDS = [
  'AC-031',
  'AC-032',
  'AC-033',
  'AC-034',
  'AC-035',
  'AC-036',
  'AC-037',
  'AC-038',
  'AC-039',
  'AC-040',
  'AC-041',
  'AC-042',
  'AC-046',
  'ADV-001',
  'ADV-002',
  'ADV-004',
  'ADV-005',
  'ADV-006',
  'ADV-007',
  'ADV-020',
] as const;

const BATCH5_SELF_PUNCH_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-031': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'rejects QR action, activity, session and time-window mismatches with zero punch writes',
    },
  ],
  'AC-032': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'keeps the wrong check-in immutable after void and lets the corrected check-in become the active segment',
    },
  ],
  'AC-033': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'renders protected SVG and applies the frozen required-location policy without leaking coordinates',
    },
    {
      file: 'src/modules/attendances/attendance-punch-location-policy.spec.ts',
      needle:
        'mutation: rejects an out-of-range point rather than accepting a rounded or low-accuracy coordinate',
    },
  ],
  'AC-034': [
    {
      file: 'src/modules/attendances/attendance-punch-location-policy.spec.ts',
      needle: 'allows absent coordinates only when the frozen session policy is optional',
    },
  ],
  'AC-035': [
    {
      file: 'src/modules/attendances/attendance-punch-location-policy.spec.ts',
      needle: 'accepts exact center and reports low accuracy without widening the radius',
    },
    {
      file: 'src/modules/attendances/attendance-punch-location-policy.spec.ts',
      needle: 'keeps an out-of-range point rejected even when accuracy is low',
    },
  ],
  'AC-036': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'uses real registration, QR signing, the 29:59/30:00 boundary, and segment projection end to end',
    },
  ],
  'AC-037': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'permits a 10-minute special close, then creates a second non-overlapping service segment',
    },
  ],
  'AC-038': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'permits a 10-minute special close, then creates a second non-overlapping service segment',
    },
  ],
  'AC-039': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'does not invent a checkout or service duration after the frozen checkout window has closed',
    },
  ],
  'AC-040': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'serializes exact same-key replay and rejects a changed request under the global event key',
    },
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle: 'Array.from({ length: 98 }',
    },
  ],
  'AC-041': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'rejects same event key when a valid request changes person, activity, action or source',
    },
    {
      file: 'src/modules/attendances/attendance-punch-request-hash.spec.ts',
      needle: 'mutation: changing %s changes the canonical request hash',
    },
  ],
  'AC-042': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'serializes distinct keys to one open segment and makes QR revoke race resolve to zero or one append',
    },
  ],
  'AC-046': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'records managed early-close, void and replace as append-only corrections while allowing checkout after identity drift',
    },
  ],
  'ADV-001': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle: 'serializes settlement submission behind the final legal QR checkout',
    },
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle: 'BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE',
    },
  ],
  'ADV-002': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'serializes distinct keys to one open segment and makes QR revoke race resolve to zero or one append',
    },
  ],
  'ADV-004': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'red-first: activity cancellation waits behind the first punch and must not cancel once the punch commits',
    },
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle: 'rejects the Admin cancellation path when a real effective punch exists',
    },
  ],
  'ADV-005': [
    {
      file: 'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
      needle:
        'expect(await prisma.activityParticipationIdentity.count({ where: { id: identityId } })).toBe(1);',
    },
  ],
  'ADV-006': [
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'uses real registration, QR signing, the 29:59/30:00 boundary, and segment projection end to end',
    },
    {
      file: 'test/e2e/activity-batch5-punch-runtime.e2e-spec.ts',
      needle:
        'permits a 10-minute special close, then creates a second non-overlapping service segment',
    },
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: '写不可变 closure + 两个指针 + archive waiting + audit + 评价开放 intent',
    },
  ],
  'ADV-007': [
    {
      file: 'test/e2e/activity-batch5-punch-concurrency.e2e-spec.ts',
      needle:
        'rejects same event key when a valid request changes person, activity, action or source',
    },
    {
      file: 'src/modules/attendances/attendance-punch-request-hash.spec.ts',
      needle: 'mutation: changing %s changes the canonical request hash',
    },
  ],
  'ADV-020': [
    {
      file: 'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
      needle: 'AttendancePunchEvent:本刀加列 importJobItemId 之后 trigger 四条判据重跑',
    },
  ],
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

const batch4QualificationRuntimeResolvedIds = new Set([
  ...Object.keys(BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_DESTINATIONS),
]);
if (
  batch4QualificationRuntimeResolvedIds.size !==
    BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_IDS.length ||
  BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_IDS.some(
    (id) => !batch4QualificationRuntimeResolvedIds.has(id),
  )
) {
  throw new Error('第 4 批⑪ AC-018 必须绑定真实资格运行时 E2E destination');
}

const batch4ReservationKernelResolvedIds = new Set([
  ...Object.keys(BATCH4_RESERVATION_KERNEL_ACCEPTANCE_BLOCKERS),
]);
if (
  batch4ReservationKernelResolvedIds.size !== BATCH4_RESERVATION_KERNEL_ACCEPTANCE_IDS.length ||
  BATCH4_RESERVATION_KERNEL_ACCEPTANCE_IDS.some((id) => !batch4ReservationKernelResolvedIds.has(id))
) {
  throw new Error('第 4 批 reservation kernel 两条验收编号必须保持明确 blocker');
}

const batch4OnsiteParticipationResolvedIds = new Set([
  ...Object.keys(BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_DESTINATIONS),
]);
if (
  batch4OnsiteParticipationResolvedIds.size !== BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_IDS.length ||
  BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_IDS.some(
    (id) => !batch4OnsiteParticipationResolvedIds.has(id),
  )
) {
  throw new Error('第 4 批⑧ AC-026 必须绑定真实现场临时参加 E2E destination');
}

const batch4InvitationVisitorResolvedIds = new Set([
  ...Object.keys(BATCH4_INVITATION_VISITOR_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS),
]);
if (
  batch4InvitationVisitorResolvedIds.size !== BATCH4_INVITATION_VISITOR_ACCEPTANCE_IDS.length ||
  BATCH4_INVITATION_VISITOR_ACCEPTANCE_IDS.some(
    (id) => !batch4InvitationVisitorResolvedIds.has(id),
  ) ||
  Object.keys(BATCH4_INVITATION_VISITOR_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 4 批⑦两条验收编号必须逐条有真实去向或明确 blocker');
}

const batch4ActivityStartExpiryResolvedIds = new Set([
  ...Object.keys(BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_DESTINATIONS),
]);
if (
  batch4ActivityStartExpiryResolvedIds.size !==
    BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_IDS.length ||
  BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_IDS.some(
    (id) => !batch4ActivityStartExpiryResolvedIds.has(id),
  )
) {
  throw new Error('第 4 批⑱ AC-028 必须绑定真实活动开始 expiry E2E destination');
}

const batch4PermanentRegistrationResolvedIds = new Set([
  ...Object.keys(BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_DESTINATIONS),
]);
if (
  batch4PermanentRegistrationResolvedIds.size !==
    BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_IDS.length ||
  BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_IDS.some(
    (id) => !batch4PermanentRegistrationResolvedIds.has(id),
  )
) {
  throw new Error('第 4 批永久头 runtime 的 AC-021/ADV-005 必须绑定十轮真实 E2E');
}

const batch5SelfPunchResolvedIds = new Set([
  ...Object.keys(BATCH5_SELF_PUNCH_ACCEPTANCE_DESTINATIONS),
]);
if (
  batch5SelfPunchResolvedIds.size !== BATCH5_SELF_PUNCH_ACCEPTANCE_IDS.length ||
  BATCH5_SELF_PUNCH_ACCEPTANCE_IDS.some((id) => !batch5SelfPunchResolvedIds.has(id))
) {
  throw new Error('第 5 批自助二维码与现场主链的 20 条验收编号必须逐条绑定真实证据');
}

/**
 * 第 6 批收口刀(§14「Staff scan、proxy、bulk job、import preview／execute、offline package 和
 * review。撤权与 task item 重新判权必须同批完成」)的四条对抗编号。
 *
 * ADV-009 不在此表:它在第 2 批就已绑到 activity-ledger-posting 的崩溃可重入用例上,
 * 且该用例确实模拟「业务写成功但 item 状态没落地」后重跑不翻倍 —— 逐字符合 ADV-009 合同,
 * 本刀复核后**保持原样**,不重复登记(同一编号登记两处会让「去向」失去唯一性)。
 *
 * ⚠️ 逐条都真读过目标用例:标题像不算数。
 *  - ADV-003 合同是「现场权限**撤销**与**代签**并发」。既有
 *    `activity-batch6-offline-writer` 里那条自称 ADV-003 的用例撤的是**离线包**、
 *    并发的是**上传**,是另一件事(它本身仍是有效判据,只是不该顶 ADV-003)。
 *    本刀新写真用例:撤责任分配 × proxy-punch,两连接池。
 *  - ADV-023 合同是「任务**运行一半**时撤销操作者权限」。既有
 *    `rechecks a revoked collaborator...` 是**开跑前**撤权(itemsProcessed: 0),
 *    不满足「运行一半」。本刀新写真用例:先有 item 真提交了 PunchEvent,再撤权,
 *    剩余项 skipped 且已提交项原样保留。
 *  - ADV-013 的六个子形态逐个落到六个不同的 anomaly 判据上,缺一不可。
 */
const BATCH6_CLOSEOUT_ACCEPTANCE_IDS = ['ADV-003', 'ADV-013', 'ADV-014', 'ADV-023'] as const;

const BATCH6_CLOSEOUT_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  // ADV-003 → 本刀新用例:撤销现场责任 × 代签,跨两个 Nest/PostgreSQL pool 线性化。
  'ADV-003': [
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'ADV-003 现场权限撤销与代签并发:两个连接池上线性化,越权那一侧零 PunchEvent',
    },
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'expect(afterRevoke.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);',
    },
  ],
  // ADV-013 → 合同点名六个子形态,逐个绑到各自的 anomaly 断言上。
  'ADV-013': [
    {
      // 撤权后上传
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expect(review.anomalyCode).toBe('operator_authorization_revoked');",
    },
    {
      // 过期
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'package_expired', approvalPolicyCode: 'approvable' }]);",
    },
    {
      // 篡改时间(设备时间在未来)
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'future_time',",
    },
    {
      // 篡改时间(落在包窗口之外)
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'time_out_of_window',",
    },
    {
      // 跳号
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'sequence_gap',",
    },
    {
      // 重复号
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'sequence_duplicate', approvalPolicyCode: 'reject_only' }]);",
    },
    {
      // 换设备
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'device_mismatch', approvalPolicyCode: 'reject_only' }]);",
    },
  ],
  // ADV-014 → 预览后在 provider 层等长替换文件,同步 execute 与 worker 两条边界都 22100 零写。
  'ADV-014': [
    {
      file: 'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
      needle:
        'mutation: replacing the pinned CSV fails both execute boundaries with 22100 and zero PunchEvent',
    },
    {
      file: 'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
      needle: 'expect(rejected.body.code).toBe(22100);',
    },
  ],
  // ADV-023 → 本刀新用例:批量代签**跑到一半**(已有 item 提交 PunchEvent)再撤权。
  'ADV-023': [
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'ADV-023 批量代签跑到一半再撤权:已提交项保留,剩余项 skipped 且零 PunchEvent',
    },
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,',
    },
  ],
};

const batch6ClosecoutResolvedIds = new Set(Object.keys(BATCH6_CLOSEOUT_ACCEPTANCE_DESTINATIONS));
if (
  batch6ClosecoutResolvedIds.size !== BATCH6_CLOSEOUT_ACCEPTANCE_IDS.length ||
  BATCH6_CLOSEOUT_ACCEPTANCE_IDS.some((id) => !batch6ClosecoutResolvedIds.has(id))
) {
  throw new Error('第 6 批收口的 4 条对抗编号必须逐条绑定真实断言片段');
}

/**
 * 第 7 批第一刀(收件人快照冻结)。
 *
 * ⚠️ **只翻真的被穿过的那一条**:ADV-016 的合同原文是「通知意图形成后**报名名单**变化,
 * 原事件收件人仍保持冻结」—— e2e 里那一条正是按这句话布点的(形成 intent → 软删一个
 * 报名 + 新增一个报名 → 抽干 outbox → 比集合),并已做变异对拍(把投递改成按当时名册
 * 重算 ⇒ 该用例红)。
 *
 * AC-066 / AC-067 **照实留 todo**:
 *   · AC-066 三个可选项里「目标**组织**」本刀根本没有实现(只有标签与广播两条路),
 *     覆盖了三分之二不能拿来结案 —— 这正是本文件开头那条纪律。
 *   · AC-067 讲的是未签退提醒与收口待办,与冻结不在同一条链上。
 */
const BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_IDS = ['AC-066', 'AC-067', 'ADV-016'] as const;

const BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'ADV-016': [
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'ADV-016 取消通知:intent 形成后**报名名单**再变,原事件收件人仍逐字冻结',
    },
    {
      // 「退出的人仍收到、后来报名的人收不到」是这条对抗的两个方向,各绑一句真断言。
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'expect(deliveredMembers).not.toContain(lateRegistrant.id);',
    },
  ],
};

const BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-066':
    '标签定向与「明确不广播」已冻结并异步展开,但三个可选项里的「目标**组织**」本刀零实现 —— 整项不能按三分之二结案。',
  'AC-067': '未签退提醒与收口待办不在冻结这条链上;卡第 7 批后续刀。',
};

const batch7RecipientFreezeResolvedIds = new Set([
  ...Object.keys(BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS),
]);
if (
  batch7RecipientFreezeResolvedIds.size !== BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_IDS.length ||
  BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_IDS.some((id) => !batch7RecipientFreezeResolvedIds.has(id)) ||
  Object.keys(BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 7 批第一刀的 3 条验收编号必须逐条有已标注去向或明确阻塞说明');
}

/**
 * 「哪些登记表参与查表」只写一处 —— `registerAcceptanceCases` 与下面的接线守护读的是
 * **同一个数组**,所以两者不可能各说各话。
 *
 * 🔴 立项证据(本刀实测):把某一批的 destinations 从原来的 `??` 链里摘掉,
 *    该批编号会**静默退回 `it.todo`** —— 43 todo 变 47 todo,一条都不红,整套仍是绿的。
 *    也就是说「已接通」在此之前只靠人记得加那一行,没有任何执行位守着。
 *    这与本仓 README 清单那次是同一个形状:**少接一条不产生坏链接,既有守护看不见它。**
 */
const ACCEPTANCE_DESTINATION_TABLES: ReadonlyArray<
  Readonly<Record<string, readonly AcceptanceDestination[]>>
> = [
  BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_DESTINATIONS,
  BATCH6_CLOSEOUT_ACCEPTANCE_DESTINATIONS,
  BATCH5_SELF_PUNCH_ACCEPTANCE_DESTINATIONS,
  BATCH2_ACCEPTANCE_DESTINATIONS,
  BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS,
  BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS,
  BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_DESTINATIONS,
  BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_DESTINATIONS,
  BATCH4_INVITATION_VISITOR_ACCEPTANCE_DESTINATIONS,
  BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_DESTINATIONS,
  BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_DESTINATIONS,
];

function resolveAcceptanceDestinations(id: string): readonly AcceptanceDestination[] | undefined {
  for (const table of ACCEPTANCE_DESTINATION_TABLES) {
    const found = table[id];
    if (found !== undefined) return found;
  }
  return undefined;
}

function registerAcceptanceCases(cases: readonly { id: string; title: string }[]): void {
  for (const { id, title } of cases) {
    const destinations = resolveAcceptanceDestinations(id);
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

    const blocker =
      BATCH2_ACCEPTANCE_BLOCKERS[id] ??
      BATCH3_SLICE1_ACCEPTANCE_BLOCKERS[id] ??
      BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS[id];
    const batch4Blocker = BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS[id];
    const batch4ReservationKernelBlocker = BATCH4_RESERVATION_KERNEL_ACCEPTANCE_BLOCKERS[id];
    const batch4InvitationVisitorBlocker = BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS[id];
    if (batch4Blocker !== undefined) {
      it.todo(`${id} ${title}（阻塞：${batch4Blocker}）`);
      continue;
    }
    if (batch4ReservationKernelBlocker !== undefined) {
      it.todo(`${id} ${title}（阻塞：${batch4ReservationKernelBlocker}）`);
      continue;
    }
    if (batch4InvitationVisitorBlocker !== undefined) {
      it.todo(`${id} ${title}（阻塞：${batch4InvitationVisitorBlocker}）`);
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

  // 接线守护:登记了去向、却忘了把该批登记表接进查表链 ⇒ 编号**静默退回 todo**,
  // 整套照样全绿。本条把「接通」变成一个可失败的判据,而不是靠人记得加那一行。
  it('第 6 批收口的 4 条对抗编号确实产出真实用例,没有静默退回 todo', () => {
    const notWired = BATCH6_CLOSEOUT_ACCEPTANCE_IDS.filter(
      (id) => resolveAcceptanceDestinations(id) === undefined,
    );
    expect({ 登记了去向却没接进查表链的编号: notWired }).toEqual({
      登记了去向却没接进查表链的编号: [],
    });
    // 反向:判据自身不得因为清单为空而恒真。
    expect(BATCH6_CLOSEOUT_ACCEPTANCE_IDS.length).toBe(4);
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
