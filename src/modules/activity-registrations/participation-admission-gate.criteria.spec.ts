import {
  COMMIT_GAP_KEY,
  DECLARED_OPEN_ADMISSION_GAPS,
  NEW_ADMISSION_PATH_FILE,
  ONSITE_SERVICE,
  controlDeclaredGapFixed,
  controlNewGuardedAdmissionPath,
  controlNewUnguardedAdmissionPath,
  controlOnsiteActiveCheckRemoved,
  controlPromoteRecheckRemoved,
  controlRecheckDowngradedToUnlockedRead,
  controlRecheckSwappedToActorSelf,
  controlSubmitUpstreamRecheckRemoved,
  malformedDeclaredGaps,
  runCriteria,
  selfCheck,
} from '../../../scripts/check-participation-admission-gate';

/**
 * 「正式准入必须锁后重验被录取人」结构判据 —— 断言 + **正反对照**。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-participation-admission-gate.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
 *    **变异对照本身也搬过去了**:它们是判据「会不会红」的证明,放在无保护文件里
 *    等于证明可以被顺手删掉,而删掉之后判据看起来照样全绿。
 *
 * 🔴 本仓的硬教训:**不做对照的结构断言等于没有**。只断言「当前是绿的」证明不了判据在缺陷
 * 出现时会变红 —— 判据可能压根没扫到目标文件、匹配写法写错、或被自己的配置遮蔽,那时
 * 「零命中」会被读成「合规」。所以下面每一条都配一个变异:
 *   · **正**:把某条已有的重验摘掉 / 降级 ⇒ 判据必须红,且红在**指名的那一处**;
 *   · **反**:新增一个写 pass 但不查 ACTIVE 的方法 ⇒ 判据必须红(证明扫描面是动态的,
 *            不是一张写死的路径名单)。
 */
describe('正式准入锁后重验 — 结构判据(第六轮评审 C-BLOCKER-1 的类闸)', () => {
  describe('基线', () => {
    it('零 finding,且判据真的扫到了东西(计数自证)', () => {
      const { findings } = runCriteria();

      // 计数自证与登记表对拍都在 selfCheck 里:任一计数是 0,「零 finding」
      // 就是空绿而不是合规 —— 例如 admissionWriters=0 意味着准入写入点一个都没识别出来。
      expect(selfCheck()).toEqual([]);

      // 先打印再断言:判据红时要能一眼看到红在哪,而不是只看到 length 不等于 0。
      expect(findings.map((f) => `[${f.criterion}] ${f.detail}`)).toEqual([]);
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
      const control = controlPromoteRecheckRemoved();
      // 变异必须真的落在目标行上 —— 否则「判据没红」证明不了任何事。
      expect(control.changed).toBe(true);
      expect(
        control.findings.some(
          (f) =>
            f.criterion === 'G2' &&
            f.detail.includes('promoteAfterCancellationInTransactionTrusted()'),
        ),
      ).toBe(true);
    });

    it('兄弟路径「现场临时参加」摘掉 ACTIVE 检查 ⇒ G2 红在 onsite 的 createInTransaction()', () => {
      const control = controlOnsiteActiveCheckRemoved();
      expect(control.changed).toBe(true);
      expect(
        control.findings.some(
          (f) =>
            f.criterion === 'G2' && f.detail.includes(`${ONSITE_SERVICE} 的 createInTransaction()`),
        ),
      ).toBe(true);
    });

    it('兄弟路径「first_come 提交后即分配」摘掉上游重验 ⇒ G2 红(证明记的是调用方那一次)', () => {
      const control = controlSubmitUpstreamRecheckRemoved();
      expect(control.changed).toBe(true);
      expect(
        control.findings.some(
          (f) =>
            f.criterion === 'G2' &&
            f.detail.includes('applyFirstComeAfterSubmissionInTransactionTrusted()'),
        ),
      ).toBe(true);
    });

    it('把重验降级成不加锁的读 ⇒ G3 红(「锁前过滤」不算「锁后重验」)', () => {
      const control = controlRecheckDowngradedToUnlockedRead();
      expect(control.changed).toBe(true);
      expect(
        control.findings.some(
          (f) =>
            f.criterion === 'G3' &&
            f.detail.includes('promoteAfterCancellationInTransactionTrusted()'),
        ),
      ).toBe(true);
    });

    it('把重验换成对**操作人自己**的准入复核 ⇒ 仍然红(上层边界遮蔽不了下层边界)', () => {
      const control = controlRecheckSwappedToActorSelf();
      expect(control.changed).toBe(true);
      expect(
        control.findings.some((f) =>
          f.detail.includes('promoteAfterCancellationInTransactionTrusted()'),
        ),
      ).toBe(true);
    });
  });

  describe('反对照:扫描面是动态的,不是写死的路径名单', () => {
    it('新增一个写 pass 但不查 ACTIVE 的方法 ⇒ G2 必红并点名该新文件', () => {
      expect(
        controlNewUnguardedAdmissionPath().some(
          (f) =>
            f.criterion === 'G2' &&
            f.detail.includes(`${NEW_ADMISSION_PATH_FILE} 的 admitInTransactionTrusted()`),
        ),
      ).toBe(true);
    });

    it('同一个新方法补上锁后重验后 ⇒ 判据放行(证明它不是无差别报红)', () => {
      expect(
        controlNewGuardedAdmissionPath().filter((f) => f.detail.includes('sixth-admission-path')),
      ).toEqual([]);
    });
  });

  describe('登记表自清洁:它盖不住新缺陷,也留不住已修好的旧缺陷', () => {
    it('已登记敞口一旦被修好 ⇒ G4 红,逼登记行被删除', () => {
      // 给 batch commit 路径补上锁后重验 ⇒ 它不再违规 ⇒ 登记表这一行过期。
      const control = controlDeclaredGapFixed();
      expect(control.changed).toBe(true);
      expect(
        control.findings.some((f) => f.criterion === 'G4' && f.detail.includes(COMMIT_GAP_KEY)),
      ).toBe(true);
    });

    it('登记表每一条都必须写明「为什么还没修」', () => {
      expect(malformedDeclaredGaps()).toEqual([]);
      expect(Object.keys(DECLARED_OPEN_ADMISSION_GAPS).length).toBeGreaterThan(0);
    });
  });
});
