import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Prisma } from '@prisma/client';

import {
  ACTIVITY_RECIPIENT_FREEZE_ALGORITHM_VERSION,
  ActivityRecipientFreezeInvariantError,
  freezeAudienceTags,
  freezeRegistrationRoster,
  isFrozenCohort,
  readRecipientFreezeStamp,
} from './activity-recipient-freeze';

/**
 * 收件人冻结的五条不变量(goal D2)。
 *
 * ⚠️ **结构判据一律先剥注释再扫** —— 本仓栽过:判据 grep 到了自己文件头的散文,
 * 于是「实现里有这一行」被一段解释性注释冒充成真。`stripComments` 是这条纪律的落点。
 */

const MODULE_DIR = 'src/modules/activities';
/** 组织子树 / 有效任职的**属主侧** tx 原语(identity-org 域),组织定向的查询长在这里。 */
const ORGANIZATION_AUDIENCE_SCOPE = 'src/modules/organizations/organization-audience-scope.ts';
const OUTBOX_DIR = 'src/modules/notifications';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * 只去注释,**保留字符串字面量** —— 判据要看得见 import 路径这种本就写在字面量里的东西。
 *
 * ⚠️ 本刀实测:一版把字面量也抹掉,`import ... from './activity-recipient-freeze'` 当场
 * 变成 `from ''`,判据于是在断言一个自己刚抹掉的东西。仪器失真的读数照样是读数。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/**
 * 去注释**并**抹掉字符串字面量。用于「这个标识符不许出现」型判据 ——
 * 否则一句字面量里的表名会被当成真的表访问。
 */
function stripCommentsAndStrings(source: string): string {
  return stripComments(source).replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** 四个活动侧 producer(goal P2)。 */
const ACTIVITY_PRODUCERS = [
  'activity-notification-producer.ts',
  'activity-closure-notification-producer.ts',
  'activity-responsibility-notification-producer.ts',
  'settlement-notification-producer.ts',
] as const;

function emptyOutboxTx(): Prisma.TransactionClient {
  return {
    notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as Prisma.TransactionClient;
}

/** 造一个「库里已有冻结批次」的 tx:回捞时返回带盖章的既有 intent 行。 */
function frozenOutboxTx(
  cohortKey: string,
  memberIds: string[],
  computedAt: string,
  basisKind = 'audience-tags',
  basisRef: string[] = ['tag-a'],
): Prisma.TransactionClient {
  return {
    notificationOutboxIntent: {
      findMany: jest.fn().mockResolvedValue(
        memberIds.map((memberId) => ({
          destinationRef: memberId,
          payload: {
            recipientMemberId: memberId,
            recipientFreeze: {
              cohortKey,
              algorithmVersion: ACTIVITY_RECIPIENT_FREEZE_ALGORITHM_VERSION,
              basisKind,
              basisRef,
              computedAt,
              cohortSize: memberIds.length,
            },
          },
        })),
      ),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('收件人冻结 —— D2 五条不变量', () => {
  // ────────────────────────────────────────────────────────────────
  // ① 同事务:intent 与其收件人快照必须在同一事务写入
  // ────────────────────────────────────────────────────────────────
  describe('① 同事务', () => {
    it('冻结入口不持 PrismaService,每个导出函数的第一个形参都是调用方的 tx', () => {
      const code = stripCommentsAndStrings(
        readSource(`${MODULE_DIR}/activity-recipient-freeze.ts`),
      );

      // 自己开事务 = 把「与业务同事务」这件事变成祈祷。
      expect(code).not.toContain('PrismaService');
      expect(code).not.toContain('$transaction');

      const exported = [
        ...code.matchAll(/export (?:async )?function (freeze[A-Za-z]+)\(\s*(\w+)/g),
      ];
      expect(exported.length).toBeGreaterThanOrEqual(3);
      for (const [, name, firstParam] of exported) {
        expect(`${name}:${firstParam}`).toBe(`${name}:tx`);
      }
    });

    it('快照就写在 intent 自己的 payload 里 —— 没有第二次写、也就没有第二个事务', () => {
      // 冻结不产生任何独立的落库动作:盖章是 enqueue payload 的一个键。
      // 于是「快照与 intent 不同事务」在本设计下**无法表达** —— 这是构造性保证,
      // 不是运行时断言。下面钉住这个构造:四个 producer 的盖章全部出现在 payload 内。
      for (const file of ACTIVITY_PRODUCERS) {
        const code = stripComments(readSource(`${MODULE_DIR}/${file}`));
        const payloadBlocks = [...code.matchAll(/payload:\s*\{[\s\S]*?\n(\s*)\},/g)];
        expect(payloadBlocks.length).toBeGreaterThan(0);
        for (const [block] of payloadBlocks) {
          expect(block).toContain('recipientFreeze:');
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ② 重试读快照不重算
  // ────────────────────────────────────────────────────────────────
  describe('② 回读优先于重算', () => {
    it('库里已有冻结批次 ⇒ 返回**那一批**,现实怎么变都不重算', async () => {
      const cohortKey = 'activity-publish-audience:act-1:2026-08-18T00:00:00.000Z';
      const tx = frozenOutboxTx(cohortKey, ['m-1', 'm-2'], '2026-08-18T00:00:00.000Z');

      // 现实已经变了:标签换了一批人。但冻结批次在库里,重算结果必须被丢弃。
      const audience = await freezeAudienceTags(tx, {
        activityId: 'act-1',
        audienceTagCodes: ['tag-changed'],
        at: new Date('2026-08-18T00:00:00.000Z'),
      });

      if (!isFrozenCohort(audience)) throw new Error('cohort expected');
      // 先钉两边非空 —— 空集 == 空集会静默变绿(本仓刚栽过)。
      expect(audience.memberIds.length).toBeGreaterThan(0);
      expect(audience.memberIds).toEqual(['m-1', 'm-2']);
      expect(audience.reused).toBe(true);
      // 依据也照回读的来,不是本次重算的 `tag-changed`。
      expect(audience.stamp.basisRef).toEqual(['tag-a']);
      // 回读路径**没有**去查标签表 —— 查了就说明它其实重算了。
      expect((tx as unknown as { dictType?: unknown }).dictType).toBeUndefined();
    });

    it('回读的 computedAt 逐字沿用原批次 —— 重放的 payload 与库里那行仍逐字节相同', async () => {
      // ⚠️ 这条用 roster 而不是 audienceTags:后者的 cohortKey 由 `at` 推出来,换个 `at`
      //    本来就是**另一个事件**,不构成「同一批次被改写」。这里要测的是 cohortKey 相同、
      //    调用方却传了新时刻的情形 —— 那才是「重放时盖章会不会被改写」。
      const cohortKey = 'settlement-submit:version-1';
      const original = '2026-08-18T00:00:00.000Z';
      const tx = frozenOutboxTx(cohortKey, ['m-1'], original, 'responsibility', ['v1']);

      const cohort = await freezeRegistrationRoster(tx, {
        cohortKey,
        aggregateType: 'activity',
        aggregateIds: ['act-1'],
        basisRef: ['whatever'],
        memberIds: ['m-9'],
        at: new Date('2098-09-09T09:09:09.000Z'),
      });

      expect(cohort.reused).toBe(true);
      // 盖章三件事全部照库里那份:时刻、依据、成员。重算出来的 m-9 / whatever 一个都不进来。
      expect(cohort.stamp.computedAt).toBe(original);
      expect(cohort.stamp.basisRef).toEqual(['v1']);
      expect(cohort.memberIds).toEqual(['m-1']);
    });

    it('回捞到的行数与盖章声明的基数对不上 ⇒ 抛不变量错,不将就返回残缺快照', async () => {
      const cohortKey = 'activity-cancel:act-1:2026-08-18T00:00:00.000Z';
      const tx = {
        notificationOutboxIntent: {
          findMany: jest.fn().mockResolvedValue([
            {
              destinationRef: 'm-1',
              payload: {
                recipientFreeze: {
                  cohortKey,
                  algorithmVersion: 1,
                  basisKind: 'registration-roster',
                  basisRef: [],
                  computedAt: '2026-08-18T00:00:00.000Z',
                  cohortSize: 3, // 声明 3 人,只捞到 1 行
                },
              },
            },
          ]),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        freezeRegistrationRoster(tx, {
          cohortKey,
          aggregateType: 'activity',
          aggregateIds: ['act-1'],
          basisRef: [],
          memberIds: ['m-1'],
          at: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(ActivityRecipientFreezeInvariantError);
    });

    it('库里没有本批次 ⇒ 用本次算的集合,并标 reused=false', async () => {
      const cohort = await freezeRegistrationRoster(emptyOutboxTx(), {
        cohortKey: 'activity-cancel:act-1:2026-08-18T00:00:00.000Z',
        aggregateType: 'activity',
        aggregateIds: ['act-1'],
        basisRef: ['cancel:act-1'],
        memberIds: ['m-2', 'm-1', 'm-2'],
        at: new Date('2026-08-18T00:00:00.000Z'),
      });

      expect(cohort.reused).toBe(false);
      expect(cohort.memberIds).toEqual(['m-1', 'm-2']); // 去重 + 稳定序
      expect(cohort.stamp.cohortSize).toBe(2);
    });

    it('别的批次的 intent 不会被当成本批次回读(cohortKey 隔离同一活动上的多个事件)', async () => {
      // 同一活动上既有「发布」批次也有「取消」批次,aggregateId 相同、cohortKey 不同。
      const tx = frozenOutboxTx(
        'activity-publish-audience:act-1:2026-08-18T00:00:00.000Z',
        ['m-1', 'm-2'],
        '2026-08-18T00:00:00.000Z',
      );
      const cancel = await freezeRegistrationRoster(tx, {
        cohortKey: 'activity-cancel:act-1:2098-08-20T00:00:00.000Z',
        aggregateType: 'activity',
        aggregateIds: ['act-1'],
        basisRef: [],
        memberIds: ['m-9'],
        at: new Date('2098-08-20T00:00:00.000Z'),
      });

      expect(cancel.reused).toBe(false);
      expect(cancel.memberIds).toEqual(['m-9']);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ③ 快照不可变
  // ────────────────────────────────────────────────────────────────
  describe('③ 不可变', () => {
    it('outbox 服务全生命周期都不写 payload —— 盖章一旦落库就改不了', () => {
      const code = stripCommentsAndStrings(
        readSource(`${OUTBOX_DIR}/notification-outbox.service.ts`),
      );

      // `payload` 只准出现在 create/createMany 的 data 里。任何 update / updateMany 的
      // data 段出现 payload,就意味着盖章可被事后改写 —— 那时这条断言必须红。
      const updateBlocks = [
        ...code.matchAll(/\.update(?:Many)?\(\{[\s\S]*?\n(\s*)\}\)/g),
        ...code.matchAll(/\$executeRaw[\s\S]{0,400}?UPDATE[\s\S]{0,400}?;/gi),
      ];
      for (const [block] of updateBlocks) {
        expect(block).not.toContain('payload');
      }
    });

    it('冻结返回的对象是 readonly 视图:改它不会回写到已落库的盖章', async () => {
      const cohort = await freezeRegistrationRoster(emptyOutboxTx(), {
        cohortKey: 'k',
        aggregateType: 'activity',
        aggregateIds: ['act-1'],
        basisRef: [],
        memberIds: ['m-1'],
        at: new Date('2026-08-18T00:00:00.000Z'),
      });
      // producer 落库时是 `{ ...cohort.stamp }` 展开的副本,调用方即便改了手里这份,
      // 也改不到已经写进 payload 的那一份。这里钉住「展开」这个构造。
      const producerCode = stripComments(
        readSource(`${MODULE_DIR}/activity-notification-producer.ts`),
      );
      expect(producerCode).toContain('recipientFreeze: { ...input.cohort.stamp }');
      expect(cohort.stamp.cohortKey).toBe('k');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ④ 四个 producer 同源
  // ────────────────────────────────────────────────────────────────
  describe('④ 四个 producer 同源', () => {
    it('四个 producer 全部从冻结模块取类型,没有第二套收件人算法', () => {
      for (const file of ACTIVITY_PRODUCERS) {
        const code = stripComments(readSource(`${MODULE_DIR}/${file}`));
        expect(code).toContain("from './activity-recipient-freeze'");
      }
    });

    it('producer 不得自己算收件人 —— 任何直查会员 / 标签 / 责任表都是绕过冻结', () => {
      for (const file of ACTIVITY_PRODUCERS) {
        const code = stripCommentsAndStrings(readSource(`${MODULE_DIR}/${file}`));
        // 这四张表是收件人的来源。producer 碰它们 = 它在自算,而不是收冻结批次。
        expect(code).not.toContain('tx.member.');
        expect(code).not.toContain('memberAudienceTagAssignment');
        expect(code).not.toContain('activityResponsibilityAssignment');
        expect(code).not.toContain('dictItem.');
        // 组织定向(2026-08-25)带进来两个新的收件人来源。新增来源必须同时补进这份禁表 ——
        // 否则这条判据只对「本刀之前的四张表」有效,后来的每一个来源都从它底下溜过去。
        expect(code).not.toContain('organizationClosure');
        expect(code).not.toContain('memberOrganizationMembership');
      }
    });

    it('producer 的收件人入参只接受冻结批次,不接受裸 memberIds', () => {
      for (const file of ACTIVITY_PRODUCERS) {
        const code = stripComments(readSource(`${MODULE_DIR}/${file}`));
        // 裸名单入参是本刀之前的形状;留一个就等于留一条绕过冻结的门。
        //
        // ⚠️ `\??:` 不是顺手写的:变异对拍实测,只写 `memberIds:` 时把参数改成**可选**的
        //    `memberIds?: string[]` 就能从判据底下溜过去 —— 而可选参数照样是一条门。
        expect(code).not.toMatch(/\bmemberIds\??:\s*(readonly\s+)?string\[\]/);
        expect(code).not.toMatch(/\bownerMemberId\??:\s*string\s*\|\s*null/);
      }
    });

    it('受众标签解析在全仓只有一份(收敛前 publish-review 与 status-command 各有一份拷贝)', () => {
      const owners = [
        `${MODULE_DIR}/activity-recipient-freeze.ts`,
        `${MODULE_DIR}/activity-publish-review.service.ts`,
        `${MODULE_DIR}/activity-status-command.service.ts`,
      ].filter((file) =>
        stripCommentsAndStrings(readSource(file)).includes('memberAudienceTagAssignment'),
      );

      expect(owners).toEqual([`${MODULE_DIR}/activity-recipient-freeze.ts`]);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ⑤ 受众标签口径不重造(B7 三分支)
  // ────────────────────────────────────────────────────────────────
  describe('⑤ 受众标签三分支', () => {
    it('null ⇒ 广播,不冻结集合,但拿到显式的 broadcast-visibility 盖章', async () => {
      const audience = await freezeAudienceTags(emptyOutboxTx(), {
        activityId: 'act-1',
        audienceTagCodes: null,
        at: new Date('2026-08-18T00:00:00.000Z'),
      });

      expect(isFrozenCohort(audience)).toBe(false);
      expect(audience.stamp.basisKind).toBe('broadcast-visibility');
      expect(audience.stamp.cohortSize).toBe(0);
    });

    it('[] ⇒ 全部 ACTIVE 且未软删会员,basisKind=all-active-members', async () => {
      const member = {
        findMany: jest.fn().mockResolvedValue([{ id: 'm-2' }, { id: 'm-1' }]),
      };
      const tx = {
        notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
        member,
      } as unknown as Prisma.TransactionClient;

      const audience = await freezeAudienceTags(tx, {
        activityId: 'act-1',
        audienceTagCodes: [],
        at: new Date('2026-08-18T00:00:00.000Z'),
      });

      if (!isFrozenCohort(audience)) throw new Error('cohort expected');
      expect(audience.memberIds).toEqual(['m-1', 'm-2']);
      expect(audience.stamp.basisKind).toBe('all-active-members');
      // 口径逐字沿用 B7:ACTIVE + 未软删,一个条件都不能少。
      expect(member.findMany).toHaveBeenCalledWith({
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
    });

    it('非空 ⇒ 按标签 OR 并集去重,且只认未撤销赋标 + ACTIVE 未软删会员', async () => {
      const memberAudienceTagAssignment = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ memberId: 'm-2' }, { memberId: 'm-1' }, { memberId: 'm-2' }]),
      };
      const tx = {
        notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
        dictType: { findFirst: jest.fn().mockResolvedValue({ id: 'type-1' }) },
        dictItem: {
          findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }, { id: 'tag-2' }]),
        },
        memberAudienceTagAssignment,
      } as unknown as Prisma.TransactionClient;

      const audience = await freezeAudienceTags(tx, {
        activityId: 'act-1',
        audienceTagCodes: ['b', 'a'],
        at: new Date('2026-08-18T00:00:00.000Z'),
      });

      if (!isFrozenCohort(audience)) throw new Error('cohort expected');
      expect(audience.memberIds).toEqual(['m-1', 'm-2']); // OR 并集 + 去重 + 稳定序
      expect(audience.stamp.basisKind).toBe('audience-tags');
      expect(audience.stamp.basisRef).toEqual(['a', 'b']); // 依据本身也稳定序,便于对账
      expect(memberAudienceTagAssignment.findMany).toHaveBeenCalledWith({
        where: {
          dictItemId: { in: ['tag-1', 'tag-2'] },
          revokedAt: null,
          member: { status: 'ACTIVE', deletedAt: null },
        },
        select: { memberId: true },
      });
    });

    it('标签码有一个解析不出 ACTIVE 字典项 ⇒ 整批拒绝,不静默少发一批人', async () => {
      const tx = {
        notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
        dictType: { findFirst: jest.fn().mockResolvedValue({ id: 'type-1' }) },
        dictItem: { findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }]) },
      } as unknown as Prisma.TransactionClient;

      await expect(
        freezeAudienceTags(tx, {
          activityId: 'act-1',
          audienceTagCodes: ['a', 'b'],
          at: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ⑥ 组织定向:交集(AND)语义 + 真子树(维护者 2026-08-25 拍板)
  // ────────────────────────────────────────────────────────────────
  //
  // 全节共用**一个**世界。四个人刻意各自只在**一个**维度上与 `m-both` 不同 ——
  // 否则上层边界会遮蔽下层边界,反面样本证不出被测的那一维:
  //
  //   m-both      org-a(直属)   有标签  ⇒ 收到(正向)
  //   m-org-only  org-a(直属)   无标签  ⇒ 不收到(反向①:只差标签这一维)
  //   m-tag-only  org-b(无关)   有标签  ⇒ 不收到(反向②:只差组织这一维)
  //   m-sub       org-a-1(下级) 有标签  ⇒ 收到(只差「直属 vs 下级」这一维)
  //
  // ⚠️ 下面的 mock **真的执行 where 过滤**,不是「无论问什么都返回同一批行」。
  //    这是变异对拍能不能打中的前提:恒返回固定行的 mock 会让「子树改成只取直属」
  //    在读数上完全消失(问的条件变了,答案却没变)。
  describe('⑥ 组织定向 —— 交集与真子树', () => {
    const TAGGED = ['m-both', 'm-tag-only', 'm-sub'];
    const ALL_ACTIVE_MEMBERS = ['m-both', 'm-org-only', 'm-tag-only', 'm-sub'];
    /** ancestorId → descendantId,含 depth-0 自身行(与 organization_closure 建表回填同形)。 */
    const CLOSURE: ReadonlyArray<{ ancestorId: string; descendantId: string }> = [
      { ancestorId: 'org-a', descendantId: 'org-a' },
      { ancestorId: 'org-a', descendantId: 'org-a-1' },
      { ancestorId: 'org-a-1', descendantId: 'org-a-1' },
      { ancestorId: 'org-b', descendantId: 'org-b' },
    ];
    /** 库里真实存在、未软删的组织。`org-ghost` 刻意不在其中 —— 用来钉「打错 id 整批拒」。 */
    const LIVE_ORGANIZATIONS = ['org-a', 'org-a-1', 'org-b'];
    const MEMBERSHIPS: ReadonlyArray<{ memberId: string; organizationId: string }> = [
      { memberId: 'm-both', organizationId: 'org-a' },
      { memberId: 'm-org-only', organizationId: 'org-a' },
      { memberId: 'm-tag-only', organizationId: 'org-b' },
      { memberId: 'm-sub', organizationId: 'org-a-1' },
    ];

    /**
     * 迷你 where 求值器:把 `args.where` 里**每一个** `{ 列: { in: [...] } }` 条件都真的施加到夹具上。
     *
     * ⚠️ 这一小段是变异对拍能不能打中的**前提**,不是装饰。第一版只硬编码解释了
     * `ancestorId.in`,于是「子树改成只取直属」(给闭包查询多加一个 `descendantId.in` 收窄)
     * 在读数上只剩 1 例红 —— 而那 1 例还是 `toHaveBeenCalledWith` 的结构断言,行为侧
     * **一例都没红**:问的条件变了,mock 的答案却没变。恒返回固定行的 mock 会让
     * 「查询被收窄」这一整类变异隐身。
     */
    function applyInFilters<T extends Record<string, string>>(
      rows: readonly T[],
      where: Record<string, unknown>,
    ): T[] {
      return rows.filter((row) =>
        Object.entries(where).every(([column, condition]) => {
          if (
            condition === null ||
            typeof condition !== 'object' ||
            !('in' in (condition as Record<string, unknown>))
          ) {
            return true; // 非 `in` 条件(如 status / deletedAt)由下面的 toHaveBeenCalledWith 断言把关
          }
          const wanted = (condition as { in: string[] }).in;
          return column in row && wanted.includes(row[column]);
        }),
      );
    }

    function orgWorldTx(): {
      tx: Prisma.TransactionClient;
      closureFindMany: jest.Mock;
      membershipFindMany: jest.Mock;
    } {
      const closureFindMany = jest.fn(
        (args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            applyInFilters(CLOSURE, args.where).map(({ descendantId }) => ({ descendantId })),
          ) as unknown,
      );
      const organizationFindMany = jest.fn(
        (args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            applyInFilters(
              LIVE_ORGANIZATIONS.map((id) => ({ id })),
              args.where,
            ),
          ) as unknown,
      );
      const membershipFindMany = jest.fn(
        (args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            applyInFilters(MEMBERSHIPS, args.where).map(({ memberId }) => ({ memberId })),
          ) as unknown,
      );
      const tx = {
        notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
        dictType: { findFirst: jest.fn().mockResolvedValue({ id: 'type-1' }) },
        dictItem: { findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }]) },
        memberAudienceTagAssignment: {
          findMany: jest.fn().mockResolvedValue(TAGGED.map((memberId) => ({ memberId }))),
        },
        member: {
          findMany: jest.fn().mockResolvedValue(ALL_ACTIVE_MEMBERS.map((id) => ({ id }))),
        },
        organization: { findMany: organizationFindMany },
        organizationClosure: { findMany: closureFindMany },
        memberOrganizationMembership: { findMany: membershipFindMany },
      } as unknown as Prisma.TransactionClient;
      return { tx, closureFindMany, membershipFindMany };
    }

    const AT = new Date('2026-08-25T00:00:00.000Z');

    async function freezeWith(input: {
      audienceTagCodes: string[] | null;
      audienceOrganizationIds?: string[] | null;
    }): Promise<{
      memberIds: readonly string[];
      basisKind: string;
      basisRef: string[];
      closureFindMany: jest.Mock;
      membershipFindMany: jest.Mock;
    }> {
      const { tx, closureFindMany, membershipFindMany } = orgWorldTx();
      const audience = await freezeAudienceTags(tx, {
        activityId: 'act-1',
        at: AT,
        ...input,
      });
      if (!isFrozenCohort(audience)) throw new Error('cohort expected');
      return {
        memberIds: audience.memberIds,
        basisKind: audience.stamp.basisKind,
        basisRef: audience.stamp.basisRef,
        closureFindMany,
        membershipFindMany,
      };
    }

    it('正向:在 org-a **且**有标签 ⇒ 收到,且依据落在第 6 个常量上', async () => {
      const result = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: ['org-a'],
      });

      expect(result.memberIds).toContain('m-both');
      expect(result.basisKind).toBe('audience-organizations');
      // 两个维度都要能事后对账,故加前缀区分 —— 混在一起事后分不清哪个是哪个。
      expect(result.basisRef).toEqual(['org:org-a', 'tag:diving']);
    });

    it('反向①:在 org-a **但没有**标签 ⇒ 不收到(与 m-both 只差标签这一维)', async () => {
      const result = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: ['org-a'],
      });

      // m-org-only 与 m-both 同在 org-a、同是 ACTIVE 有效任职,唯一差别就是没有这个标签。
      // 它出现在收件人里 = 交集塌成了并集(或组织维度单独成立即可发)。
      expect(result.memberIds).not.toContain('m-org-only');
    });

    it('反向②:有标签**但不在** org-a ⇒ 不收到(与 m-both 只差组织这一维)', async () => {
      const result = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: ['org-a'],
      });

      // m-tag-only 与 m-both 同样持有这个标签,唯一差别是任职在无关的 org-b。
      expect(result.memberIds).not.toContain('m-tag-only');
    });

    it('交集的**全集**恰好是两条都满足的那两个人 —— 不多不少', async () => {
      const result = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: ['org-a'],
      });

      // 逐个 not.toContain 只能证「这两个人不在」;比集合才能挡住「顺手多发了第五个人」。
      expect([...result.memberIds]).toEqual(['m-both', 'm-sub']);
    });

    it('勾上级**包含下级**:org-a-1 的人也收到,且展开走 organization_closure 真子树', async () => {
      const result = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: ['org-a'],
      });

      // m-sub 只在下级 org-a-1 有任职,直属 org-a 一条都没有。
      expect(result.memberIds).toContain('m-sub');
      // 「含下级」的来源必须是闭包表,不是编码前缀:问的是 ancestorId ∈ 勾选组织。
      expect(result.closureFindMany).toHaveBeenCalledWith({
        where: { ancestorId: { in: ['org-a'] } },
        select: { descendantId: true },
      });
      // 任职口径复用 MembershipTermStateMachine.effectiveWhere:未软删 + ACTIVE + 已生效 + 未终止,
      // 且时刻取业务事件时刻(不是新墙钟)—— 少一个条件就会把已调出的人算回来。
      expect(result.membershipFindMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          startedAt: { lte: AT },
          endedAt: null,
          organizationId: { in: ['org-a', 'org-a-1'] },
        },
        select: { memberId: true },
      });
    });

    it('边界:只勾组织不勾标签([]) ⇒ 组织子树内的**全体**有效会员,不是空集', async () => {
      const result = await freezeWith({
        audienceTagCodes: [],
        audienceOrganizationIds: ['org-a'],
      });

      expect([...result.memberIds]).toEqual(['m-both', 'm-org-only', 'm-sub']);
      expect(result.basisKind).toBe('audience-organizations');
      expect(result.basisRef).toEqual(['org:org-a']);
    });

    it('边界:只勾标签不勾组织 ⇒ 按标签单条件走,盖章逐字沿用本刀之前的形状', async () => {
      const omitted = await freezeWith({ audienceTagCodes: ['diving'] });
      const emptyArray = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: [],
      });
      const explicitNull = await freezeWith({
        audienceTagCodes: ['diving'],
        audienceOrganizationIds: null,
      });

      for (const result of [omitted, emptyArray, explicitNull]) {
        // 空数组**不是**空交集 —— 把它当交集会让「没勾组织」变成「谁都不发」。
        expect([...result.memberIds]).toEqual(['m-both', 'm-sub', 'm-tag-only']);
        // 不收窄时盖章必须与本刀之前逐字节相同:改了就会让在飞的 intent 重放撞 sameIntent。
        expect(result.basisKind).toBe('audience-tags');
        expect(result.basisRef).toEqual(['diving']);
        // 不收窄 ⇒ 一次子树查询都不该发。
        expect(result.closureFindMany).not.toHaveBeenCalled();
        expect(result.membershipFindMany).not.toHaveBeenCalled();
      }
    });

    it('组织 id 解析不出未软删行 ⇒ 整批拒,不静默算出一个空收件人集', async () => {
      const { tx } = orgWorldTx();

      // 打错一个 id 时,子树展开得到空集、交集随之为空 —— 通知一个人都不发却照样 200。
      // 那是「静默少发一整批人」,与标签码解析失败同一类事故,故同一处置(整批 400)。
      // ⚠️ 校验落在冻结这一刻(不是只在提交时):提交与审批之间组织被软删,
      //    不能拿一棵已经不存在的子树算收件人 —— 与标签码在审批时重新解析对称。
      await expect(
        freezeAudienceTags(tx, {
          activityId: 'act-1',
          at: AT,
          audienceTagCodes: ['diving'],
          audienceOrganizationIds: ['org-a', 'org-ghost'],
        }),
      ).rejects.toThrow();
    });

    it('「含下级」不许靠编码前缀糊弄 —— 两个文件都零字符串前缀匹配', () => {
      // 组织是树。前缀匹配在改名 / 跨父移动 / 同前缀兄弟三种情况下都会静悄悄给出错答案。
      // 两个文件都要查:子树查询本身在属主原语里,而冻结模块是它唯一的消费者 ——
      // 只查一个,另一个就是这条判据够不到的地方。
      for (const file of [
        `${MODULE_DIR}/activity-recipient-freeze.ts`,
        ORGANIZATION_AUDIENCE_SCOPE,
      ]) {
        const code = stripCommentsAndStrings(readSource(file));
        expect(code).not.toContain('startsWith');
        expect(code).not.toContain('endsWith');
        expect(code).not.toContain('contains:');
        expect(code).not.toContain('$queryRaw');
      }
    });

    it('子树的唯一来源是闭包表,且查询长在**属主**域里(活动域不直接读组织三表)', () => {
      const primitive = stripCommentsAndStrings(readSource(ORGANIZATION_AUDIENCE_SCOPE));
      // 闭包表 = 树关系的唯一权威源;`ancestorId` 方向 = 「取后代」而不是「取祖先」。
      expect(primitive).toContain('organizationClosure');
      expect(primitive).toContain('ancestorId');

      // 反过来:活动域自己不许直接读组织三表 —— 那是跨域读,架构债棘轮会当场判新增代码债,
      // 而且会让「组织树怎么展开」在每个想按组织圈人的业务域里各有一份解释。
      const freeze = stripCommentsAndStrings(
        readSource(`${MODULE_DIR}/activity-recipient-freeze.ts`),
      );
      expect(freeze).not.toContain('tx.organizationClosure');
      expect(freeze).not.toContain('tx.memberOrganizationMembership');
      expect(freeze).not.toContain('tx.organization.');
      // 走的是属主导出的 tx 原语。
      expect(freeze).toContain('resolveOrganizationSubtreeMemberIds');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 盖章解析:老行没有盖章要放行,盖章在场但形状不对要红
  // ────────────────────────────────────────────────────────────────
  describe('盖章解析', () => {
    it('冻结之前落库的老 intent 没有 recipientFreeze ⇒ 返回 null 放行,不卡死队列', () => {
      expect(readRecipientFreezeStamp({ recipientMemberId: 'm-1' })).toBeNull();
      expect(readRecipientFreezeStamp(null)).toBeNull();
      expect(readRecipientFreezeStamp([{ recipientFreeze: {} }])).toBeNull();
    });

    it('盖章在场但少一个键 ⇒ 不当成有效快照', () => {
      expect(
        readRecipientFreezeStamp({
          recipientFreeze: {
            cohortKey: 'k',
            algorithmVersion: 1,
            basisKind: 'audience-tags',
            basisRef: [],
            computedAt: '2026-08-18T00:00:00.000Z',
            // cohortSize 缺失
          },
        }),
      ).toBeNull();
    });
  });
});
