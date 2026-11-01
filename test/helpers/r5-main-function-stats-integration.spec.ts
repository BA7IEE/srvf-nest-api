import { installR5MainPrepareProfile } from './r5-main-prepare-profile';
import {
  R5_FUNCTION_STATS_CALIBRATION_SQL,
  R5_FUNCTION_STATS_CONTROL_SQL,
  R5_FUNCTION_STATS_ENABLE_SQL,
  R5_FUNCTION_STATS_SNAPSHOT_SQL,
} from './r5-main-function-stats';

// One pure fake integration of the actual opt-in profiler/proxy/counter chain.
// All server outcomes below are synthetic; there is no database connection.
it.each([false, true])(
  'wires the original transaction/SQL unchanged; barrier rejects=%s',
  async (rejectBarrier) => {
    const events: string[] = [];
    const transactionOptions = { timeout: 60000, maxWait: 2000, isolationLevel: 'ReadCommitted' };
    const nativeError = Object.assign(new Error('synthetic native barrier'), { code: 'P2028' });
    const payload = { sensitive: 'must-not-appear-in-observation' };
    const originalResult = { native: 'result' };
    let xid: string | null = null,
      track = 'none',
      canonical = 0,
      rowCalls = 0,
      guardCalls = 0;
    const header = () => ({
      database: 'app_test_r5_setmat_20261029_q1',
      databaseOid: 1998913,
      cluster: '7695840193603043362',
      pid: 90,
      xid,
      role: 'postgres',
      sessionUser: 'postgres',
      readOnly: 'off',
      trackFunctions: track,
    });
    const tx = {
      async $queryRawUnsafe(sql: string) {
        if (sql === R5_FUNCTION_STATS_CONTROL_SQL) {
          events.push('stats/control');
          return [{ observation: { ...header(), canonicalOid: 101, canonicalCalls: null } }];
        }
        if (sql === R5_FUNCTION_STATS_ENABLE_SQL) {
          events.push('stats/enable');
          track = 'all';
          return [{ enabled: 'all' }];
        }
        if (sql === R5_FUNCTION_STATS_CALIBRATION_SQL) {
          events.push('stats/calibration');
          canonical++;
          return [];
        }
        expect(sql).toBe(R5_FUNCTION_STATS_SNAPSHOT_SQL);
        events.push('stats/snapshot');
        return [
          {
            observation: {
              ...header(),
              at: 'synthetic',
              functions: [
                {
                  oid: 101,
                  identity: 'astr_canonical_json(jsonb)',
                  language: 'plpgsql',
                  hasConfig: false,
                  recorded: canonical > 0,
                  calls: canonical ? String(canonical) : null,
                  totalMs: canonical ? 1 : null,
                  selfMs: canonical ? 1 : null,
                },
                {
                  oid: 102,
                  identity: 'e4_evaluation_set_guard()',
                  language: 'plpgsql',
                  hasConfig: true,
                  recorded: guardCalls > 0,
                  calls: guardCalls ? String(guardCalls) : null,
                  totalMs: guardCalls ? 200 : null,
                  selfMs: guardCalls ? 10 : null,
                },
                {
                  oid: 103,
                  identity: 'e4_database_created_at()',
                  language: 'plpgsql',
                  hasConfig: true,
                  recorded: rowCalls > 0,
                  calls: rowCalls ? String(rowCalls) : null,
                  totalMs: rowCalls ? 10 : null,
                  selfMs: rowCalls ? 10 : null,
                },
              ],
            },
          },
        ];
      },
      async $queryRaw(_sql: TemplateStringsArray) {
        void _sql;
        return [{ identity: header() }];
      },
      async $executeRaw(sql: TemplateStringsArray, ...values: unknown[]) {
        const text = sql.join('?');
        if (text.startsWith('INSERT INTO "ParticipantContributionEvaluation"')) {
          events.push('native/insert');
          expect(values[0]).toBe(payload);
          rowCalls = 8000;
          guardCalls = 1;
          return 8000;
        }
        expect(text).toBe('SET CONSTRAINTS public.astr_parent_complete_guard IMMEDIATE');
        events.push('native/barrier');
        if (rejectBarrier) throw nativeError;
        return 0;
      },
    };
    const engine = {
      transaction: async (phase: string) => {
        events.push('engine/' + phase);
      },
    };
    const prisma = {
      _engine: engine,
      async $transaction<T>(callback: (t: typeof tx) => Promise<T>, opts: unknown) {
        expect(opts).toBe(transactionOptions);
        await engine.transaction('start');
        try {
          const value = await callback(tx);
          await engine.transaction('commit');
          return value;
        } catch (error) {
          await engine.transaction('rollback');
          throw error;
        }
      },
    };
    const noop = async () => {};
    const contributions = {
      assertNewNativeActivityInTx: noop,
      prepareTimeInTx: noop,
      async insertEvaluations(t: typeof tx, _root: unknown, _rows: unknown[]) {
        void _root;
        void _rows;
        expect(
          await t.$executeRaw`INSERT INTO "ParticipantContributionEvaluation" SELECT ${payload}`,
        ).toBe(8000);
      },
    };
    const timeSettlement = {
      lockedProof: async (t: typeof tx) => {
        void t;
      },
      lockedSources: noop,
      insertBuckets: noop,
      receipt: noop,
      async write() {
        return await prisma.$transaction(async (t) => {
          events.push('business/callback');
          xid = '901';
          // Actual method receives this transaction: call through the profiling seam.
          await this.lockedProof(t);
          await contributions.insertEvaluations(t, {}, [payload]);
          await t.$executeRaw`SET CONSTRAINTS public.astr_parent_complete_guard IMMEDIATE`;
          return originalResult;
        }, transactionOptions);
      },
      async prepare(_activity: string) {
        void _activity;
        return await this.write();
      },
    };
    const profile = installR5MainPrepareProfile(
      {
        prisma,
        timeSettlement,
        contributions,
        timeQueries: { readDraftContextInTx: noop, readSourceSetInTx: noop, evaluateInTx: noop },
        contributionQueries: {
          readTimeEvaluationInTx: noop,
          readTimePolicySelectionInTx: noop,
          readFrozenPoliciesInTx: noop,
        },
        access: { authorize: noop },
        audit: { log: noop },
      },
      {
        activityId: 'one-fresh-activity',
        collectNativeFunctionStats: true,
        persist: () => 'synthetic-receipt',
        observeOutcome: async () => ({
          database: header().database,
          databaseOid: 1998913,
          cluster: header().cluster,
          xid: '901',
          observerPid: 91,
          status: rejectBarrier ? 'aborted' : 'committed',
        }),
      },
    );
    try {
      if (rejectBarrier)
        await expect(timeSettlement.prepare('one-fresh-activity')).rejects.toBe(nativeError);
      else expect(await timeSettlement.prepare('one-fresh-activity')).toBe(originalResult);
      expect(events.indexOf('stats/enable')).toBeLessThan(events.indexOf('business/callback'));
      const index = events.indexOf('native/insert');
      expect(events[index - 1]).toBe('stats/snapshot');
      expect(events[index + 1]).toBe('stats/snapshot');
      expect(events.filter((x) => x === 'native/insert')).toHaveLength(1);
      expect(events.filter((x) => x === 'native/barrier')).toHaveLength(1);
      const snapshot = profile.snapshot();
      expect(snapshot.complete).toBe(true); // Independent synthetic outcome remains separate.
      expect(snapshot.nativeFunctionStats?.complete).toBe(!rejectBarrier);
      expect(JSON.stringify(snapshot)).not.toContain(payload.sensitive);
      if (rejectBarrier)
        expect(events.slice(events.indexOf('native/barrier') + 1)).not.toContain('stats/snapshot');
    } finally {
      profile.restore();
    }
  },
);
