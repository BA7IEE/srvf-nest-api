import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECLARED_OPEN_ADMISSION_GAPS,
  REPO_ROOT,
  runCriteria,
} from './participation-admission-gate.criteria';

/**
 * 「正式准入必须锁后重验被录取人」结构判据 —— 断言 + **正反对照**。
 *
 * 🔴 本仓的硬教训:**不做对照的结构断言等于没有**。只断言「当前是绿的」证明不了判据在缺陷
 * 出现时会变红 —— 判据可能压根没扫到目标文件、匹配写法写错、或被自己的配置遮蔽,那时
 * 「零命中」会被读成「合规」。所以下面每一条都配一个变异:
 *   · **正**:把某条已有的重验摘掉 / 降级 ⇒ 判据必须红,且红在**指名的那一处**;
 *   · **反**:新增一个写 pass 但不查 ACTIVE 的方法 ⇒ 判据必须红(证明扫描面是动态的,
 *            不是一张写死的路径名单)。
 *
 * 变异用 `runCriteria(overrides)` 在内存里替换源码,不落盘 —— 避免「变异脚本超时停在半路
 * 留下脏工作区」和「git checkout 把未提交实现一起抹掉」这两类既有事故。
 */

const ALLOC = 'src/modules/activity-registrations/activity-allocation.service.ts';
const ONSITE = 'src/modules/activity-registrations/onsite-participation-command.service.ts';
const SUBMIT = 'src/modules/activity-registrations/registration-command.service.ts';

const PROMOTE_RECHECK =
  'if (!(await this.promotionCandidateStillLive(tx, candidate.memberId))) continue;';
const COMMIT_GAP = `${ALLOC}#persistCommittedCandidate`;

function source(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** 变异必须真的落在目标行上 —— 否则「判据没红」证明不了任何事。 */
function mutate(relPath: string, from: string, to: string): Record<string, string> {
  const original = source(relPath);
  const mutated = original.split(from).join(to);
  expect(mutated).not.toBe(original);
  return { [relPath]: mutated };
}

describe('正式准入锁后重验 — 结构判据(第六轮评审 C-BLOCKER-1 的类闸)', () => {
  describe('基线', () => {
    it('零 finding,且判据真的扫到了东西(计数自证)', () => {
      const { findings, counts, openGaps } = runCriteria();

      // 先打印再断言:判据红时要能一眼看到红在哪,而不是只看到 length 不等于 0。
      expect(findings.map((f) => `[${f.criterion}] ${f.detail}`)).toEqual([]);

      // 计数不是装饰:它们证明判据**真的扫到了东西**。任一个是 0,「零 finding」
      // 就是空绿而不是合规 —— 例如 admissionWriters=0 意味着准入写入点一个都没识别出来。
      expect(counts.scannedFiles).toBeGreaterThan(0);
      expect(counts.admissionWriters).toBeGreaterThan(0);
      expect(counts.guardedWriters).toBeGreaterThan(0);
      expect(counts.activePredicates).toBeGreaterThan(0);
      expect(counts.lockingPredicates).toBeGreaterThan(0);

      // 已登记敞口逐条对拍:**新**缺陷绝不会悄悄落进登记表(它不在表里,只会走 G2 报红)。
      expect(openGaps.sort()).toEqual(Object.keys(DECLARED_OPEN_ADMISSION_GAPS).sort());
      expect(counts.declaredOpenGaps).toBe(Object.keys(DECLARED_OPEN_ADMISSION_GAPS).length);
    });

    it('候补递补路径确实被判为「已重验」—— 它是本次修复的那一条', () => {
      const { findings } = runCriteria();
      expect(findings.some((f) => f.detail.includes('promoteAfterCancellationInTransaction'))).toBe(
        false,
      );
    });
  });

  describe('正对照:摘掉任一条已有的重验 ⇒ 必红并点名', () => {
    it('候补递补摘掉锁后重验 ⇒ G2 红在 promoteAfterCancellationInTransactionTrusted()', () => {
      const { findings } = runCriteria(mutate(ALLOC, PROMOTE_RECHECK, ''));
      const hit = findings.filter((f) => f.criterion === 'G2');
      expect(
        hit.some((f) => f.detail.includes('promoteAfterCancellationInTransactionTrusted()')),
      ).toBe(true);
    });

    it('兄弟路径「现场临时参加」摘掉 ACTIVE 检查 ⇒ G2 红在 onsite 的 createInTransaction()', () => {
      const original = source(ONSITE);
      const mutated = original
        .split('await assertActiveMemberLifecycle(input.tx, input.targetMemberId);')
        .join('')
        .split('await this.assertActiveTargetMember(input.tx, input.targetMemberId);')
        .join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [ONSITE]: mutated });
      expect(
        findings.some(
          (f) => f.criterion === 'G2' && f.detail.includes(`${ONSITE} 的 createInTransaction()`),
        ),
      ).toBe(true);
    });

    it('兄弟路径「first_come 提交后即分配」摘掉上游重验 ⇒ G2 红(证明记的是调用方那一次)', () => {
      // 这条路径的重验在**调用方**同一事务里(submitInTransaction),写在被调方。
      // 摘掉调用方那一次就必须红 —— 否则说明「调用方记功」是白记的。
      const { findings } = runCriteria(
        mutate(
          SUBMIT,
          'await this.assertAppAdmissionStillLive(input.tx, input.currentUser.id, input.memberId);',
          '',
        ),
      );
      expect(
        findings.some(
          (f) =>
            f.criterion === 'G2' &&
            f.detail.includes('applyFirstComeAfterSubmissionInTransactionTrusted()'),
        ),
      ).toBe(true);
    });

    it('把重验降级成不加锁的读 ⇒ G3 红(「锁前过滤」不算「锁后重验」)', () => {
      const { findings } = runCriteria(
        mutate(
          ALLOC,
          'const member = await lockAndReadLiveMemberLifecycle(tx, memberId);',
          'const member = await tx.member.findFirst({ where: { id: memberId, deletedAt: null }, select: { status: true } });',
        ),
      );
      expect(
        findings.some(
          (f) =>
            f.criterion === 'G3' &&
            f.detail.includes('promoteAfterCancellationInTransactionTrusted()'),
        ),
      ).toBe(true);
    });

    it('把重验换成对**操作人自己**的准入复核 ⇒ 仍然红(上层边界遮蔽不了下层边界)', () => {
      // 这一条是本闸真正的执法力:同文件里就有一个对 currentUser 的 ACTIVE 复核,
      // 只问「查没查过 MemberStatus.ACTIVE」会被它满足,洞却还在。
      const { findings } = runCriteria(
        mutate(
          ALLOC,
          PROMOTE_RECHECK,
          'await this.assertAppAdmissionStillLive(tx, input.actorUser.id, input.actorUser.memberId);',
        ),
      );
      expect(
        findings.some((f) => f.detail.includes('promoteAfterCancellationInTransactionTrusted()')),
      ).toBe(true);
    });
  });

  describe('反对照:扫描面是动态的,不是写死的路径名单', () => {
    it('新增一个写 pass 但不查 ACTIVE 的方法 ⇒ G2 必红并点名该新文件', () => {
      const NEW_FILE = 'src/modules/activity-registrations/sixth-admission-path.service.ts';
      const { findings } = runCriteria({
        [NEW_FILE]: [
          "import { Injectable } from '@nestjs/common';",
          '',
          '@Injectable()',
          'export class SixthAdmissionPathService {',
          '  async admitInTransactionTrusted(tx: any, input: { identityId: string }) {',
          '    await tx.activityParticipationRevision.create({',
          "      data: { identityId: input.identityId, revision: 1, statusCode: 'pass' },",
          '    });',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(
        findings.some(
          (f) =>
            f.criterion === 'G2' && f.detail.includes(`${NEW_FILE} 的 admitInTransactionTrusted()`),
        ),
      ).toBe(true);
    });

    it('同一个新方法补上锁后重验后 ⇒ 判据放行(证明它不是无差别报红)', () => {
      const NEW_FILE = 'src/modules/activity-registrations/sixth-admission-path.service.ts';
      const { findings } = runCriteria({
        [NEW_FILE]: [
          "import { Injectable } from '@nestjs/common';",
          "import { assertActiveMemberLifecycle } from '../members/member-lifecycle-lock';",
          '',
          '@Injectable()',
          'export class SixthAdmissionPathService {',
          '  async admitInTransactionTrusted(tx: any, input: { identityId: string; memberId: string }) {',
          '    await assertActiveMemberLifecycle(tx, input.memberId);',
          '    await tx.activityParticipationRevision.create({',
          "      data: { identityId: input.identityId, revision: 1, statusCode: 'pass' },",
          '    });',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(findings.filter((f) => f.detail.includes('sixth-admission-path'))).toEqual([]);
    });
  });

  describe('登记表自清洁:它盖不住新缺陷,也留不住已修好的旧缺陷', () => {
    it('已登记敞口一旦被修好 ⇒ G4 红,逼登记行被删除', () => {
      // 给 batch commit 路径补上锁后重验 ⇒ 它不再违规 ⇒ 登记表这一行过期。
      const { findings } = runCriteria(
        mutate(
          ALLOC,
          'const participationRevision = await tx.activityParticipationRevision.create({',
          'await this.promotionCandidateStillLive(tx, input.candidate.memberId);\n    const participationRevision = await tx.activityParticipationRevision.create({',
        ),
      );
      expect(findings.some((f) => f.criterion === 'G4' && f.detail.includes(COMMIT_GAP))).toBe(
        true,
      );
    });

    it('登记表每一条都必须写明「为什么还没修」', () => {
      for (const [key, reason] of Object.entries(DECLARED_OPEN_ADMISSION_GAPS)) {
        expect(key).toMatch(/^src\/.+\.ts#\w+$/);
        expect(reason.length).toBeGreaterThan(40);
      }
    });
  });
});
