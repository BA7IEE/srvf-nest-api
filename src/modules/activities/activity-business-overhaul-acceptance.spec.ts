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
  // AC-047:2026-08-24 分拣刀订正 —— 「卡第 5 批」已过期(第 5 批 #1032 已合),
  //   而且那条并发链就在 `activity-batch5-punch-concurrency.e2e-spec.ts` 里(已绑给 ADV-001)。
  //   剩下的是一格**此前从没被写出来过**的真缺口:「活动未结束」没有独立执行位。
  'AC-047':
    '「卡第 5 批最后一次合法签退/窗口并发链」已过期:第 5 批(#1032)已给出 checkout×submit 的真并发用例;' +
    '开放服务段(submit 侧 SETTLEMENT_SUBMIT_OPEN_SEGMENT)与签退窗口未关闭(封场侧 EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN)也都有 red-first 证据。' +
    '真缺口是三个前置里的第一个:「**活动未结束**」全链没有独立执行位 —— submit 与封场都不读 Activity.endAt,' +
    '实践中靠「签退窗口未关闭」间接覆盖,而**零 live 场次时窗口真空成立**,该形态既无闸也无判据;' +
    '「只允许整理草稿」的正面一半(被拒的同时草稿仍可编辑)亦无同夹具断言。' +
    '(2026-08-25 动手复核确认:`settlement-submission-validator.ts` 的拒绝种类闭集恰五条 —— ' +
    'pending_result / item_count_mismatch / duplicate_identity / open_segment / missing_rule,没有「活动未结束」这一条;' +
    '`settlement-submit.service.ts` 与 `evidence-seal.service.ts` 全文零处读 `Activity.endAt`(前者的 endAt 命中全在**场次**上);' +
    '封场那条 `deadlines.length === 0 ? authoritativeNow` 就是「零 live 场次时窗口真空成立」的原文。' +
    '⇒ **功能缺口,不是测试缺口**,补测试关不掉。)' +
    '(2026-08-26「只缺测试那批」独立复测,读数逐条重取并用第二个工具交叉核过 —— ' +
    '`settlement-submit.service.ts`(853 行)与 `evidence-seal.service.ts`(460 行)对 `endAt` 命中**各 0 次**,' +
    '后者对 `checkOutCloseAt` 命中 2 次 ⇒ 两条链读的确实只有签退窗口;validator 的拒绝种类仍恰五条。' +
    '⭐ 并回答了「真空是缺陷还是刻意」这个此前悬着的问题:**是刻意的**,而且刻意的方向恰恰是不加闸 —— ' +
    '`evidence-seal.service.ts` 文件头「与合同的偏离」第 ④ 条逐字写着「零 live 场次时…真空成立…' +
    '**不发明新的拒绝理由去堵这个形态**」。⇒ 要关掉本条必须**新增一道读 `Activity.endAt` 的闸**' +
    '(以及它的具名拒绝码),那是一次实现变更 + 一次拍板,不在「只补测试」的射程内。' +
    '另:「只允许整理草稿」的正面一半确实是纯测试,但它**关不掉本条**,而且 `SettlementDraftService.updateItem` ' +
    '在全仓 e2e 里**零调用点** —— 写它是新开一条 e2e 路径,应与那道闸同刀落地,两半共用一份夹具。)',
  // AC-049:当前覆盖人口数量，不覆盖 absent 零时长不得进入有效服务明细的完整投影。
  'AC-049': '缺 absent 零时长结果到有效服务明细的端到端断言。',
  // AC-054:现有规模用例为 8192，未覆盖合同固定的 10000 人与 0%/100%读面组合。
  //
  // ⚠️ 第 7 批第 ②-a 刀(在途显示)给这一条**加了一个必须知道的前提**,后来者别看漏:
  //    participation-summary / contribution-summary 现在**另有**一条明确标注的「在途」轴
  //    (`ledgerTotals.inFlight*`,来自 `preparing`/`ready` 批次)。它**不是**「半批生效」——
  //    「正式结果」那一轴(`ledgerTotals.committed*` 与既有四个数字)仍然只有 0%/100%,
  //    commit 是一个事务。但批次停在 `preparing` 期间分录逐条 INSERT,故**在途**那一轴
  //    在准备期间会逐步长大;做 10000 人规模用例时必须按轴分别断言,
  //    不能拿「有个数在动」直接判 AC-054 红。
  //    小规模的「在途不漏进正式结果」已由
  //    `test/e2e/activity-batch7-in-flight-display.e2e-spec.ts` 不变量 1a / 3b 钉住,
  //    但**规模那一半仍然是空的** —— 本条因此照旧 todo,不拿一半凑完成数。
  //
  // 🔴 **2026-08-24 分拣刀补一条硬天花板(判为 B 档「能写但太重」的实测依据)**:
  //    统一生效走 `runMemberLinearizedTransaction`,并被 `ledger-commit-lock-budget.ts`
  //    的**全局槽位预算**闸住 —— `LEDGER_COMMIT_LOCK_SLOT_COUNT = 10` ×
  //    `LEDGER_COMMIT_MEMBERS_PER_SLOT = 1000` = 10000 把队员 advisory 锁。
  //    也就是说 **10000 人恰好用尽全部 10 个槽**(`requiredSlots(10000) = 10`),
  //    **超过 10000 恒不可能通过**(`ledgerCommitExceedsTotalBudget`)。
  //    再往上是 PG 共享锁表的公式保底 12800(64 × 200,第 0 批 lock-probe §6 实测),
  //    而那张表是**整个实例共享**的、不是每库一份 —— e2e 按 worker 派生独立库、
  //    共用同一个 PostgreSQL 实例 ⇒ 一条 10000 人的用例会占掉全实例 78% 的锁表条目,
  //    把 `out of shared memory` 撒到**别的 spec** 上。⇒ 这不是「跑得慢」,是造 flake 机器。
  //    事务预算另注:该路径是 `MEMBER_TX_TIMEOUT_MS`(4000 锁等待 + 3000 业务 = **7000ms**),
  //    不是 Prisma 默认的 5000 —— 别把 AC-068 那条 5000ms 的读数套到本条上。
  'AC-054':
    '缺 10000 人准备期间的 0%/100% 读面规模用例;现有上限是 8192。' +
    'B 档(需专门的规模测试方案):10000 人恰好用尽 ledger-commit 的全部 10 个全局槽位' +
    '(10 槽 × 1000 人/槽),>10000 由 ledgerCommitExceedsTotalBudget 恒拒;' +
    'PG 共享锁表公式保底 12800 是**全实例共享**,e2e 各 worker 同实例 ⇒ 会把 out of shared memory 撒到别的 spec。',
  // AC-055:现有重放覆盖一次，不是终审、恢复、更正各 100 次。
  'AC-055':
    '缺终审、任务恢复和更正各重复 100 次的总额恒等测试(现有三条链各只有「重放一次不翻倍」的幂等证据)。' +
    'B 档(需专门的耐久方案):三轴 × 100 轮完整事务链,**耗时是估计不是实测**' +
    '(本刀无连库权限;可比读数是同仓 8192 人规模 spec 自述单跑 1–2 分钟)。',
  // AC-056:现有用例覆盖同活动同日多场次，未覆盖多活动稳定分配顺序。
  'AC-056': '缺同一北京日多活动的稳定分配顺序与 capped-out 展示断言。',
  // AC-057:2026-08-24 分拣刀订正 —— 「卡第 5 批」已过期(#1032 已合),
  //   卡的从来不是批次,是**没有人造过跨零点的夹具**。
  'AC-057':
    '「卡第 5 批」已过期(#1032 已合):拆日算法 `splitRecognizedIntoDays` 早已存在并有纯函数单测(15:00Z→17:00Z 断在 16:00Z)。' +
    '真缺口是夹具:全套 e2e 的服务段**一律落在同一个北京日内**(账本 spec 固定 LEDGER_DATE、punch spec 08:00Z→12:00Z),' +
    '「跨零点拆两日」在 e2e 层零覆盖,而「**拆开后各自跑每日 3 分上限**」这半格连单测都没有。',
  // AC-060:2026-08-24 分拣刀订正 —— **原文是错的**。
  //   #9 作为「合同文本未定义」仍然开着,但它**不构成本条的阻塞**:
  //   `correction-change-set.ts`(第 2 批第七刀 #923,比本卡点 #949 还早)已给出带
  //   schemaVersion 的显式闭集,十值 resultCode 含 absent / present,并已由
  //   `correction-application.service.ts` 在提交与生效两处真解析、形状不符即 20102。
  //   ⇒ 拿「结构未定义」当理由,把一条**只差用例**的编号写成了「做不了」。
  'AC-060':
    '原卡点「卡合同缺口 #9 requestedChangeJson 结构」**是错的**:该结构已由 correction-change-set.ts(第 2 批第七刀 #923)以带 schemaVersion 的显式闭集补齐,' +
    '十值 resultCode 含 absent / present,提交与生效两处真解析、形状不符 20102 —— 合同文本仍未定义(#9 作为**文本**缺口不关),但它不阻塞本条。' +
    '真缺口是用例:全仓没有任何 e2e 把结果码 flip(absent↔present)走一遍 submit→approve→prepare→commit,' +
    '并在同一夹具里同时断言人员 / 时长 / 分数 / 评价资格 / 关闭版本五格一致变化(现有更正 e2e 与 journey 全部硬编码 present,' +
    '评价资格那格由 AC-065 用**手写第二条 closure** 的夹具覆盖,没走真更正链)。',
  // AC-063:已有 close×close；未有 close 与最后终审/更正的真实并发屏障。
  //   ⚠️ 2026-08-25 起本条**已由 TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS 接通**,下面这段只作历史记录。
  //      其中「要先给 `activity-settlement-closure.e2e-spec.ts` 加第二实例」一句**实测已过期**:
  //      新用例另开 `activity-settlement-closure-concurrency.e2e-spec.ts`,既有关账 spec 一个字未动。
  'AC-063':
    '缺关账×最后终审、关账×最后更正的 Activity-lock 并发用例(三条路径都已在 Activity FOR UPDATE 之后,能力在)。' +
    '⚠️ 写它要先给 `activity-settlement-closure.e2e-spec.ts` 加第二实例:该 spec 目前是单 app / 单 pool,' +
    '写不出真竞态(现有 close×close 用的是不同 key 的串行两连发)。',
  // AC-064:archive action 读写入口尚未在本刀开放，现有仅证明等待期不是永久截止。
  //   2026-08-24 分拣刀复核并把「零实现」写实:全仓无 archive 路由、无 archive 状态值。
  // AC-064:2026-08-25 归档刀**收窄** —— 原卡点「卡后续 archive action / 全仓无该动作、
  //   无该状态值」已过期:`archived` 已是状态闭集第 6 值,`POST /my/managed-activities/{id}/archive`
  //   已开放,结算路径的两道闸(未关账 20156 / 未满等待期 20157)已实装并有纯函数判据。
  //   仍不能结案的**只剩一格**,且那一格是缺证据不是缺实现。
  // ⚠️ 2026-08-26 起本条**已由 TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS 接通**
  //    (那一格的 HTTP 续链已按本段点名的做法接在 `activity-settlement-closure.e2e-spec.ts` ⑦ 上,
  //     没有把关账夹具复制进归档 spec),下面这段只作历史记录 —— 去向恒优先于卡点。
  'AC-064':
    '归档动作已交付(2026-08-25):`archived` 进入状态闭集,archive / unarchive 两端点开放,' +
    '结算路径两道闸各有具名码(未关账 20156 / 等待期未满 20157),判据见 activity-archive-policy.spec.ts 「结算路径」五条。' +
    '原卡点「全仓无该动作、无该状态值」已过期。' +
    '**仅剩一格**:「7 天等待结束**后可以归档**」这一半只有纯函数证据,**没有 HTTP 证据** —— ' +
    '造它要一条真 `ActivitySettlementClosureRevision`,而该表有三条必填外键' +
    '(settlementVersion / postingBatch / evidenceSeal),等于把第 2 批第六刀的整套关账夹具搬进归档 spec。' +
    '正确做法是在 `activity-settlement-closure.e2e-spec.ts` 里接一条「关账成功 → archiveWaitingDays=0 立即可归档 / ' +
    '=7 时先 20157」的续链,而不是在归档 spec 里复制第二份关账夹具。另一半「合法更正不因 7 天过去而被永久禁止」' +
    '已有覆盖(关账链里没有任何一处拿 archiveWaitingUntil 做拒绝判据),本刀未改动它。',
  // ADV-001:同 AC-047，需第 5 批真实最后签退的并发入口。
  //
  // ⚠️ 这条**看起来**该删(第 5 批已在 BATCH5_SELF_PUNCH_ACCEPTANCE_DESTINATIONS 里给了
  //    真去向,渲染上早已是「已接通」)。第 7 批第 ④ 刀实测过删它 ⇒ 本批模块级守护
  //    「第 2 批 28 条必须逐条有去向或卡点」当场抛错、整套 `Tests: 0 total`。
  //    因为这句记的是**第 2 批自己**没交付,不是「全仓至今没交付」——
  //    跨批次交付时,前批留卡点、后批给去向是本登记表的**既定形状**,不是矛盾。
  'ADV-001': '卡第 5 批结算提交×最后一次合法签退的真并发入口。',
  // ADV-008:合同点名六个 10000 条 kill/recover 检查点，现有 8192 规模 test 不等价。
  'ADV-008':
    '缺 10000 条在 1/199/200/201/9999/10000 检查点 kill/recover 演练。' +
    'B 档(需专门的规模测试方案):与 AC-054 同一条天花板 —— 10000 恰好用尽全部 10 个 ledger-commit 槽位,' +
    '且 6 个检查点意味着同规模夹具至少重建 6 次;`out of shared memory` 会串到同实例的别的 spec 上。',
  // ADV-010:2026-08-24 分拣刀复核 —— 比原文更重:不是「缺并发集成用例」,是两条链根本不相交。
  'ADV-010':
    '不是缺用例,是能力缺口:新账本走 MemberContributionDayState / ParticipationLedgerEntry,' +
    '而入队进度 `computeCappedContribution` 读的是**旧考勤** attendanceRecord —— 两条链取数源不相交,' +
    '活动模块对 team-join 只 import 了 GLOBAL_DAILY_CONTRIBUTION_CAP 一个常量。' +
    '「多活动记分×入队进度刷新」当前没有可并发的接缝可测;接缝本身要先立项。',
  // ADV-011:现有 partial unique 是串行覆盖，未有同 target 两个更正申请的真并发屏障。
  'ADV-011':
    '缺同一结算项两份更正申请的双实例真并发用例(20101 与 NULLS NOT DISTINCT partial unique 已有串行与 schema 两层证据)。' +
    '⚠️ 全仓没有 `activity-settlement-correction-concurrency` 这样的 spec,更正线是单实例的 —— 写它要先起第二个 app/pool。',
  // ADV-012:与 AC-060 同因同修 —— 原文「卡 #9 结构」同样是错的,见 AC-060 那段的取证。
  //   两条编号共用同一条待写用例(flip 走真更正链),补一条即可同时接通。
  'ADV-012':
    '同 AC-060:原卡点「卡合同缺口 #9 requestedChangeJson 结构」**是错的**(结构已由 correction-change-set.ts 补齐并生产接线);' +
    '真缺口是没有 e2e 把 absent→present 走完真更正链并同夹具断言人数 / 时长 / 分数 / 评价 / 关闭版本一起变化。' +
    '与 AC-060 共用同一条待写用例。',
  // ADV-022:archive 未开放，且尚缺更正×关闭的双实例并发屏障。
  // ADV-022:2026-08-25 归档刀**收窄**。原卡点两项里的第一项(「卡 archive action」)已消解 ——
  //   动作与状态值都有了,且归档写路径与关账走**同一把 Activity 行锁**(lockActivityForLifecycle
  //   → FOR UPDATE),结构上已具备可并发的接缝。剩下的是**用例**,不是能力。
  // ⚠️ 2026-08-26 起本条**已由 TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS 接通**,下面这段只作历史记录。
  //    ⭐ 订正一处**本段写错了的读数**:下面第一项「① 更正提交/生效 × 关账」里的**生效**那一半,
  //       在本段写下时**已经存在** —— `activity-settlement-closure-concurrency.e2e-spec.ts` ②
  //       就是真跑 `correctionA.commit` 的双实例竞态(不是 updateMany 模拟)。
  //       同理「现有仍只有同事务原子性证据」这一句在写下时即为假。真正缺的是另外三格:
  //       更正**提交** × 关账、更正生效 × 归档、更正提交 × 归档 —— 2026-08-26 补齐,
  //       另加「归档 × 关账」(本段 ② 点名的那条)。
  'ADV-022':
    '原卡点第一项「卡 archive action(全仓无该动作、无该状态值)」已过期:2026-08-25 归档刀交付了 archive / unarchive,' +
    '且归档取的是与关账 / 终审 / 更正同一把 Activity `FOR UPDATE` 行锁 ⇒ 真并发接缝已经存在。' +
    '仍缺两条**真并发**用例:① 更正提交/生效 × 关账;② 归档 × 关账(或 × 更正生效)。' +
    '两条都要第二个 app / pool(现有更正线与归档线都是单实例,写不出真竞态,只能串行两连发);' +
    '可沿 AC-063 那条 `activity-settlement-closure-concurrency.e2e-spec.ts` 的双实例形状扩,不必另起地基。' +
    '现有仍只有同事务原子性证据(audit 抛错整笔回滚 / 未 commit 时读面仍是旧账),' +
    '且关账 spec 里那条「更正把 closure 顶成 superseded」是用裸 updateMany **模拟**的,不是真跑更正。',
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
  // ⚠️ **本表原有六条写着「卡第 3 刀…」,而第 3 刀(`#955`)比本刀(`#952`)早三个 PR 就合了。**
  //    2026-08-24 分拣刀逐条重判并订正;订正的是**卡点说明**,不是把编号提前结案。
  //
  // AC-003:clone 端点与真用例都已存在(`#955`),原文「本刀不建 clone」已过期。
  //   真缺口是**证据面**:那条用例的事实表 spy 只看 11 张 delegate,合同点名的 9 类历史里
  //   邀请 / 二维码 / 关闭 / 更正 / 通知 **四类零证据**,结算与账本各只证了一张表。
  'AC-003':
    'clone 端点与「配置复制 + 事实表零写」真用例已由第 3 刀(#955)交付,原「本刀不建 clone」已过期;' +
    '真缺口是合同点名的 9 类历史里 ActivityInvitation / AttendanceQrCredential / ' +
    'ActivitySettlementClosureRevision / AttendanceCorrectionRequest+CorrectionApplication / ' +
    'Notification*+NotificationOutboxIntent 五类不在 spy 集内、零断言,结算与账本各只覆盖一张表。',
  // AC-004:第 3 刀已合,但它**本来就没排** archive —— 原文把「本刀不做」写成了「卡第 3 刀」。
  //   本刀复核 `NEXT_TASKS` P1-28 第三刀那段的自述,采用它给的准确口径。
  'AC-004':
    '归档端点尚未排批,且全仓没有 archive 状态列或 archivedAt 事实列(archiveWaitingUntil 是结算关账的**派生**等待期,不是活动归档);' +
    '「长期未处理草稿在工作台提示」亦零实现 —— 唯一的 workbench 是结算工作台。三格全缺,不是缺测试。',
  // AC-009:表单与资格两格已分别由第 4 批③/⑰落地并各有 published→ACTIVITY_CHANGE_REVIEW_REQUIRED 的真用例,
  //   原文「表单、资格…仍卡第 4/5 批」已过期。
  //   2026-08-25「只清缺测试那批」刀再订正:可见性 / 签到规则两格已补上真用例
  //   (`app-managed-activities.e2e-spec.ts` ›「AC-009 已发布活动直写可见性 / 签到规则必须拒绝」,
  //    三个字段各自单独发 + 白名单混发的边界 + description 单独发的正对照 + 每次回读库行),
  //   本条因此只剩**一格**,而那一格是**裁定问题不是测试问题** ⇒ 仍留 todo。
  'AC-009':
    '场次 / 岗位 / 名额 / 表单 / 资格五格已各有 published 直写被拒的真用例(表单第 4 批③、资格第 4 批⑰),原「仍卡第 4/5 批」已过期;' +
    '可见性与签到规则两格 2026-08-25 已补写(app-managed-activities.e2e-spec.ts),不再是缺口;' +
    '仅剩计分规则一格:全仓无按活动的写接口(贡献规则按 activityType×role×version 全局查),' +
    '「无接口算不算满足合同」须**维护者裁定** —— 这一格补测试解决不了,整项不能结案。' +
    '(2026-08-26「只缺测试那批」复核并把裁定问题**收窄成一句可回答的话**:' +
    '`ContributionRule` 的业务键是 `activityTypeCode` + `attendanceRoleCode`,schema 里**没有 activityId 这一列**,' +
    '端点前缀是 `system/v1/contribution-rules` —— 而「contribution-rules 归 System surface」是**决策锁 D-1**。' +
    '⇒ 「按活动写计分规则」不是漏做,是被 D-1 结构性排除掉的。裁定问题因此只剩一句:' +
    '**合同这一句里的「计分规则」,在本仓不存在按活动的写面,这算不算已满足「直接写接口必须拒绝」?** ' +
    '答「算」⇒ 本条可接一条结构判据(schema 无 activityId + 端点在 System surface)后结案;' +
    '答「不算」⇒ 要新开按活动的计分规则写面,那是重开 D-1,必须先声明决策锁。两条路都不是补测试。)',
  // AC-010:容量桶那格已由第 4 批⑤真实投影 + 三条 HTTP 判据落地,原文把它列进「仍是接缝」已过期。
  'AC-010':
    '六格里五格已落:变更审核与名额(容量桶)由第 4 批⑤给出(投影只取 scheduled 场次、取消场次的桶留作不可变历史、占用中降容 20147);' +
    '二维码 / 人员 / 通知 / 结算人口四格由 ADV-018 那一刀(2026-08-25)实装并各有正向 + 反向用例,去向见 ADV-018 登记。' +
    '**仅剩「改期」这一格**:合同原文是「取消**或改期**只影响该场次」,而 sessions.update 的既有用例只出现过 ' +
    'name / locationText / capacity,**没有任何用例改过 startAt / endAt**,更没有「改 A 场次的时间、B 场次的时间与二维码有效期纹丝不动」这条反向。' +
    '⚠️ 改期不是取消的同形:取消走 statusCode,改期要动 checkIn*/checkOut* 四个时间窗,' +
    '而二维码的 validFrom / validUntil 是**签发时从场次时间窗冻下来的**(见 attendance-qr-credential.service.ts issue()),' +
    '改期后既有凭证的有效期与新时间窗不一致 —— 这一格要先裁定「改期是否作废旧码」再补测,补测试解决不了。' +
    '(2026-08-26「只缺测试那批」复核,补三条给下一个人:' +
    '① ⭐ **本条的「改期」与 AC-066 的「改期」不是同一件事**,别当成一格两写:' +
    '   AC-066 是**活动级** startAt/endAt/location 变化触发的收件人冻结' +
    '   (`activity-write.service.ts` 的 `scheduleChanged` → cohortKey `activity-change:*`,已于本日补齐 e2e);' +
    '   本条是**单个场次**改期后「只影响该场次」的隔离,走的是变更审核的 `applySessions`,两条链不相交。' +
    '② 这一格可写的是**隔离那一半**(改 A 场次的时间 ⇒ B 场次的名额桶 / 二维码行 / 人员身份逐字段不变),' +
    '   与 ADV-018 取消那一刀的反向三条同形;挡住的只有**正向那一半**' +
    '   ——「A 自己的旧码怎么办」正是那个未裁定的问题,而取消那一刀的正向三条恰恰都落在 A 上。' +
    '③ 只写隔离半格 ⇒ 本条仍不能结案(合同这一句点名五格,正向缺一格就是没覆盖),' +
    '   故本刀**不拿半格冒充**,照旧留 todo,等裁定后与正向一并落地。)',
  // AC-012:2026-08-24 分拣刀判为 A 并已在 TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS 给出真去向。
  //   这句留着是**第 3 刀第一刀自己**的欠账记录(同 ADV-001 / ADV-004 的既定形状),删不得。
  'AC-012': '卡第 3 刀邀请可见性读面。',
  // AC-013:S6 责任模型那条**不是**「另立 D 档刀就会有」——本刀复核发现现状比原文更远:
  //   `ActivityResponsibilityAssignment` 只有 owner/collaborator 两值 + 两个布尔,
  //   而两布尔全 false 的协作人拿到的是**零 RoleBinding**(什么都看不到),不是「只读」。
  'AC-013':
    '§3.5 的 draft_editor 七值责任模型零实现:现状是 responsibilityType 两值(owner/collaborator)+ canManageRegistrations / canManageAttendance 两个布尔;' +
    '两布尔全 false 的协作人经 grant projector 得到的是**零 RoleBinding**(连管理进度都看不到),不是合同要的「只读协作人」。' +
    '九个动作里「归档」本身也不存在(见 AC-004)。另立 D 档责任模型刀,本刀不给协作人草稿编辑能力。',
  // AC-014:现场事实闸已由第 5 批交付(cancelLocked 在 Activity 根锁内读整条 PunchEvent 链),
  //   原文「卡第 3 刀 cancel 与现场事实并发语义」已过期。
  'AC-014':
    '「有效现场事实 ⇒ 普通取消被拒」已由第 5 批交付并有 App / Admin 两个入口的真用例(fixture 用未开始的场次,证明拒的是**事实**不是时间闸),原「卡第 3 刀」已过期;' +
    '余三格未证:「**有效**」这个限定(已 void / superseded 的事实不得阻断)只有纯函数单测、无 HTTP 证据;' +
    '「必须改走提前终止」无「取消被拒 → terminate 成功」的同活动链;「并结算」无 terminate → 结算的续链。',
  // ADV-004 同 ADV-001:第 5 批已给真去向,但这句是**第 3 刀自己**的欠账记录,删不得
  //(删掉会让本批的模块级完整性守护抛错)。详见 BATCH2_ACCEPTANCE_BLOCKERS 里 ADV-001 那段。
  'ADV-004': '卡第 3 刀普通取消×第一条现场签到真实并发。',
  // ADV-018:本刀复核发现这条**不是「缺测试」,是实现与合同相反** —— 写清楚以免下一个人去补测。
  //   ⭐ 2026-08-25「只清缺测试那批」刀**逐点复核并确认属实**(只取证、不修;它是实现缺陷,
  //      要单独立项 + 维护者定优先级),四个落点逐一给出:
  //      ① `activity-publish-proposal-v2.service.ts` `applySessions()` 的
  //         `if (session.statusCode === 'cancelled') { … void at; }` —— 取消分支里只有一句
  //         「`deletedAt` 刻意不动」的注释,除通用 data 里那一列 statusCode 外**零副作用**;
  //      ② 同文件 `applyQrCredentialsPlaceholder()` 体内是 `void tx; void activityId; return Promise.resolve()`
  //         —— 显式空桩,注释自称「第 5 批占位」;
  //      ③ 同文件 `applySnapshot()` 结尾写的是 `currentPopulationRevision: { increment: 1 }`
  //         —— **活动级**;全仓没有任何场次级人口版本列;
  //      ④ 通知 fan-out 两条路都按 activityId 取:`activity-publish-review.service.ts` 走
  //         `activityParticipationIdentity.findMany({ where: { activityId, populationIncluded: true } })`,
  //         `activity-proposal-applier.ts` 走 `activityRegistration.findMany({ where: { activityId, … } })`
  //         且只在**活动级** startAt/endAt/location 变化时才非空 —— 单场次取消因此连一条通知都不发。
  //      ⑤ `activityParticipationIdentity` 在这两个文件里**零次**出现在写路径上 ⇒ 人员零变更属实。
  // ⚠️ 这一行是**第 3 批第一刀自己**的欠账记录,删不得(删掉本批模块级完整性守护会抛错;
  //    同 ADV-001 / ADV-004 的既定形状)。真去向已由 2026-08-25 的收口刀给出,登记在
  //    `ADV018_SESSION_CANCEL_ACCEPTANCE_DESTINATIONS` —— 去向恒优先于卡点,这段不再被渲染。
  'ADV-018':
    '不是缺测试,是实现层与合同相反:场次取消只翻 statusCode,二维码 effect 是显式空桩,人员零变更,' +
    '而变更审批的通知 fan-out 按 activityId 取**全体** populationIncluded 身份广播,不按场次收窄 ⇒ 「只影响该场次」当时不成立。' +
    '(2026-08-25 逐点复核确认属实,四个落点见上方注释;属**实现缺陷**,不是补测试能关的。' +
    '**已于 2026-08-25 单独立项收口**:四格接线 + 三条反向判据,见 ADV018_SESSION_CANCEL 去向表。)',
  // ADV-019:四轴里三轴已有真读面证据,原文「卡第 3 刀…读面」已过期;缺的是第四轴。
  'ADV-019':
    '正式 / 非正式 / 未受邀三轴已各有真实读面证据(AC-011 与 AC-012 的去向即是),原「卡第 3 刀」已过期;' +
    '缺的是**停用**这一轴在第 3 批新目录路由 `GET /api/app/v1/activities` 上的断言 —— ' +
    '现有 INACTIVE→403 只钉在旧的 `activities/available` 与 `activities/:id` 上,新路由的三条用例全是 ACTIVE 成员;' +
    '`UserStatus.DISABLED` 那种读法在任何活动读面上都零覆盖。另外合同要的是「组合」,当前无任何用例同时跨两轴。',
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
  // 2026-08-24 分拣刀复核:结论不变(仍 C),但把「未接入」写准 ——
  // 后台代报名不是「还没接」,是在有 v1.1 Form/live session 时被**主动拒**;导入根本没有端点。
  'AC-017':
    '三入口共享答案 validator 仍未实现:`validateRegistrationFormAnswers` 全仓只有一个生产调用方(canonical 报名命令,邀请 accept 复用同一个),' +
    '后台代报名走的是 legacy 路径(formVersionId/answersHash 恒 null、收自由 extras),且一旦活动有 v1.1 Form/live session 就被 ' +
    'assertLegacyRegistrationFlowAllowed 以 ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED **主动拒**——它不是「未接入」,是接不上;' +
    '名单导入**零端点**(报名 sourceCode 闭集只有 self/admin/invitation/onsite,全仓唯一的 import 是考勤导入)。三入口只存在一个。',
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
  // 2026-08-24 分拣刀订正:两条原文里「尚缺 HTTP request / canonical 状态写 / 分配 policy caller」
  //   这三样**都已落**(第 4 批④报名命令主链、⑧现场补录、⑯分配 runtime)。两条的结局不同 ——
  //   AC-023 判 A 并已在 TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS 给出真去向;AC-022 仍是 todo。
  'AC-022':
    '「尚缺 HTTP request / canonical 状态写 / 分配 policy caller」已过期:三者均已落地(第 4 批④/⑧/⑯),报名与现场补录两条真 HTTP 链都走三层 reservation。' +
    '真缺口收窄成两格断言:合同点名的 **100 人 × 3 场那组数字只有 service 直调的证据**(HTTP 侧最大只跑到 1–2 人),' +
    '且没有任何 HTTP 用例在同一 member 拿下第二个场次之后**回读 activity_person 桶**、证明它仍只占 1 个活动位。',
  // AC-023:本条**已由分拣刀接通**(见 TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS)。
  //   这句留着是本批自己的欠账记录 —— 本批模块级守护要求两条都在卡点表里,删不得;
  //   去向恒优先于卡点,所以渲染上它已经是真用例。同 ADV-001 / ADV-004 的既定形状。
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
  // 2026-08-24 分拣刀订正:「accept 仍缺其自身的资格/保险/容量 caller」**是错的,而且方向反了**——
  //   accept 的设计就是**不给它自己的 caller**:它在 Activity→Invitation 锁序内直接调
  //   `registrationCommands.submitInTransaction(source: 'invitation')`,复用 canonical 的
  //   表单 / 资格 / 保险 / 容量四道闸,正是为了不留邀请旁路。`NEXT_TASKS` P1-28 第 4 批⑦/⑯
  //   那段早已写着这件事,登记表这句是从更早的 `#22 资格 runtime` 时代逐字带过来没重判。
  'AC-019':
    '「accept 仍缺其自身的资格/保险/容量 caller」**是错的**:accept 刻意不建自己的 caller,而是在 Activity→Invitation 锁序内复用 ' +
    'canonical `submitInTransaction(source: invitation)` 的表单/资格/保险/容量四闸(不留邀请旁路)。' +
    '真缺口是**断点位置**:四个入口(accept/decline/revoke/过期)都有真用例,accept 侧却只断言了「名额」这一格' +
    '(capacityReservationId 与 first_come pass/pending);硬资格 block、保险 INSURANCE_REQUIRED、必要表单三格的断言全在**自助报名**入口上,' +
    '现有三条 accept 用例一律 `formVersion: null, answers: []`、活动无 active Form。按本文件纪律不拿四分之一结案。',
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
  // 2026-08-24 分拣刀复核:原判(目标组织零实现)成立,但漏了同一句合同里的**另一个**缺口。
  // 2026-08-25 组织定向刀复核:上一版这条卡点的**四个分句已随实现变成假话**(依据闭集只有 5 个 /
  // 零处读 organizationId / 发布 DTO 只收 audienceTagCodes / 目标组织零实现)。台账写着已被推翻的
  // 读数比没写更坏 —— 逐条订正,但**卡点不撤**:同句点名的「改期」那一格仍然零绑定。
  // ⚠️ 2026-08-26 起本条**已由 TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS 接通**:
  //    「改期」那一格补了三条 e2e(冻结集合 / 异步展开后实收逐字相同 / 盖章与发布批互不吞并),
  //    src 侧一行未动。下面这段只作历史记录 —— 去向恒优先于卡点。
  'AC-066':
    '标签定向、「明确不广播」与**目标组织**三个可选项已全部实现并冻结:组织定向走 `audienceOrganizationIds`' +
    '(与 audienceTagCodes 同形的 nullable JSONB),「勾上级含下级」走 organization_closure 真子树,' +
    '与标签取交集(AND);依据闭集随之升到 6 个(新增 audience-organizations),' +
    '判据在 `src/modules/activities/activity-recipient-freeze.spec.ts` 的「⑥ 组织定向 —— 交集与真子树」' +
    '(正向 + 两个反向 + 两条边界 + 禁止前缀匹配的结构断言,三次变异对拍红集互不相同)。' +
    '⛔ **仍不能结案**:同句点名的「**改期**」事件 src 侧有实现(cohortKey `activity-change:*`)且有单测,' +
    '但 `test/` 下零绑定 —— 别当它已判过。整项卡在这一格上,不是卡在组织那一格。',
  // 2026-08-24 分拣刀复核:原判成立(三格全零),补上真正的立项约束 —— 第三个 cron 要过 D 档。
  'AC-067':
    '未签退提醒与收口待办不在冻结这条链上;卡第 7 批后续刀。' +
    '2026-08-24 复核:三格全零 —— 全仓无未签退提醒(既有到期提醒 cron 发的是「活动即将开始」),' +
    '负责人侧只有**拉取式**的 open_segment 缺口计数(结算/关账工作台),没有推给负责人的收口待办;第三格「重试不重复通知」因此空谈。' +
    '⭐ 真正的立项约束是:定时发送要第三个 cron,而 cron 终态**恰 2** 是决策锁,加第三个须新 D 档评审 —— 这不是补测试能解决的。',
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
 * 第 7 批第 ④ 刀 —— 13 条「无卡点」验收编号逐条判定。
 *
 * 这 13 条此前**既没接通、也没写卡点**:在登记表里退化成裸 `it.todo`,
 * 既不能算已交付,也没告诉维护者卡在哪。本刀逐条判定,只有三种合法结局:
 *   **A 接通**(既有测试确实断言了该条要求)· **B 补测再接**(能力有、判据缺)·
 *   **C 如实留卡点**(确实没做)。
 *
 * ⚠️ 逐条都**真读过目标用例**才绑,标题像不算数;C 类一律写明缺的是**哪一格**,
 *    不拿「覆盖了三分之二」结案(沿本文件开头那条纪律与第 7 批① AC-066 的先例)。
 *
 * 本刀实测发现、值得记下的三处(详见各条注释):
 *  - **AC-030 不是接线活,是真缺口**:`collaboratorOptions` 硬编码 `take: 200`
 *    且**无搜索、无分页**,`members/options` 的 `limit` 上限 100 —— 超出即不可达,
 *    正是 AC-030「超过200人仍可完整查找」要防的那件事。故判 C 而非 A/B。
 *  - **AC-045 的第七个子形态**(摘要链异常 `hash_chain_invalid`)不在 ADV-013 绑的
 *    六个之内,是本刀单独核到并绑上的。
 *  - **AC-044 的解析版本**此前零判据:既有用例每一处都原样回传正确的 parserVersion。
 */
const BATCH7_CLOSEOUT_ACCEPTANCE_IDS = [
  'AC-020',
  'AC-024',
  'AC-025',
  'AC-030',
  'AC-043',
  'AC-044',
  'AC-045',
  'AC-068',
  'AC-069',
  'AC-070',
  'AC-071',
  'AC-072',
  'ADV-015',
] as const;

const BATCH7_CLOSEOUT_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  // ── A 接通(既有测试确实断言了合同要求的那件事) ──────────────────────────────
  //
  // AC-024 四项冻结物逐个绑:候选名单(资格快照哈希漂移即零写)、规则/算法版本
  // (进 candidateSnapshotHash)、评分与随机种子承诺(commit 时用 sha256 真验承诺)、
  // 结果与候补序列;外加「可复查重放」的逐字节重放断言。
  'AC-024': [
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle:
        'freezes qualification_rank scores, replays prepare exactly, and commits capacity in score order',
    },
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle:
        'keeps lottery seed concealed at prepare, verifies its commitment at commit, and replays commit exactly',
    },
    {
      // 承诺不是「存了个字段」——commit 揭示的 seed 必须真的哈希回 prepare 的 commitment。
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: "expect(createHash('sha256').update(reveal, 'utf8').digest('hex')).toBe(",
    },
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: 'fails closed with zero commit writes when a frozen qualification hash drifts',
    },
    {
      // 规则/算法版本确实是冻结哈希的一部分,不是旁边挂着的说明字段。
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: 'algorithmVersionCode: batch.algorithmVersionCode,',
    },
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle:
        'red-first: numbers session-level qualification waitlists independently for each original position',
    },
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: 'expect(commitReplay.body.data).toEqual(committed.body.data);',
    },
  ],
  // AC-043 与 ADV-023 是同一条链的两种说法:合同 AC-043 要的是「撤权后**尚未执行**的
  // 任务项停止写入」,ADV-023 那条用例正是按这句话布点的(已提交项原样保留、
  // 剩余项 skipped、撤权后 PunchEvent 集合逐条不变)。「并发」那一半另绑 ADV-003 的
  // 两连接池线性化用例 —— 两条合起来才覆盖 AC-043 的完整口径。
  'AC-043': [
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'ADV-023 批量代签跑到一半再撤权:已提交项保留,剩余项 skipped 且零 PunchEvent',
    },
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: 'ADV-003 现场权限撤销与代签并发:两个连接池上线性化,越权那一侧零 PunchEvent',
    },
    {
      // 「停止写入」的真值:已跑的一项留着,剩下的一项 skipped —— 不是整批回滚。
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: "statusCode: 'partial_failed', succeeded: 1, failed: 0, skipped: 1",
    },
  ],
  // AC-045 合同点名**七个**子形态,逐个绑到各自的 anomaly 断言(每条都同时断言零 PunchEvent,
  // 即「进入人工复核、不自动生效」)。⚠️ 第七个「摘要链异常」不在 ADV-013 绑的六个之内。
  'AC-045': [
    // 过期
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'package_expired', approvalPolicyCode: 'approvable' }]);",
    },
    // 撤权
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expect(review.anomalyCode).toBe('operator_authorization_revoked');",
    },
    // 换设备
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'device_mismatch', approvalPolicyCode: 'reject_only' }]);",
    },
    // 跳号
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'sequence_gap',",
    },
    // 重复号
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "anomalyCode: 'sequence_duplicate', approvalPolicyCode: 'reject_only' }]);",
    },
    // 未来时间
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'future_time',",
    },
    // 摘要链异常 —— 本刀单独核到并绑上的第七格。
    {
      file: 'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
      needle: "expected: 'hash_chain_invalid',",
    },
  ],
  // AC-069「业务写成功但任务项尚未标成功时崩溃,恢复后依靠**业务防重**安全续跑」:
  // 用例把 item 打回 pending 模拟崩溃,重跑后 entriesInserted=0、分录与 day rows 都不翻倍 ——
  // 兜住的正是 entryKey/operationKey 单列 unique + ON CONFLICT DO NOTHING 这层业务防重。
  'AC-069': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '⭐ ④ 崩溃可重入(§5.12 ⑦)',
    },
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '把 item 打回 pending 再跑一次 ⇒ 分录、day rows 都不翻倍',
    },
    {
      // 「安全续跑」的真值:重跑真的又算又写了一遍,但一条都没多出来。
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: 'expect(replayReRun.entriesInserted).toBe(0);',
    },
  ],
  // AC-071 三段各绑各的:「统一经过现有授权服务」= 真实 bootstrap 下 Guard 处于 enforce
  // 且未声明路由数与 manifest 同步(全 5 个 surface 均为 0);「活动范围」= 树外活动全 DENY;
  // 「知道编号不能越权读取或写入」= 新子资源读面与写面各一条(两条走不同实现位)。
  'AC-071': [
    {
      file: 'test/journeys/activity-registration-checkin.e2e-spec.ts',
      needle: "event: 'authz_declaration_inventory',",
    },
    {
      file: 'test/journeys/activity-registration-checkin.e2e-spec.ts',
      needle: "mode: 'enforce',",
    },
    {
      file: 'test/e2e/participation-scoped-authz.e2e-spec.ts',
      needle: '他队(SWRT)活动:update / publish / cancel 全 DENY 30100(树外,活动状态零变化)',
    },
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: '不变量1:越权读一律 404,且与「jobId 根本不存在」逐字节同码同文案(不泄露存在性)',
    },
    {
      file: 'test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts',
      needle: '不变量2:创建人被撤权后 retry/cancel 立即失效,而仍在范围内的负责人不受影响',
    },
  ],

  // ── B 补测再接(能力有、判据缺;补的用例已做变异对拍,红集见 PR 说明) ──────────
  //
  // AC-044 三项匹配逐个绑。本刀实测:此前只有「文件摘要」被真的试错过,
  // 既有用例每一处都原样回传正确的 parserVersion、也没有任何一条送过别的预览任务号。
  'AC-044': [
    {
      file: 'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
      needle: 'AC-044 ①预览任务号:拿 A 预览的摘要去执行 B 预览 → 22100 且零业务写',
    },
    {
      file: 'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
      needle: 'AC-044 ②文件摘要:摘要对不上 → 22100 且零业务写',
    },
    {
      file: 'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
      needle:
        'AC-044 ③解析版本:客户端谎报与预览由旧解析器冻结,两条边界都 400 fail-closed 且零业务写',
    },
  ],
  // AC-030「超过 200 人仍可完整查找」。此前是**能力缺口**:`collaboratorOptions` 无搜索、
  // 无分页、`take: 200` 硬截,第 201 人在任何入参下都不可达(合同追踪矩阵 E07 明写本期实现
  // 「协作候选人搜索＋page/pageSize 分页,取消 200 人截断」)。现已交付,三条判据各守一面:
  // 够得到(翻页 + 搜索)、够得全(可见集合逐个 id 相同)、够得快(过滤排序在 SQL 里)。
  'AC-030': [
    {
      file: 'test/e2e/activity-scale-usability.e2e-spec.ts',
      needle: '不变量 1 —— 超过 200 人时第 201 个候选人可以翻页找到,也可以搜索找到',
    },
    {
      file: 'test/e2e/activity-scale-usability.e2e-spec.ts',
      needle: '🔴 红线 —— 翻遍所有页得到的可见集合,与改造前不截断时的可见集合逐个 id 相同',
    },
    {
      file: 'test/e2e/activity-scale-usability.e2e-spec.ts',
      needle: '不变量 2 —— collaboratorOptions 的查询路径上没有「取全量再内存 filter/sort」',
    },
  ],
  // AC-070 此前**只是 pagination.dto.ts 顶部的一行注释**,零执行位。本刀把它做成读
  // 已生成公开合同的判据:禁用参数、page/pageSize 成对、分页信封必声明分页参数、
  // limit 白名单穷举、全文零 cursor、手机管理根路径不变。
  'AC-070': [
    {
      file: 'src/modules/activities/activity-v11-outward-list-pagination.spec.ts',
      needle: '① 合同里没有任何 operation 声明 cursor / offset / skip / take 参数',
    },
    {
      file: 'src/modules/activities/activity-v11-outward-list-pagination.spec.ts',
      needle: '③ 每个返回分页信封的端点都声明了 page 与 pageSize',
    },
    {
      file: 'src/modules/activities/activity-v11-outward-list-pagination.spec.ts',
      needle: '⑤ 公开合同全文零 cursor(合同 §14 逐字要求)',
    },
    {
      file: 'src/modules/activities/activity-v11-outward-list-pagination.spec.ts',
      needle: '⑥ 手机管理根路径保持 /api/app/v1/my/managed-activities',
    },
  ],
  // AC-072 是**否定式**验收(「本轮未新增……」),六样东西逐个绑一条「不存在」判据。
  // 判据自身带正反对照自证 —— 零命中型判据若抽取器坏了会把六条全报成绿,
  // 那个失效形状和「真的没新增」长得一模一样。
  'AC-072': [
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '① 未新增坐标专用加密仓:加密域清单仍是既有五个,且无坐标仓模型',
    },
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '② 未新增隔离库:schema 只有一个 datasource 块,且只有一个库连接串 env',
    },
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '③ 未新增临时授权角色:Role 闭集仍是三态,且无坐标相关枚举',
    },
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '④ 未新增坐标专门期限:整份 env 清单里一个坐标词元都没有',
    },
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '⑤ 未新增坐标删除流程:公开合同里没有任何坐标专用路由',
    },
    {
      file: 'src/modules/activities/activity-v11-coordinate-negative.spec.ts',
      needle: '⑥ 未新增坐标专用告知上线门:同意字段与 *_ENABLED 闸里都没有坐标域',
    },
  ],
  // ADV-015 四条轴(场次 / 任务 / 报名 / 结算)各绑一条。此前只有「任务」这一轴有判据。
  // 对手取「另一个活动的合法负责人」——路径里放自己的 activityId,只换子资源编号,
  // 于是活动级判权必然放行,翻面的只剩「编号有没有被锚回该活动」。
  'ADV-015': [
    {
      file: 'test/e2e/activity-batch7-cross-activity-authz.e2e-spec.ts',
      needle:
        'ADV-015 场次:拿别的活动的 sessionId 改场次 —— 与「场次不存在」同码同文案,且受害场次零变化',
    },
    {
      file: 'test/e2e/activity-batch7-cross-activity-authz.e2e-spec.ts',
      needle: 'ADV-015 任务:拿别的活动的 jobId 读批量任务 —— 与「任务不存在」同码同文案',
    },
    {
      file: 'test/e2e/activity-batch7-cross-activity-authz.e2e-spec.ts',
      needle: 'ADV-015 报名:拿别的活动的 registrationId 审批 —— 同码同文案,且该报名状态零变化',
    },
    {
      file: 'test/e2e/activity-batch7-cross-activity-authz.e2e-spec.ts',
      needle: 'ADV-015 结算:拿别的活动的 versionId 读结算版本 —— 同码同文案(攻击者持全局结算码)',
    },
  ],
};

/**
 * C 类:如实留 todo,并写明**缺的是哪一格**。
 *
 * 这几条都不是「测试没写」,是**能力本身没做到合同要求**;本刀按合同 §6「零 src 业务改动」
 * 的授权边界,不替维护者实现,只把缺口写准以便立项。
 *
 * ⚠️ 原文写的是「这四条」,当时确实是四条(AC-020 / AC-025 / AC-030 / AC-068)。
 *    `#1090` 把 AC-030 修成真能力并转了去向,本表就只剩三条,而这句没跟着改 ——
 *    2026-08-24 分拣刀订正为不写死条数(**别再写「这 N 条」**:表一变它就悄悄成假话)。
 */
const BATCH7_CLOSEOUT_ACCEPTANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'AC-020':
    '取消**截止时间**与取消**申请**审批链本轮零实现:schema 只有 registrationDeadline,无报名取消截止列;' +
    '报名只能直接取消(cancelledByUserId/cancelledAt/cancelReason),没有「截止后转申请 → 主负责人/协作人审批 → ' +
    '批准与释放名额、候补递补同事务」这条链。全仓「取消申请」零命中(既有 cancelRequestHash 是**活动**取消的幂等哈希,不是这件事)。',
  'AC-025':
    '三段里第三段零实现:「候补顺序按所选分配方式产生」与「只在同场次同岗位递补」都已交付并有判据' +
    '(first_come/qualification_rank/lottery 队列 + 同岗位递补隔离),但「**换岗需要本人确认**」全仓零实现 —— ' +
    '没有换岗流程、也没有本人确认闸。按本文件纪律不拿三分之二结案。',
  'AC-068':
    '**结构性障碍已消除,读数仍缺一档**:现场批量代签已新增「提交选择条件、服务端在 SQL 里展开」的入口' +
    '(`selection: { mode: session-all }`),2000 人一次入队实测 43.7ms / 事务预算 5000ms,业务人员不必再手工拆;' +
    '既有 500 条 id 列表入口与 `@ArrayMaxSize(500)` 按合同追踪矩阵 I55「当前合理,保留」原样不动。' +
    '仍未结案的是**10000 档读数**:那需要规模测试环境,本地不产出可信数字(考勤 sheet `records` 的 200 条' +
    '是逐人数据而非 id 列表,条件无法替代,不在本条口径内)。' +
    '2026-08-24 分拣刀补两点:①**500 档同样没有正读数** —— 现有 500 相关断言是对 501 条伪造 id 的**拒绝**,' +
    '正面只能由 2000 档那次 a fortiori 推出,台账上不该写成「500 已测」;' +
    '②那句「不在本条口径内」指的是考勤单 `records` 上仍活着的 `@ArrayMaxSize(200)`(App/Admin 两处),' +
    '它是合同这句里「200 人数组」字面唯一的存活点,且该路径**没有** selection 条件式入口 —— 是否算在本条内需维护者裁定。',
};

const batch7CloseoutResolvedIds = new Set([
  ...Object.keys(BATCH7_CLOSEOUT_ACCEPTANCE_DESTINATIONS),
  ...Object.keys(BATCH7_CLOSEOUT_ACCEPTANCE_BLOCKERS),
]);
if (
  batch7CloseoutResolvedIds.size !== BATCH7_CLOSEOUT_ACCEPTANCE_IDS.length ||
  BATCH7_CLOSEOUT_ACCEPTANCE_IDS.some((id) => !batch7CloseoutResolvedIds.has(id)) ||
  Object.keys(BATCH7_CLOSEOUT_ACCEPTANCE_DESTINATIONS).some(
    (id) => BATCH7_CLOSEOUT_ACCEPTANCE_BLOCKERS[id],
  )
) {
  throw new Error('第 7 批第 ④ 刀的 13 条验收编号必须逐条有已标注去向或明确阻塞说明,且二者互斥');
}

/**
 * 2026-08-24 分拣刀 —— 32 条 `it.todo` 逐条重判后的**接通**部分。
 *
 * 🔴 **本刀是分拣不是清零。** 结论 A 14 / B 4 / C 14,逐条依据见 `NEXT_TASKS` P1-28
 *    的「验收编号分拣」小节。A 档里**只有本表这 2 条是「证据已在、只差接线」**;
 *    其余 12 条 A 都要**新写常规规模用例**(要连库跑才能交付),本刀不写。
 *
 * ⭐ **本刀查出的缺陷类**:这批卡点里有一大半是「**卡第 N 批 / 卡第 N 刀**」——
 *    它们全部写于**对应批次交付之前**,而那些批次早已合入,却没有任何人回头重判:
 *      · 「卡第 3 刀 clone / archive / 邀请可见性 / cancel / 可见性组合」五条写于 `#952`
 *        (第 3 批第一刀),而第 3 刀是 `#955` —— 早三个 PR 就合了;
 *      · 「卡第 5 批最后一次合法签退 / 跨北京零点」两条写于 `#949`(第 2 批),
 *        第 5 批是 `#1032`。
 *    ⇒ 与 `#1166` 治的「活干完了台账仍写待办」是**同一形态**,只是换了一份台账。
 *    **卡点说明会过期**,它不是一次写死的常量;本刀把过期的逐条订正(仍留 todo 的那些)。
 *
 * ⚠️ 本表刻意**不删**原批次的卡点行 —— 沿 ADV-001 / ADV-004 的既定形状:
 *    那句话记的是**那一批自己**没交付,不是「全仓至今没交付」。去向优先于卡点,
 *    渲染上本表这 2 条已经是真用例,原卡点行只作历史记录留着(删了会让那批的
 *    模块级完整性守护抛错,整套 `Tests: 0 total`)。
 */
const TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  // AC-012「邀请活动对未受邀者不可见,即使知道活动编号也不能读取详情。」
  //
  // 两格逐句对上,且**两格在同一个夹具里**(不是拼两条半覆盖):
  //   ①「不可见」→ 目录列表里 `expect(ids).not.toContain(invitationMiss.id)`,
  //     同一断言块内 `invited.id`(有 pending 邀请)**在**列表里 ⇒ 判据不是恒真;
  //   ②「知道编号也读不到详情」→ 直接 `GET /api/app/v1/activities/{invitationMiss.id}`
  //     得 `ACTIVITY_NOT_FOUND`(404 式,不是 403 —— 与防枚举锁同口径)。
  // 第二条 needle 补的是「什么才算 grant」:只有**未过期的 pending** 算;
  // 第三条是第 4 批的 red-first 否定式 —— 过期 pending **不**授予详情可见性。
  'AC-012': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle:
        'shows only published internal/invited activities and hides invitation misses and every terminal state as 404-style',
    },
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle:
        'treats only unexpired pending invitations as visibility grants and exposes only the caller own invitation summaries',
    },
    {
      file: 'test/e2e/activity-batch4-invitation-visitor.e2e-spec.ts',
      needle:
        'red-first: an expired pending invitation never grants member activity detail visibility',
    },
  ],
  // AC-023「100 个并发请求争最后一个名额,只能一个成功;容量桶不超卖、不负数。」
  //
  // 三格逐个绑:
  //   ①「100 并发争最后一席、只一个成功」→ 100 条**真 HTTP** POST(不是 service 直调),
  //     `capacity: 1`,`successes` 恰 1 / `failures` 恰 99 且**逐条**是容量码;
  //   ②「不超卖」→ 100 次尝试后两只桶都停在 `{ capacity: 1, occupied: 1, version: 1 }`,
  //     外加 DB CHECK `occupied <= capacity` 的独立反例;
  //   ③「不负数」→ 同一条 CHECK 的 `occupied = -1` 反例(INSERT 与 UPDATE 两条路都咬)。
  // ⚠️ **口径边界写在这里,别让后来者以为它比实际强**:那 100 并发跑在**现场补录**
  //    入口(`onsite-participations`)上,不是报名入口 —— 报名入口的并发用例只有 2 宽,
  //    且满员走候补而不是报错。合同这句没有限定入口,故按已覆盖计;
  //    若日后要求「报名入口自己也得有 100 并发」,那是**加一条新判据**,不是本条回退。
  'AC-023': [
    {
      file: 'test/e2e/activity-batch4-onsite-participation.e2e-spec.ts',
      needle:
        'serializes two independent capacity pools at one and returns exactly 1 success plus 99 capacity errors',
    },
    {
      file: 'test/e2e/activity-batch4-onsite-participation.e2e-spec.ts',
      needle:
        'for (const failure of failures) expectBizError(failure, BizCode.ACTIVITY_CAPACITY_EXCEEDED);',
    },
    {
      file: 'test/e2e/activity-v11-slice1-schema-constraints.e2e-spec.ts',
      needle:
        '超卖闸:occupied 为负被拒、occupied > capacity 被拒;occupied = capacity 放行;capacity=NULL 时不设上限',
    },
  ],
  // AC-049「每个有效队员×场次都有且只有一个当前人员结果;缺席等零时长结果不进入有效服务明细。」
  //
  // 两个分句各一条用例:
  //   ①「有且只有一个当前结果」→ 唯一索引 `participant_settlement_result_version_identity_key`
  //     的双向证据:两个身份**各恰 1 条**(正向,说明"只有一个"当下真的成立),
  //     同版本同身份再插第二条当场 P2002(反向,说明它是执行位而不是巧合)。
  //   ②「缺席等零时长结果不进入有效服务明细」→ 一个夹具三个人:出勤 / 缺席 / 早退零时长。
  //     缺席与早退**没有打卡也没有服务段**(真实形状),生效后 day 行 / 分录 / day-state
  //     三处都是 **0 行**(不是"记了 0"),读面 `listCommittedEntriesForActivity`
  //     只出现出勤那位;出勤那位有 1 day 行 + 2 分录 + 日合计 2.00 是**正对照**
  //     —— 没有它,那三个零可能只是整条链根本没跑起来。
  //   ⭐ 变异对拍(本机,`ledger-day-allocation.ts` 零结果分支改成写一行零 day 行):
  //     本 spec 28 条里**恰这条**变红,其余 27 条全绿。
  'AC-049': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '缺席 / 早退零时长 ⇒ 零 day 行、零分录、读面查不到;出勤那位照常入账(正对照)',
    },
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '「有且只有一个当前结果」是 DB 执行位:同版本同身份再插一条 ⇒ P2002',
    },
  ],
  // AC-056「北京时间同日多活动认定超过 3 分时,最终计入恰好 3 分,并显示未计入部分和稳定分配顺序。」
  //
  // ⭐ **先订正一个容易读错的地方**:仓内既有的「基线已有 2.5 分、本批再来 1.0 分 ⇒ 20086 被拒」
  //    走的是 `craftReadyBatch`(**手工造 ready 批次、刻意绕过准备器算术**)——
  //    那是"准备器坏了"的兜底闸,不是跨活动的正常语义。正常路径由
  //    `ledger-preparation.service.ts` 的 `readDayStateBaseline` → `applyDailyCap` 负责,
  //    prior 按 (member, 北京日) 取、与活动无关 ⇒ **跨活动就是截,不是拒**。
  //
  // 三格逐个绑:
  //   ①「最终计入恰好 3 分」→ 同一队员、同一北京日、**两场不同活动**各认定 2.00,
  //     第二场按真实准备路径只拿到 1.00,day-state 停在 **恰好 3.00**(version 2)。
  //   ② 反向(判据非恒真)→ 同夹具里先到的那场 credited 2.00 / cappedOut 0.00,
  //     证明不是"一律截成 3"。
  //   ③「显示未计入部分」→ 后到那场 cappedOut 1.00,并且在**对外读面**上真的看得见
  //     (`cappedOutPointsDelta`,不是只躺在内部表里)。
  //   ④「稳定分配顺序」→ 单独一条:早的一场认定 1.00、晚的一场 2.50(合计 3.50 > 3),
  //     按 `sequenceStartAt` 升序逐行断言 (recognized, credited, cappedOut)
  //     = [1.00, 1.00, 0.00] 与 [2.50, 2.00, 0.50]。
  //     ⭐ 顺序反过来会得到 [1.00, 0.50, 0.50] 与 [2.50, 2.50, 0.00] —— 两种顺序读数不同,
  //     所以这条断言真的在测顺序。⚠️ 既有 `⑥ 同一人同一日两场共 4.0 分` 那条用了
  //     `.map(...).sort()`,把顺序信息洗掉了(只钉住多重集 {1,2})⇒ 顺序这半格此前零覆盖。
  //   ⭐ 变异对拍(本机,两轮各只红一条):
  //     · `allocateDailyCredit` 的 `sequenceStartAt` 比较反向 ⇒ **只有 ④ 变红**
  //       (既有那条因为 `.sort()` 照样全绿 —— 正是"此前零覆盖"的实测证据);
  //     · `applyDailyCap` 的 prior 恒取 0(= 不读已 committed 基线)⇒ **只有 ①②③ 那条变红**,
  //       既有 28 条一条都没动 —— 说明"跨活动日上限在正常路径上生效"此前也无人守。
  'AC-056': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '同日**两场不同活动**各认定 2.00 ⇒ 第二场只计 1.00、截掉 1.00,日合计恰好 3.00',
    },
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '「稳定分配顺序」= 按 sequenceStartAt:早的那条先拿额度,与认定值大小无关',
    },
  ],
  // AC-057「跨北京时间零点的服务按两个自然日拆分并分别执行每日 3 分上限。」
  //
  // 一条用例把两个分句一次证完(它们在同一份读数里,拆开反而各自证不全):
  //   段 = 2020-03-01T15:00Z → 03-02T03:00Z(北京日界 UTC 16:00),1 小时落 03-01、11 小时落 03-02;
  //   认定 4.00 分按毫秒权重拆成 0.33 / 3.67(最大余额法,逐日求和恒等于 4.00)。
  //   ①「按两个自然日拆分」→ 恰两行,日期 ['2020-03-01', '2020-03-02'],时长 1.00 / 11.00。
  //   ② 反向 → 03-01 那天只有 0.33 分,**没有**被截(cappedOut 0.00)。
  //   ③ 边界 → 03-02 那天恰好停在上限 3.00,余下 0.67 进未计入。
  //   ④ ⭐ 决定性 → 两日**计入合计 3.33 > 3.00**。只有"按日分别设限"才可能出现这个数;
  //     谁把上限改成对整段服务的总量设限(或忘了拆日),这一行当场变红。
  //   ⑤ day-state 也是**两行**(每个北京自然日一行),不是合成一行。
  //   ⭐ 变异对拍(本机,`splitSpanByBeijingDay(...).slice(0, 1)` = 只取第一天):
  //     本 spec 28 条里**恰这条**变红,其余 27 条全绿。
  //   ⚠️ 立项前实测:全仓 e2e 的时间常量**没有一个跨过 UTC 16:00**(结算/账本族一律
  //     01:00Z→05:00Z 或 00:00Z→04:00Z),故本条的夹具是新造的,不是复用。
  'AC-057': [
    {
      file: 'test/e2e/activity-ledger-posting.e2e-spec.ts',
      needle: '段 2020-03-01T15:00Z→03-02T03:00Z、认定 4.00 分 ⇒ 两日 0.33 / 3.00,合计计入 3.33',
    },
  ],
  // AC-060「更正把缺席改出勤或出勤改缺席后,人员、时长、分数、评价资格和关闭版本一致变化。」
  // ADV-012「更正把缺席改出勤后,人数、时长、分数、评价和关闭版本一起变化。」
  //
  // 两条**共用同一段**新用例(合同一句话的两个方向),各绑自己那一向:
  //   · AC-060 的「或」两向都要 ⇒ 绑两条(出勤改缺席 + 缺席改出勤);
  //   · ADV-012 只点名「缺席改出勤」⇒ 只绑那一条。
  //
  // 五格在**同一夹具、同一次 apply 前后**各读一次:
  //   人员 → closure.resultCountsJson 从 {present:2} 变 {present:1, absent:1}(反向那条相反)
  //   时长 → closure.serviceHours 8.00 ⇄ 4.00
  //   分数 → closure.contributionPoints 2.40 ⇄ 1.20 + day-state 1.20 ⇄ 0.00
  //   评价资格 → ActivityFeedbacksService.getMine 的 canSubmit true ⇄ false(真读面,不重算谓词)
  //   关闭版本 → revision 1 → 2,旧行 superseded 且 supersededByCorrectionId 指回本次申请
  // 正对照:**未被更正的第二个人**五格原样不动 —— 否则"一致变化"可能只是整份账被推倒重来。
  //
  // ⭐ 变异对拍(本机,两轮,既有 19 条一条都没动):
  //   · `correction-change-set.ts` 的 `resultCode` 恒取 'present' ⇒ **只有 AC-060 那条变红**
  //     (既有 19 条全绿 —— 实测印证"全仓此前没有任何用例真的换过结果码");
  //   · `activity-closure.service.ts` 的 `readTotals().serviceHours` 恒取 '0' ⇒ **两条都变红**,
  //     既有 19 条仍全绿(closure 的时长汇总此前在本 spec 里也无人守)。
  //
  // 🔴 **少了一格,如实登记在此**:`eligibilityCorrected`(「最新结算纠错是否已撤销本人的当前评价资格」)
  //    走真更正链时**恒为 false** —— `wasEligibleBeforeLatestClosure()` 找旧 closure 的结果行时带
  //    `statusCode: 'committed'`,而真更正链在 commit 同事务里把旧结果行一律投影成 `superseded`,
  //    两者对不上。既有 AC-065 用例能读到 `true`,是因为它的夹具**手写**两版结果行且都留在 `committed`
  //    —— 真更正链从不产出那个形态。本刀**不修也不把 false 断言进来**(断言 false = 给缺陷发契约),
  //    已登记进 `NEXT_TASKS` P1-28 验收分拣小节等维护者裁定。
  'AC-060': [
    {
      file: 'test/e2e/activity-settlement-correction.e2e-spec.ts',
      needle: '🔴 AC-060 出勤改缺席:五格一起变,未被更正的那位五格原样不动',
    },
    {
      file: 'test/e2e/activity-settlement-correction.e2e-spec.ts',
      needle: '🔴 ADV-012 缺席改出勤:反方向五格一起变(人到了却被判缺席,是更正要修的原形)',
    },
  ],
  'ADV-012': [
    {
      file: 'test/e2e/activity-settlement-correction.e2e-spec.ts',
      needle: '🔴 ADV-012 缺席改出勤:反方向五格一起变(人到了却被判缺席,是更正要修的原形)',
    },
  ],
  // AC-003「复制旧活动只生成全新草稿,绝不复制报名、邀请、二维码、打卡、结算、账本、关闭、更正和通知历史。」
  //
  // 🔴 既有 clone 用例(同一个 spec 的「clones only live Activity / ActivitySession /
  //    ActivitySessionPosition configuration into a new draft」)源活动上**只建了一条报名**;
  //    九类里另外八类源侧一行都没有 ⇒「克隆件上是 0」对它们是**恒真**的。
  //    本刀新增的用例把九类逐类在源活动上真的建出来,再断言克隆件上逐类恰 0。
  //
  // 三层:
  //   ① 正向(判据非恒真)→ 源活动上九类**逐类**恰 1 行,先断言这一格;
  //   ② 反向 → 克隆件上九类**逐类**恰 0 行,且克隆件确实是 `draft` / closure 指针为 null;
  //      另断言源活动那九类**一行没被搬走**(clone 是复制不是搬家);
  //   ③ 结构 → 整个 clone 事务内事实表 delegate 写次数 = 0。
  //      同刀把 spy 面从 **11 → 24** 个 delegate(只增不减,既有断言一字未改):
  //      原集合只覆盖九类里的四类,邀请 / 二维码 / 关闭 / 更正 / 通知**整整五类零观察**。
  //      并加一条**地板**:集合里每个名字都必须是 Prisma client 上真实存在的 delegate
  //      —— 写错一个字母会静默变成"永远观察不到"而读数照样是 0(扫描面塌掉型假绿)。
  //
  // ⭐ 变异对拍(本机,往 `activity-lifecycle.service.ts` 的 clone 事务里加一句
  //    `tx.activityInvitation.createMany(...)` 把源邀请复制过去):
  //    **本刀这条变红,而既有那条 clone 用例照样全绿** —— 实测印证「另外八类此前是恒真的」。
  //
  // ⚠️ 口径边界写清楚:`Notification` 表本身**没有 activityId**(按 recipientMemberId 锚),
  //    所以"通知历史"这一类在行数层只能用 `NotificationOutboxIntent` 的多态锚点
  //    (`aggregateType='activity'` + `aggregateId`)来数;`Notification` / `NotificationDelivery`
  //    两张表由 delegate spy 那一层覆盖。
  'AC-003': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle: 'AC-003 九类历史在源活动上逐类真实存在，克隆件上逐类恰零行且 clone 事务零事实写',
    },
  ],
  // ADV-019「正式队员、停用账号、非正式队员和未受邀人员的活动可见性组合。」
  //
  // 补的是两件事:①「停用」这一轴在第 3 批新目录路由 `GET /api/app/v1/activities` 上**零覆盖**
  // (既有 INACTIVE→403 只钉在旧的 `activities/available` 与 `activities/:id` 上;该 spec 的
  //  `createMember()` 恒建 `MemberStatus.ACTIVE`,`UserStatus` 一次都没出现过);
  // ②合同要的是「**组合**」,而此前没有任何用例同时跨两轴。
  //
  // 判据形状 = 一次读出**六个人 × 两个活动**的完整矩阵(比集合,不比计数),
  // 目录路由与详情路由**各走一遍**(两处实现,只测目录会漏掉"列表藏住了、知道 id 还能直接读"):
  //   正向 → 正式且受邀者两个都看得到(矩阵非恒空);
  //   反向 → 未受邀看不到邀请制那个;非正式看不到内部那个;
  //   ⭐ 组合 → **非正式 × 受邀**:只看得到邀请制那个(两轴结论叠加,任一轴单独给不出);
  //   ⭐ 组合 → **停用 × (正式 + 受邀)**:另两轴全满足仍被挡在门外,
  //             证明停用压过可见性计算,而不是"少看到几条"。
  // ⚠️ 停用**两条路分码断言**,不许合并成一句"停用就是看不到":
  //     `User.status=DISABLED` → JwtStrategy 每请求查库 ⇒ **40100**;
  //     `Member.status=INACTIVE` → App 准入闭包 ⇒ **40300**。合并会让"401 退化成 403"看不出来。
  // ⭐ 变异对拍(本机,`app-identity.resolver.ts` 把 `MEMBER_INACTIVE` 分支改成放行):
  //    **本刀这条变红,既有 11 条全绿**。
  'ADV-019': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle: 'ADV-019 正式/停用/非正式/未受邀四轴在新目录路由上的可见性组合矩阵',
    },
  ],
  // AC-014「活动存在**有效**现场事实时普通取消被拒绝,必须**改走提前终止并结算**。」
  //
  // 第 5 批已交付「有现场事实 ⇒ 普通取消被拒」并有 App / Admin 两个真用例;本条补余下三格:
  //   ①「**有效**」这个限定 —— 已被 void 顶掉的事实不得继续拦着取消。
  //      此前只有纯函数单测(`settlement-segment-projector.spec.ts`),**HTTP 层零证据**;
  //      而这一格最容易悄悄退化:把 `resolveEffectiveFacts(...)` 换成 `punchEvents.length > 0`
  //      会让功能"更严",既有用例一条都不会红。
  //   ②「必须改走提前终止」→ 同一条被拒的活动 terminate 成功(此前 `/terminate` 只在
  //      **零打卡**的活动上被测过,取消被拒 → terminate 这条链全仓零覆盖);
  //   ③「并结算」→ 终止之后结算真相链的第一步(封场)接受它。
  //
  // 正向对照:同形态、**零打卡**的活动取消成功 —— 没有它,那条 20030 可能来自任何别的闸。
  // ⚠️ 夹具让**场次在未来**(取消的时间闸开着)⇒ 20030 只可能来自事实闸;
  //    而 terminate 的时间闸恰恰相反,两闸互斥,故链的第二步之前把活动时刻整体挪到过去。
  //
  // ⭐ 变异对拍(本机,`activity-status-command.service.ts` 把
  //    `resolveEffectiveFacts(punchEvents).length > 0` 换成 `punchEvents.length > 0`):
  //    **本刀这条变红,既有 13 条全绿**。
  //
  // ⚠️ 两处口径边界,写清楚免得后来者高估:
  //   · ③ 证明的是"终止之后结算能**开始**",不是整条结算链走通(那由 settlement 族 spec 覆盖);
  //   · 20030 `ACTIVITY_STATUS_INVALID` 是**共用码**(状态机 / 时间闸 / 事实闸同一个),
  //     所以本条不靠码本身分辨,靠"场次在未来 + 零打卡对照成功"把被测那一维单独暴露。
  //
  // ⭐ 顺带记一个动手才知道的事实:`AttendancePunchEvent` 在 DB 上是 **append-only**
  //    (触发器直接拒绝 UPDATE,实测 `attendance punch event is append-only`),
  //    所以夹具里打卡时刻只能一次写对,不能事后平移。
  'AC-014': [
    {
      file: 'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
      needle:
        'AC-014 有效现场事实拦住普通取消；作废那条事实后可取消；同一条活动的正路是终止并进结算链',
    },
  ],
  // AC-022「100 人每人参加 3 场时,活动总名额占 100,场次参与人次合计 300。」
  //
  // **两条去向各承担一半,写清楚谁承担什么**:
  //   · 第一条(既有,service 级)承担合同这句的**绝对数字**:`activity_person` 桶
  //     `occupied: 100`、三只场次桶 `[100,100,100]`、合计 300 —— 逐字就是合同那两个数;
  //   · 第二条(本刀新增,HTTP 级)承担**同一结论在生产入口上也成立**:此前 HTTP 侧最大
  //     只跑到 1–2 人,且**没有任何 HTTP 用例在同一 member 拿下第二个场次之后回读
  //     `activity_person` 桶** —— 也就是"一人多场只占 1 个活动位"这句在真报名入口上零证据。
  //
  // 本刀那条的三层:
  //   ① 正向 → 一人一次提交三场,三条身份全 `pass`,场次桶合计 3,而活动位桶 **occupied = 1**;
  //   ② 反向 → 第二个人同样报三场 ⇒ 活动位 **2**、人次 **6**。
  //     ①排除"每场各占一个活动位",②排除"活动位写死成 1",两个方向各堵一种坏实现;
  //   ③ 桶的 occupied 与在册 active 预留行数**逐类相等**(两条独立路径互为对拍)。
  //
  // ⭐ 变异对拍的**如实读数**(三轮,其中两轮是有价值的阴性):
  //   · 把 `planReserveCreates` 里那句 activity_person 意图**搬进逐场次循环**(= 每场各发一个)
  //     ⇒ **26 条全绿,变异是惰性的**;换成"每场用各自 identity 发一个"⇒ **仍然 26 全绿**。
  //     原因查清了:意图与 delta 都按 `target` 归并(`planCapacityReservationDeltas` 把同桶
  //     变化折叠成一条),所以"多推几次同一个活动位意图"在结构上根本到不了库。
  //     ⇒ 这不是判据钝,是**这一类坏实现在本仓写不出来**:一人一活动位由三处独立执行位守着
  //     (意图按 target 归并 / DB partial unique `capacity_reservation_member_activity_active_person_unique`
  //     / 释放路径留到最后一场)。
  //   · 真能移动被测量的那一轮:`applyBucketDeltas` 跳过 `activity_person` 桶的记账
  //     ⇒ 本条变红(证明它读的确实是那只桶),但**同时红了 11 条既有用例** ⇒ 只证明接线,
  //     不证明红集独占。**如实写在这里,不把它说成"只红本条"。**
  //
  // ⚠️ 口径边界:本条**不**在 HTTP 上跑 100 人;10000 人那档是 B 档(PG 共享锁表天花板),明确不做。
  'AC-022': [
    {
      file: 'test/e2e/activity-batch4-capacity-reservation.e2e-spec.ts',
      needle: 'counts 100 members across three sessions as 100 people and 300 attendance instances',
    },
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: 'AC-022 一人报三场只占 1 个活动位、场次人次按场计 —— 真 HTTP 报名入口回读容量桶',
    },
  ],
  // AC-019「邀请有接受、拒绝、撤回和过期入口;**接受邀请仍检查硬资格、保险、名额和必要表单**。」
  //
  // 前半句(四个入口)既有真用例:接受在 `activity-batch4-allocation-runtime`,
  // 拒绝 / 撤回 / 过期在 `activity-batch4-invitation-visitor`。
  // 后半句此前只落了**名额**一格(`capacityReservationId` + first_come pass/pending),
  // 硬资格 / 保险 / 必要表单三格的断言**全在自助报名入口上**;三条既有 accept 用例一律
  // `formVersion: null, answers: []`、活动上没有 active Form ⇒ 那三格在**邀请入口**上零证据。
  //
  // ⚠️ 订正一处旧卡点:原写「accept 缺其自身的资格/保险/容量 caller」是**错的** ——
  //    accept 刻意**不建**自己的 caller,而是在 Activity→Invitation 锁序内复用 canonical
  //    `submitInTransaction(source: 'invitation')` 的同一组闸(不留邀请旁路)。
  //    本条要证的正是"复用"在邀请入口上真的成立。
  //
  // 三格各一条负例,表单那格另带正对照:
  //   ① 硬资格 block ⇒ 21040;② 保险要求未满足 ⇒ 26030;
  //   ③ 表单版本对不上 ⇒ 21036;版本对但必填没答 ⇒ 21037;**答齐 ⇒ 201**(正对照,
  //     证明这道闸不是"一律拒绝",三条负例才有意义)。
  //   每条负例都回读:邀请仍 `pending` / `respondedAt` 仍空、该活动上**零身份行**
  //   —— 拒绝是零写,不是"写了再回滚一半"。
  //
  // ⭐ 变异对拍的**如实读数**(两轮,第一轮是有价值的阴性):
  //   · 只把 `registration-command.service.ts` 的 `assertNoBlock(qualification)` 卸掉
  //     ⇒ **27 条全绿** —— 因为硬资格在这条路上有**两处**独立执行位:
  //     canonical 命令里一处,`activity-allocation.service.ts` 的 first_come 落位前**再冻一次**。
  //   · **两处一起卸掉** ⇒ **只有本条变红,既有 26 条全绿**。
  //     ⇒ 判据绑的是"这条路上资格 block 必然生效"这个性质,而不是某一行代码;
  //     顺带实测到:这两处此前在本 spec 里**一处都没有用例在守**。
  //
  // ⚠️ 保险那格的口径:`requireForActivityRegistration()` 在
  //    `INSURANCE_ENFORCEMENT_ENABLED` **关闭时也会**抛 26030(退到 `hasCompatibilitySource`),
  //    所以本条不依赖该开关;开关只改"用哪条来源判定",不改"要不要判"。
  'AC-019': [
    {
      file: 'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
      needle: 'AC-019 接受邀请入口自己也过硬资格 / 保险 / 必要表单三闸(名额那格已由既有用例覆盖)',
    },
  ],
  // ADV-011「同一结算项同时申请两个更正。」
  //
  // 此前证据只有两层,**中间那层是空的**:串行层(⑨「同一 target 先后两次 ⇒ 20101」)与
  // schema 层(partial unique `attendance_correction_request_open_unique`,`NULLS NOT DISTINCT`)。
  // **真并发**这一层全仓零覆盖 —— 更正线在本刀之前是单实例的,物理上写不出竞态。
  //
  // 本刀给 `activity-settlement-correction.e2e-spec.ts` 加了**第二套 Nest / Prisma pool**,
  // 并沿 `activity-settlement-review-concurrency` 的手法用第三个事务当闸门:
  //   ⚠️ `Promise.all(两个 service 调用)` 是假并发(Node 单线程 + 交互事务会先后串行走完),
  //      那样的用例在**没有任何锁**的实现上也会绿。
  //   真构造 = 闸门事务先攥住 Activity 行锁 → 两条提交双双堵住 →
  //      用 `pg_stat_activity` 的 `wait_event_type='Lock'` **正面数到 2 个等待者** → 放闸。
  //   ⚠️ 轮询上限压到 3s(提交吃 Prisma 默认 5s 事务预算),放闸写在 `finally`,
  //      屏障异常在 `allSettled` 之后才抛 —— 否则屏障超时会泄漏闸门事务、把后面所有用例带红。
  //
  // 三层:①两套实例确实是两套 pool(前提);②同 target 恰 1 成功 / 败者 20101 /
  // **库里该 target 恰 1 行**(不是"报了错却留下两行");③正对照:**不同 target** 的两条
  // 同样并发提交**双双成功**,证明串行化按 target 收,而不是"任意两条并发必死一条"。
  //
  // 🔴 **变异对拍给出的是一个诚实的阴性结果,连同结论一起写在这里**:
  //   · 只卸掉 service 侧 `assertNoOpenRequest` ⇒ **24 条全绿**(DB partial unique 兜住,
  //     P2002 仍被翻成 20101);
  //   · 只卸掉 P2002→20101 的翻译 ⇒ 同样全绿(service 侧先拦下);
  //   · **两处一起卸掉** ⇒ 本条与既有串行那条 ⑨ **同时**变红。
  //   ⇒ 结论:**在当前锁协议下,「同时申请两个更正」会退化成串行情形** ——
  //     Activity 行锁把第二条提交推到第一条 commit 之后,它读到的是**已提交**的进行中申请,
  //     于是走的正是串行用例那条路,DB partial unique 在竞态里根本够不到。
  //     所以本条的红集与 ⑨ 相同,它**不多守一条实现路径**;它多出来的是三样:
  //     (a) 用锁等待者读数**正面证明**两条提交真的在排队(此前"并发"只是措辞);
  //     (b)「库里恰 1 行」这个后置条件(⑨ 没有);
  //     (c) 不同 target 双双成功的正对照(⑨ 没有,少了它无法排除"一律死一条")。
  //   **不把它写成"新增一道执法"** —— 它是把合同这句从"没验过"变成"验过且知道边界在哪"。
  'ADV-011': [
    {
      file: 'test/e2e/activity-settlement-correction.e2e-spec.ts',
      needle: '🔴 同一 target 两条真并发申请 ⇒ 恰 1 条成功、败者 20101,库里恰 1 行',
    },
    {
      file: 'test/e2e/activity-settlement-correction.e2e-spec.ts',
      needle: '正对照:两条并发申请打在**不同** target 上 ⇒ 双双成功(串行化是按 target 收的)',
    },
  ],
  // ─────────────────────────────────────────────────────────────────────────
  // 2026-08-25 「只清缺测试那批」刀:本刀只加下面这一条。
  // ─────────────────────────────────────────────────────────────────────────
  //
  // AC-063「关账与最后一次终审、最后一个更正并发时按活动锁串行,不漏检查、不重复关闭。」
  //
  // 原卡点里那句「写它要先给 `activity-settlement-closure.e2e-spec.ts` 加第二实例」
  // **实测已过期**:更正 spec 在 `ADV-011` 那一刀里已经把双实例手法立住了,本条因此
  // 新开一份 `activity-settlement-closure-concurrency.e2e-spec.ts`(与
  // `activity-settlement-review-concurrency` 同形),不动既有关账 spec 一个字。
  //
  // 四格逐个绑(合同这句拆成四格,一条用例守一格或多格):
  //   ①「关账 × 最后一个更正 按活动锁串行」+ ③「不漏检查」→ 第一条 needle。
  //     ⭐ 这条是**判决翻转**型判据,不是"反正没成功":关账**发起的那一刻**,
  //     入口世界里同时有 `closure_already_active`(rev 1 仍 active)与
  //     `pending_work_exists`(更正申请仍 `applying`)两类缺口 —— 若八类检查在取锁**之前**
  //     跑,关账必然 blocked;它实际返回 `closed` 且 revision=2,只可能是锁后复判。
  //     把 `evaluateChecks` 挪到 `lockActivityAndReadNow` 之前,这条当场变红。
  //   ②「关账 × 最后一次终审 按活动锁串行」→ 第三条 needle。
  //     ⚠️ **诚实标注(别把它读强)**:这一格做不成判决翻转 ——
  //     `AttendanceSettlementRun.statusCode` 是单值状态机,「终审可受理」
  //     (pending_final_review)与「关账可放行」(posted/closed)**互斥**,
  //     终审在飞时关账在任一交错顺序下都必然 blocked。故这条的判别力来自
  //     (a) `pg_stat_activity` 锁等待者读数(锁被挪走 / 挪到检查之后 ⇒ 读数归零 ⇒ 红)、
  //     (b) 缺口清单**只差**结算未生效那一类(其余六类逐条断言不在里面 ⇒ 夹具在别的维度全合格)、
  //     (c) 零部分写入,并由同一条用例尾部的**正对照**(账走完之后关账成功)证明它不是恒红。
  //   ⭐ **变异对拍读数(2026-08-25 本机连库实测)**:把两类决定性计数换成**取锁前**的快照
  //      (锁照取 ⇒ 屏障读数不变,单独隔离「锁后复判」这一维)⇒ **第一条与第二条红、
  //      第三条与前提条绿**(2/4,红集精确);第一条的红**落在判决翻转那一行**
  //      (缺口恰是预测的 `pending_work_exists.pendingCorrection=1` + `closure_already_active=1`),
  //      不是落在屏障上 ⇒ 判别力确实来自「锁后复判」。还原后 4/4 复绿。
  //      —— 这条读数回答了 `#1182` 留下的问号:这类竞态用例**不必然**独占红集为空。
  //   ④「不重复关闭」→ 第一条(2 条 revision 恰 1 条 active)与第二条(真并发两关账恰 1 成功)。
  //     ⚠️ 第二条与既有关账 spec 里那条同名意图的用例**不是重复**:那一条是单 app / 单 pool
  //     的 `Promise.all`(Node 单线程 + 交互事务会先后串行走完,**没有任何锁也会绿**);
  //     这一条是两套 pool + 闸门事务,并正面数到**两个**等待者。
  'AC-063': [
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle: '⭐ 更正 commit 在关账等锁期间落地 ⇒ 关账按**锁后**状态复判并成功(不漏检查)',
    },
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle: '两条关账真并发(不同 key)⇒ 恰一条成功,败者 closure_already_active,库里恰一张 active',
    },
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle:
        '⭐ 终审 commit 在关账等锁期间落地 ⇒ 关账排在同一把 Activity 锁后,按锁后状态判缺口且零写入',
    },
  ],
};

/**
 * ADV-018 收口(2026-08-25):**单场次取消只影响该场次**。
 *
 * 第 3 批第一刀在自己的卡点表里记的是「实现层与合同相反」—— 那句话在当时属实,现在由本刀实装。
 * 按本登记表的既定形状(ADV-001 / ADV-004 同形),前批的卡点行**保留**为它自己的欠账记录,
 * 后批在这张去向表里给真去向;去向恒优先于卡点。
 *
 * 去向选的是**反向**判据,不是「有一条用例」:三格各自「正面数出 B 场次纹丝不动」的那一条
 * 逐条点名 —— 只点正向会让这条登记在「按活动广播」回潮时看不见。
 *
 * 🔴 点的是**用例名**不是断言体的某一行。理由是本刀实测的两件事:
 *   ① 断言体那种 needle 一跑 prettier 就可能换行 / 改缩进,登记会因排版而假红;
 *   ② 三格必须**各自成 `it`** —— 第一版七格塞一个 `it` 里,变异 M1 红在正向那条上,
 *      jest 首个失败即停,三条反向**一条都没被执行到**,「反向有判别力」根本观测不到。
 *      点用例名等于把「拆开」这件事本身也钉住:合回一个 `it` 会让这些 needle 全部失配。
 */
const ADV018_SESSION_CANCEL_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'ADV-018': [
    // 正向三格:A 场次的人被退、A 的码被作废、A 场次的人收到通知。
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'people · forward: every identity enrolled in session A is auto-cancelled',
    },
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'qr · forward: session A credential is revoked with actor and reason',
    },
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'notification · forward: exactly the two session-A enrolees are notified',
    },
    // ⭐ 反向①人员(变异 M1 打红的正是这两条):B 场次那两行逐字段(含 updatedAt / version)
    //    与取消前完全相等,且**一条新修订都不许多出来**(只断言「没变 cancelled」不够)。
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'people · reverse: session B identities are byte-identical, field by field',
    },
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'people · reverse: session B identities gained no new revision row',
    },
    // ⭐ 反向②二维码(变异 M2 的红集恰为这一条):B 的凭证整行不变。
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'qr · reverse: session B credential row is unchanged, updatedAt included',
    },
    // ⭐ 反向③通知(变异 M3 打红的两条之一):只报了 B 的人一条都没收到 —— 正面数出 0。
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'notification · reverse: the B-only member received zero session-cancel intents',
    },
    // 第四格:活动级人口版本指针递增(§3.17 把「场次取消」列为递增来源)。
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle: 'settlement population · the activity-level revision pointer advanced by one',
    },
    {
      file: 'test/e2e/activity-session-cancel-effects.e2e-spec.ts',
      needle:
        'stays idempotent: re-approving the same review replays without touching anyone twice',
    },
    // 接线本体:第 5 批留下的 applyQrCredentialsPlaceholder 空桩已被真联动取代。
    {
      file: 'src/modules/activities/activity-publish-proposal-v2.service.ts',
      needle: 'await activitySessionCancellationEffects.applyInTransactionTrusted(',
    },
    // 顺序判据:联动必须排在容量投影之后(投影器才是「还有人占名额就不许取消」那道闸)。
    {
      file: 'src/modules/activities/activity-publish-proposal-v2.service.spec.ts',
      needle: "'session-cancel-effects',",
    },
  ],
};

/**
 * 归档动作刀(2026-08-25;§6.6 + 维护者三问拍板)。
 *
 * ⭐ 只接 **AC-004** 一条。它的四格逐条对上:
 *   ① 「长期未处理草稿在工作台提示」→ 列表行上的 `staleDraft`(与归档闸共用 `isStaleDraft`,
 *      两处各写一遍必漂移,那条同源判据在 activity-archive-policy.spec.ts);
 *   ② 「可人工归档」→ `POST /my/managed-activities/{id}/archive`,草稿路径正反两向都有用例;
 *   ③ 「不自动删除」→ 归档只改 statusCode,e2e 回读库行断言活动仍在、且撤销后能退回原状态;
 *   ④ 「不新增清理定时任务」→ 本刀零 cron,由 docs:counts 的「cron 全仓恒 2 个」持续守着,
 *      这里不重复钉一遍(重复钉会造出第二份真相)。
 *
 * 🔴 **AC-064 / ADV-022 刻意不接**:归档动作本身有了,但
 *   - AC-064 的「7 天等待结束后可以归档」那一半需要一条真 closure(三条必填外键),
 *     当前只有纯函数判据、**没有 HTTP 证据**;
 *   - ADV-022 要的是「更正提交/生效 × 关账 × 归档」的**真并发**屏障,本刀零并发用例。
 *   两条的卡点说明已就地收窄,不拿「动作做出来了」冒充「那一格证到了」。
 *   ⚠️ 这两条已于 2026-08-26 由「只缺测试那批」补齐,去向见
 *      `TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS`;上面这段只作历史记录。
 */
const ARCHIVE_ACTION_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-004': [
    {
      file: 'test/e2e/activity-archive-action.e2e-spec.ts',
      needle: '长期无人处理的草稿可以归档,并落下归档四件事实',
    },
    {
      file: 'test/e2e/activity-archive-action.e2e-spec.ts',
      needle: '刚碰过的草稿不能归档(20155),且库里一列都没写',
    },
    {
      file: 'test/e2e/activity-archive-action.e2e-spec.ts',
      needle: '工作台列表把长期无人处理的草稿标成 staleDraft,刚碰过的不标',
    },
    {
      file: 'test/e2e/activity-archive-action.e2e-spec.ts',
      needle: '撤销归档退回归档前的状态,而归档留痕一列都没被抹',
    },
    {
      file: 'src/modules/activities/activity-archive-policy.spec.ts',
      needle: 'isStaleDraft:工作台提示与归档闸同源',
    },
  ],
};

/**
 * 「只缺测试那批」(2026-08-26)—— 三条编号的功能都已交付,缺的一直是**证据**。
 *
 * 逐条对上合同原句的**每一格**,不拿「覆盖了一半」凑完成数:
 *
 * ⭐ **AC-064**「7天归档等待结束后可以归档，但合法更正不因7天过去而被永久禁止。」
 *   · 后半句 → 关账 spec ⑥「归档等待期早已过去 ⇒ 让位后重新关账照样成功」(既有);
 *   · 前半句此前**只有纯函数证据**,本刀在关账 spec 里接出 HTTP 续链,四格各自成 `it`:
 *     满 7 天放行 / 关账当刻拒 20157 / 差 2 小时仍拒 / `archiveWaitingDays=0` 当刻放行。
 *     四条合起来把闸钉死在 `closedAt + Activity.archiveWaitingDays`:少任一条,
 *     「永远拒」「关过账就放行」「阈值取多大都行」「把 7 写成常量」各有一种能全绿。
 *
 * ⭐ **AC-066**「发布通知可以选择目标组织、标签或明确不广播；取消、改期等事件冻结收件人后异步展开。」
 *   · 目标组织 → `activity-recipient-freeze.spec.ts` ⑥(既有);
 *   · 标签 → 冻结 spec「发布即冻结」;明确不广播 → 同 spec 的 legacy 广播盖章(既有);
 *   · 取消事件 → ADV-016 那条(既有);
 *   · **改期事件** → 本刀补:集合 / 异步展开 / 盖章三格各自成 `it`。整项因此才收口。
 *
 * ⭐ **ADV-022**「更正提交或生效与关账、归档同时发生。」= 2×2 一张表:
 *   | | 关账 | 归档 |
 *   |---|---|---|
 *   | 更正生效 | AC-063 并发 spec ②(既有) | 本刀 ⑤-a(判决翻转 → 20156) |
 *   | 更正提交 | 本刀 ⑤-b(判决翻转 → pending_work_exists) | 本刀 ⑤-c |
 *   另加 ⑤-d「归档 × 关账」—— 归档与关账取同一把 Activity `FOR UPDATE`,
 *   这条接缝是归档刀(2026-08-25)新造的,此前全仓零并发用例。
 *   四条都用两套 app / 两套 pool,并用 `pg_stat_activity` **正面数出锁等待者**。
 */
const TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS: Readonly<
  Record<string, readonly AcceptanceDestination[]>
> = {
  'AC-064': [
    // 前半句「等待结束**后可以归档**」—— 正向。
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: 'AC-064 关账已过 7 天 ⇒ 归档放行(HTTP 200,reasonCode=settled)',
    },
    // 反向:等待期一天都没过。
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: 'AC-064 关账当刻(等待期 7 天)⇒ 20157,归档六列一列都没写',
    },
    // 边界(下侧):差 2 小时不满 7 天。
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: 'AC-064 只差 2 小时不满 7 天 ⇒ 仍是 20157(阈值不是「关过账就行」)',
    },
    // 参数化:阈值读的是活动那一列,不是写死的 7。
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: 'AC-064 archiveWaitingDays=0 ⇒ 关账当刻即可归档(等待期读的是活动那一列)',
    },
    // 后半句「合法更正不因 7 天过去而被永久禁止」。
    {
      file: 'test/e2e/activity-settlement-closure.e2e-spec.ts',
      needle: '归档等待期早已过去 ⇒ 让位后重新关账照样成功(不把门焊死)',
    },
  ],
  'AC-066': [
    // 前半句三个可选项。
    {
      file: 'src/modules/activities/activity-recipient-freeze.spec.ts',
      needle: '⑥ 组织定向 —— 交集与真子树',
    },
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: '发布即冻结:每条 intent 都带齐依据/时刻/算法版本/基数,且基数与实际行数相等',
    },
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'legacy 广播(不带标签)拿到显式的 broadcast-visibility 盖章,而不是悄悄没有快照',
    },
    // 后半句点名的两个事件:取消(既有)+ 改期(本刀补,三格)。
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'ADV-016 取消通知:intent 形成后**报名名单**再变,原事件收件人仍逐字冻结',
    },
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'AC-066 改期即冻结:收件人恰为改期那一刻的在册报名者,改期前已退出的不在内',
    },
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'AC-066 改期 intent 形成后名单再变:抽干 outbox 后实收集合与快照逐字相同',
    },
    {
      file: 'test/e2e/activity-batch7-recipient-freeze.e2e-spec.ts',
      needle: 'AC-066 改期批自带 registration-roster 盖章,且与发布批是两批 cohort 互不吞并',
    },
  ],
  'ADV-022': [
    // 更正生效 × 关账(既有)。
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle: '⭐ 更正 commit 在关账等锁期间落地 ⇒ 关账按**锁后**状态复判并成功(不漏检查)',
    },
    // 更正生效 × 归档。
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle:
        '⭐ ADV-022 更正 commit 在归档等锁期间落地 ⇒ 归档按锁后状态复判、被 20156 挡下且零写入',
    },
    // 更正提交 × 关账。
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle:
        '⭐ ADV-022 更正 submit 在关账等锁期间落地 ⇒ 关账按锁后状态复判、被 pending_work_exists 挡下且零写入',
    },
    // 更正提交 × 归档。
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle: 'ADV-022 归档握锁时更正提交排队 ⇒ 归档落地后更正仍提交成功(合法更正不被归档禁掉)',
    },
    // 归档 × 关账(同一把 Activity 行锁的第三条路径)。
    {
      file: 'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
      needle: '⭐ ADV-022 关账在归档等锁期间落地 ⇒ 归档按锁后状态复判并放行(入口本该是 20156)',
    },
  ],
};

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
  // 分拣表排在最前:它的结论优先于各批自己的历史卡点行(去向恒优先于卡点)。
  TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS,
  TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS,
  ARCHIVE_ACTION_ACCEPTANCE_DESTINATIONS,
  ADV018_SESSION_CANCEL_ACCEPTANCE_DESTINATIONS,
  BATCH7_CLOSEOUT_ACCEPTANCE_DESTINATIONS,
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

/**
 * 卡点表同样只写一处 —— 与去向表**同构**。
 *
 * 🔴 立项理由(第 7 批第 ④ 刀):卡点此前走的是一条手写的 `??` 链外加三个并列 `if`,
 *    与去向表在第 6 批修掉的**是同一个失效形状**:新加一张卡点表却忘了接进去,
 *    该批编号会静默退化成**没有卡点说明**的裸 `it.todo` —— 整套照样全绿,
 *    而维护者从读数上完全看不出「这条的卡点丢了」。
 *    去向那边已经有守类判据,卡点这边此前一个执行位都没有。
 *
 * 数组顺序**逐字保持**原 `??` 链与 `if` 分支的求值先后,不改任何既有渲染结果。
 */
const ACCEPTANCE_BLOCKER_TABLES: ReadonlyArray<Readonly<Record<string, string>>> = [
  BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS,
  BATCH4_RESERVATION_KERNEL_ACCEPTANCE_BLOCKERS,
  BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS,
  BATCH2_ACCEPTANCE_BLOCKERS,
  BATCH3_SLICE1_ACCEPTANCE_BLOCKERS,
  BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS,
  BATCH7_CLOSEOUT_ACCEPTANCE_BLOCKERS,
];

function resolveAcceptanceBlocker(id: string): string | undefined {
  for (const table of ACCEPTANCE_BLOCKER_TABLES) {
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

    const blocker = resolveAcceptanceBlocker(id);
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

  /**
   * 上面那条只守**第 6 批**这一个实例 —— 第 7 批第一刀实测:把本批 destinations 从
   * `ACCEPTANCE_DESTINATION_TABLES` 里摘掉,编号静默退回 todo(42→43),而整套仍然全绿。
   * 也就是说「接通」这件事在**新批次**上没有执行位。
   *
   * 所以这条守的是**类**而不是实例:凡是登记了去向的批次,都必须能从查表链里被解析到。
   * 以后新增一批只要把它登进下面的 `SECTIONS`,漏接那一行当场红。
   */
  it('每一个登记了去向的批次都真的接进了查表链(守类,不守某一批)', () => {
    const SECTIONS: ReadonlyArray<{
      name: string;
      table: Readonly<Record<string, readonly AcceptanceDestination[]>>;
    }> = [
      { name: 'TRIAGE_2026_08', table: TRIAGE_2026_08_ACCEPTANCE_DESTINATIONS },
      { name: 'TEST_GAP_2026_08_26', table: TEST_GAP_2026_08_26_ACCEPTANCE_DESTINATIONS },
      { name: 'ARCHIVE_ACTION', table: ARCHIVE_ACTION_ACCEPTANCE_DESTINATIONS },
      { name: 'ADV018_SESSION_CANCEL', table: ADV018_SESSION_CANCEL_ACCEPTANCE_DESTINATIONS },
      { name: 'BATCH2', table: BATCH2_ACCEPTANCE_DESTINATIONS },
      { name: 'BATCH3_SLICE1', table: BATCH3_SLICE1_ACCEPTANCE_DESTINATIONS },
      {
        name: 'BATCH4_REGISTRATION_COMMAND',
        table: BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_DESTINATIONS,
      },
      {
        name: 'BATCH4_QUALIFICATION_RUNTIME',
        table: BATCH4_QUALIFICATION_RUNTIME_ACCEPTANCE_DESTINATIONS,
      },
      {
        name: 'BATCH4_ONSITE_PARTICIPATION',
        table: BATCH4_ONSITE_PARTICIPATION_ACCEPTANCE_DESTINATIONS,
      },
      {
        name: 'BATCH4_INVITATION_VISITOR',
        table: BATCH4_INVITATION_VISITOR_ACCEPTANCE_DESTINATIONS,
      },
      {
        name: 'BATCH4_ACTIVITY_START_EXPIRY',
        table: BATCH4_ACTIVITY_START_EXPIRY_ACCEPTANCE_DESTINATIONS,
      },
      {
        name: 'BATCH4_PERMANENT_REGISTRATION',
        table: BATCH4_PERMANENT_REGISTRATION_ACCEPTANCE_DESTINATIONS,
      },
      { name: 'BATCH5_SELF_PUNCH', table: BATCH5_SELF_PUNCH_ACCEPTANCE_DESTINATIONS },
      { name: 'BATCH6_CLOSEOUT', table: BATCH6_CLOSEOUT_ACCEPTANCE_DESTINATIONS },
      { name: 'BATCH7_RECIPIENT_FREEZE', table: BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_DESTINATIONS },
      { name: 'BATCH7_CLOSEOUT', table: BATCH7_CLOSEOUT_ACCEPTANCE_DESTINATIONS },
    ];

    // ① 每张登记表都必须**按对象标识**出现在查表链里 —— 摘掉那一行当场红。
    const missingTables = SECTIONS.filter(
      (section) => !ACCEPTANCE_DESTINATION_TABLES.includes(section.table),
    ).map((section) => section.name);
    expect({ 没接进查表链的登记表: missingTables }).toEqual({ 没接进查表链的登记表: [] });

    // ② 每个登记了去向的编号都必须能被解析到(防止被别的表同名键遮蔽)。
    const unresolved = SECTIONS.flatMap((section) =>
      Object.keys(section.table)
        .filter((id) => resolveAcceptanceDestinations(id) === undefined)
        .map((id) => `${section.name}:${id}`),
    );
    expect({ 登记了去向却解析不到的编号: unresolved }).toEqual({
      登记了去向却解析不到的编号: [],
    });

    // ③ 反向:清单与查表链**条数相等** —— 少登记一张表不产生坏链接,只靠 ① 看不见它。
    expect(SECTIONS.length).toBe(ACCEPTANCE_DESTINATION_TABLES.length);
    expect(SECTIONS.length).toBeGreaterThan(0);
  });

  /**
   * 上面那条守的是**去向**表。卡点表此前**一个执行位都没有** —— 手写 `??` 链外加三个
   * 并列 `if`,漏接一张卡点表,该批编号会静默退化成**没有卡点说明**的裸 `it.todo`:
   * todo 计数一点不变、整套全绿,而维护者恰恰是靠那句卡点说明知道「卡在哪、谁该立项」。
   *
   * 第 7 批第 ④ 刀把卡点也收敛成 `ACCEPTANCE_BLOCKER_TABLES` 单一注册处,并在此守类。
   */
  it('每一张卡点表都真的接进了卡点查表链(守类,不守某一批)', () => {
    const BLOCKER_SECTIONS: ReadonlyArray<{
      name: string;
      table: Readonly<Record<string, string>>;
    }> = [
      { name: 'BATCH2', table: BATCH2_ACCEPTANCE_BLOCKERS },
      { name: 'BATCH3_SLICE1', table: BATCH3_SLICE1_ACCEPTANCE_BLOCKERS },
      {
        name: 'BATCH4_REGISTRATION_COMMAND',
        table: BATCH4_REGISTRATION_COMMAND_ACCEPTANCE_BLOCKERS,
      },
      { name: 'BATCH4_RESERVATION_KERNEL', table: BATCH4_RESERVATION_KERNEL_ACCEPTANCE_BLOCKERS },
      { name: 'BATCH4_INVITATION_VISITOR', table: BATCH4_INVITATION_VISITOR_ACCEPTANCE_BLOCKERS },
      { name: 'BATCH7_RECIPIENT_FREEZE', table: BATCH7_RECIPIENT_FREEZE_ACCEPTANCE_BLOCKERS },
      { name: 'BATCH7_CLOSEOUT', table: BATCH7_CLOSEOUT_ACCEPTANCE_BLOCKERS },
    ];

    // ① 每张卡点表都必须**按对象标识**出现在卡点查表链里。
    const missingTables = BLOCKER_SECTIONS.filter(
      (section) => !ACCEPTANCE_BLOCKER_TABLES.includes(section.table),
    ).map((section) => section.name);
    expect({ 没接进卡点查表链的登记表: missingTables }).toEqual({ 没接进卡点查表链的登记表: [] });

    // ② 每个登记了卡点的编号都必须能被解析到(防止被别的表同名键遮蔽)。
    const unresolved = BLOCKER_SECTIONS.flatMap((section) =>
      Object.keys(section.table)
        .filter((id) => resolveAcceptanceBlocker(id) === undefined)
        .map((id) => `${section.name}:${id}`),
    );
    expect({ 登记了卡点却解析不到的编号: unresolved }).toEqual({ 登记了卡点却解析不到的编号: [] });

    // ③ 反向:清单与查表链条数相等,且非空。
    expect(BLOCKER_SECTIONS.length).toBe(ACCEPTANCE_BLOCKER_TABLES.length);
    expect(BLOCKER_SECTIONS.length).toBeGreaterThan(0);

    // ⚠️ 这里**刻意不加**「一个编号不得同时有去向和卡点」那条判据(第 7 批第 ④ 刀试过并撤回):
    //    跨批次交付时,前批在自己的卡点表里记「我这批没做」、后批在自己的去向表里给真去向,
    //    是本登记表的**既定形状**(ADV-001 / ADV-004 即是),不是矛盾;
    //    而且每批的模块级守护本来就要求「本批编号逐条有去向**或**卡点」,
    //    强行去重会让那些守护抛错、整套 `Tests: 0 total`。
    //    「同一编号只能有一个去向」这件事由各批模块级守护 + ② 的遮蔽检查负责。
  });

  it('活文档仍指向本合同目录(指针被删则红)', () => {
    // ⚠️ **恒读层活文档在 2026-08-20(PR #1105)被重排过**:
    // 原先 `docs/current-state.md` §2 承载各域能力摘要,其中就有本合同的指针;
    // 那一刀把整段能力摘要迁去新建的 `docs/ai-harness/CAPABILITIES.md`(恒读预算 100% → 61%),
    // **事实没删,是搬了家**。于是本判据原来点名的 current-state 不再含它。
    //
    // 修法是**让判据跟着事实走**,不是把摘要按回 current-state —— 按回去等于撤销 #1105 的目的。
    // 但**强度保持不变**:仍然要求**两个各自独立的锚点**都在,只是其中一个换了身份
    // (current-state.md → CAPABILITIES.md)。只要求「任意一份里有」会比原判据弱。
    //
    // 若日后 CAPABILITIES.md 再被重排而本条又红:去找那段能力摘要**搬到哪儿了**,
    // 把下面的文件名改成新家;**不要**改成「至少一份含有」来让它变绿。
    const liveDocuments = {
      'docs/ai-harness/NEXT_TASKS.md': readFileSync(
        resolve(process.cwd(), 'docs/ai-harness/NEXT_TASKS.md'),
        'utf8',
      ),
      'docs/ai-harness/CAPABILITIES.md': readFileSync(
        resolve(process.cwd(), 'docs/ai-harness/CAPABILITIES.md'),
        'utf8',
      ),
    };

    const missing = Object.entries(liveDocuments)
      .filter(([, text]) => !text.includes('activity-business-overhaul-v1.1'))
      .map(([name]) => name);
    // 报文件名而不是干巴巴的 toContain 失败 —— 两个锚点时,不说是哪一个丢了会白查一轮。
    expect({ 丢了合同指针的活文档: missing }).toEqual({ 丢了合同指针的活文档: [] });

    expect(liveDocuments['docs/ai-harness/NEXT_TASKS.md']).toContain('P1-28');
  });
});

describe('活动业务改造 v1.1 验收编号(AC-001..072)—— 待实现', () => {
  registerAcceptanceCases(acceptanceCases);
});

describe('活动业务改造 v1.1 对抗测试(ADV-001..023)—— 待实现', () => {
  registerAcceptanceCases(adversarialCases);
});
