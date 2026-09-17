import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  CORRECTION_CHANGE_SCHEMA_VERSION,
  FACT_CORRECTION_CHANGE_SCHEMA_VERSION,
  parseCorrectionChangeSet,
  serializeCorrectionChangeSetForHash,
} from './correction-change-set';
import { evaluateCorrectionReviewSeparation } from './correction-review-separation';

// ===== 第七刀:更正入参形状 + 更正审核人员隔离(纯函数层)=====
//
// 🔴 `requestedChangeJson` 是"账要改成什么样"的唯一输入。合同 §3.25 **没有给它字段表**,
//    闭集由本刀补齐 ⇒ 本 spec 就是那份闭集的可执行说明书。
//    每一条不合规都必须**拒绝**,不许"取默认值后继续"——
//    一个被静默补上默认值的字段,就是一笔没人授权过的账。

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participationIdentityId: 'identity-1',
    resultCode: 'present',
    recognizedServiceHours: '4.00',
    recognizedContributionPoints: '1.20',
    adjustmentReason: '负责人复核后下调',
    lateFlag: false,
    earlyLeaveFlag: false,
    ...overrides,
  };
}

function changeSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
    results: [validResult()],
    segments: [],
    ...overrides,
  };
}

function expectRejected(raw: unknown): void {
  try {
    parseCorrectionChangeSet(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz.code).toBe(BizCode.CORRECTION_CHANGE_SET_INVALID.code);
    return;
  }
  throw new Error('期望被拒绝,实际解析通过');
}

describe('D7-1 V2 分类认定更正闭集', () => {
  const timeCorrection = () => ({
    baseSettlementVersionId: 'base-version',
    baseTimeLedgerHash: 'a'.repeat(64),
    reason: '复核后更正分类认定',
    items: [{ rootEntryId: 'root-1', recognizedSeconds: 0 }],
  });
  const v2 = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    results: [],
    segments: [],
    timeCorrection: timeCorrection(),
    ...overrides,
  });
  it('允许仅更正分类认定，明确保留零值', () => {
    expect(parseCorrectionChangeSet(v2())).toEqual(v2());
  });
  it('分类条目规范排序，不改变原因或既有结果解析', () => {
    const parsed = parseCorrectionChangeSet(
      v2({
        results: [validResult()],
        timeCorrection: {
          ...timeCorrection(),
          items: [
            { rootEntryId: 'z', recognizedSeconds: 2147483647 },
            { rootEntryId: 'a', recognizedSeconds: 0 },
          ],
        },
      }),
    );
    expect(parsed.timeCorrection?.items.map((item) => item.rootEntryId)).toEqual(['a', 'z']);
    expect(parsed.results[0].recognizedServiceHours).toBe(4);
    expect(parsed.timeCorrection?.reason).toBe(timeCorrection().reason);
  });
  it('V2 的现有指纹输入逐字保持不变', () => {
    const parsed = parseCorrectionChangeSet(v2());
    const body = {
      activityId: 'activity',
      participationIdentityId: null,
      requestTypeCode: 'time',
      reason: '分类认定复核',
      operationKey: 'operation-key',
    };
    expect(
      fingerprintMetricEnvelope('attendance-correction-request-v2', {
        ...body,
        requestedChangeJson: serializeCorrectionChangeSetForHash(parsed),
      }).definitionHash,
    ).toBe(
      fingerprintMetricEnvelope('attendance-correction-request-v2', {
        ...body,
        requestedChangeJson: parsed,
      }).definitionHash,
    );
  });
  it('V1 返回结构不增加字段，禁止夹带新内容', () => {
    expect(Object.keys(parseCorrectionChangeSet(changeSet()))).toEqual([
      'schemaVersion',
      'results',
      'segments',
    ]);
    expectRejected(changeSet({ timeCorrection: timeCorrection() }));
  });
  it.each([
    { timeCorrection: undefined },
    { timeCorrection: { ...timeCorrection(), extra: true } },
    { timeCorrection: { ...timeCorrection(), reason: ' ' } },
    { timeCorrection: { ...timeCorrection(), reason: 'x'.repeat(501) } },
    { timeCorrection: { ...timeCorrection(), baseTimeLedgerHash: 'invalid' } },
    { timeCorrection: { ...timeCorrection(), baseSettlementVersionId: ' ' } },
    { timeCorrection: { ...timeCorrection(), items: [] } },
    {
      timeCorrection: {
        ...timeCorrection(),
        items: [timeCorrection().items[0], timeCorrection().items[0]],
      },
    },
    {
      timeCorrection: {
        ...timeCorrection(),
        items: [{ rootEntryId: 'root', recognizedSeconds: 0, extra: true }],
      },
    },
    { extra: true },
    { schemaVersion: 3 },
  ])('拒绝缺失、未知或含糊的 V2 字段 %#', (overrides) => expectRejected(v2(overrides)));
  it.each([-1, 0.1, 2147483648, NaN, Infinity, '1', null])(
    '不修约或转换秒数 %s',
    (recognizedSeconds) => {
      expectRejected(
        v2({
          timeCorrection: {
            ...timeCorrection(),
            items: [{ rootEntryId: 'root', recognizedSeconds }],
          },
        }),
      );
    },
  );
  it('即使服务段本身合法，V2 仍禁止更正事实', () => {
    expectRejected(
      v2({
        segments: [
          {
            participationIdentityId: 'person',
            segmentKey: 'segment',
            checkInAt: '2020-03-01T01:00:00.000Z',
            checkOutAt: '2020-03-01T02:00:00.000Z',
            resultCode: 'valid',
            serviceHours: '1.00',
          },
        ],
      }),
    );
  });
  it('严格限定 8000 个条目', () => {
    const items = Array.from({ length: 8000 }, (_, i) => ({
      rootEntryId: `root-${i}`,
      recognizedSeconds: 0,
    }));
    expect(
      parseCorrectionChangeSet(v2({ timeCorrection: { ...timeCorrection(), items } }))
        .timeCorrection?.items,
    ).toHaveLength(8000);
    expectRejected(
      v2({
        timeCorrection: {
          ...timeCorrection(),
          items: [...items, { rootEntryId: 'overflow', recognizedSeconds: 0 }],
        },
      }),
    );
  });
});

describe('D7-2 V3 事实更正闭集', () => {
  const allocation = (overrides: Record<string, unknown> = {}) => ({
    participationIdentityId: 'identity-a',
    segmentKey: 'segment-a',
    baseSegmentRevisionId: 'base-segment-a',
    baseAllocationRevisionId: 'base-allocation-a',
    recognitionModeCode: 'manual',
    manualReason: '依据现场记录调整分类',
    slices: [
      {
        categoryCode: 'volunteer_service',
        startAt: '2020-03-01T01:00:00.000Z',
        endAt: '2020-03-01T02:00:00.000Z',
      },
    ],
    evidenceAttachmentIds: ['attachment-b', 'attachment-a'],
    ...overrides,
  });
  const segment = (overrides: Record<string, unknown> = {}) => ({
    participationIdentityId: 'identity-a',
    segmentKey: 'segment-a',
    checkInAt: '2020-03-01T01:00:00.000Z',
    checkOutAt: '2020-03-01T03:00:00.000Z',
    resultCode: 'valid',
    serviceHours: '2.00',
    ...overrides,
  });
  const v3 = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: FACT_CORRECTION_CHANGE_SCHEMA_VERSION,
    results: [],
    segments: [segment()],
    timeCorrection: {
      baseSettlementVersionId: 'base-version',
      baseTimeLedgerHash: 'a'.repeat(64),
      reason: '更正服务段事实后重新认定',
      items: [{ rootEntryId: 'root-1', recognizedSeconds: 3600 }],
    },
    allocations: [allocation()],
    ...overrides,
  });

  it('只接受 v3 的完整闭集，并为 hash 输入作稳定排序', () => {
    const parsed = parseCorrectionChangeSet(
      v3({
        results: [
          validResult({ participationIdentityId: 'identity-z' }),
          validResult({ participationIdentityId: 'identity-b' }),
        ],
        segments: [
          segment({ participationIdentityId: 'identity-z', segmentKey: 'segment-z' }),
          segment({ participationIdentityId: 'identity-a', segmentKey: 'segment-a' }),
        ],
        allocations: [
          allocation({ participationIdentityId: 'identity-z', segmentKey: 'segment-z' }),
          allocation({ participationIdentityId: 'identity-a', segmentKey: 'segment-a' }),
        ],
      }),
    );
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.results.map((row) => row.participationIdentityId)).toEqual([
      'identity-b',
      'identity-z',
    ]);
    expect(parsed.segments.map((row) => row.participationIdentityId)).toEqual([
      'identity-a',
      'identity-z',
    ]);
    expect(parsed.allocations?.map((row) => row.participationIdentityId)).toEqual([
      'identity-a',
      'identity-z',
    ]);
    expect(parsed.allocations?.[0].evidenceAttachmentIds).toEqual(['attachment-a', 'attachment-b']);
  });

  it('零时长或零事实段只能使用没有 slice 的 automatic 分配', () => {
    const parsed = parseCorrectionChangeSet(
      v3({
        segments: [
          segment({
            resultCode: 'early_departure_zero',
            checkOutAt: '2020-03-01T01:00:00.000Z',
            serviceHours: '0.00',
          }),
        ],
        allocations: [
          allocation({ recognitionModeCode: 'automatic', manualReason: null, slices: [] }),
        ],
      }),
    );
    expect(parsed.allocations?.[0]).toMatchObject({
      recognitionModeCode: 'automatic',
      manualReason: null,
      slices: [],
    });
  });

  it('将 V3 时间事实固定成 UTC 文本，避免 Date 在指纹中退化为空对象', () => {
    const serialized = serializeCorrectionChangeSetForHash(parseCorrectionChangeSet(v3()));
    expect(serialized).toMatchObject({
      schemaVersion: 3,
      segments: [
        {
          checkInAt: '2020-03-01T01:00:00.000Z',
          checkOutAt: '2020-03-01T03:00:00.000Z',
        },
      ],
      allocations: [
        {
          slices: [
            {
              startAt: '2020-03-01T01:00:00.000Z',
              endAt: '2020-03-01T02:00:00.000Z',
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(serialized)).not.toContain('{}');
  });

  it('V3 规范化后仍是可再次解析的闭集，并保留十进制字符串入口', () => {
    const parsed = parseCorrectionChangeSet(v3({ results: [validResult()] }));
    const serialized = serializeCorrectionChangeSetForHash(parsed);
    expect(serialized).toMatchObject({
      results: [
        {
          recognizedServiceHours: '4.00',
          recognizedContributionPoints: '1.20',
        },
      ],
      segments: [{ serviceHours: '2.00' }],
    });
    expect(parseCorrectionChangeSet(serialized)).toEqual(parsed);
  });

  it('两个不同 V3 时间事实不能得到相同的业务指纹', () => {
    const body = {
      activityId: 'activity',
      participationIdentityId: null,
      requestTypeCode: 'time',
      reason: '事实更正',
      operationKey: 'operation-key',
    };
    const first = parseCorrectionChangeSet(v3());
    const moved = parseCorrectionChangeSet(
      v3({
        segments: [segment({ checkOutAt: '2020-03-01T04:00:00.000Z', serviceHours: '3.00' })],
        allocations: [
          allocation({
            slices: [
              {
                categoryCode: 'volunteer_service',
                startAt: '2020-03-01T01:00:00.000Z',
                endAt: '2020-03-01T03:00:00.000Z',
              },
            ],
          }),
        ],
      }),
    );
    const hash = (changeSet: ReturnType<typeof parseCorrectionChangeSet>) =>
      fingerprintMetricEnvelope('attendance-correction-request-v3', {
        ...body,
        requestedChangeJson: serializeCorrectionChangeSetForHash(changeSet),
      }).definitionHash;
    expect(hash(moved)).not.toBe(hash(first));
  });

  it.each([
    ['缺少 allocations', v3({ allocations: undefined })],
    ['顶层未知字段', v3({ unexpected: true })],
    ['没有真实服务段', v3({ segments: [], allocations: [] })],
    [
      '分配遗漏一个段',
      v3({
        segments: [
          segment(),
          segment({ participationIdentityId: 'identity-b', segmentKey: 'segment-b' }),
        ],
      }),
    ],
    ['分配指向未声明段', v3({ allocations: [allocation({ segmentKey: 'not-declared' })] })],
    ['同一段有两份分配', v3({ allocations: [allocation(), allocation()] })],
    [
      'automatic 携带人工理由',
      v3({
        allocations: [
          allocation({ recognitionModeCode: 'automatic', slices: [], manualReason: '不允许' }),
        ],
      }),
    ],
    [
      'automatic 携带 slice',
      v3({ allocations: [allocation({ recognitionModeCode: 'automatic', manualReason: null })] }),
    ],
    ['manual 缺少理由', v3({ allocations: [allocation({ manualReason: null })] })],
    ['manual 没有 slice', v3({ allocations: [allocation({ slices: [] })] })],
    [
      '人工分配写入零事实段',
      v3({ segments: [segment({ resultCode: 'voided', serviceHours: '0.00' })] }),
    ],
    [
      '一段重复附件',
      v3({
        allocations: [allocation({ evidenceAttachmentIds: ['attachment-a', 'attachment-a'] })],
      }),
    ],
    [
      'slice 不得由调用方指定 intervalKindCode',
      v3({
        allocations: [
          allocation({
            slices: [{ ...allocation().slices[0], intervalKindCode: 'service_segment' }],
          }),
        ],
      }),
    ],
    [
      'slice 空区间',
      v3({
        allocations: [
          allocation({
            slices: [{ ...allocation().slices[0], endAt: '2020-03-01T01:00:00.000Z' }],
          }),
        ],
      }),
    ],
  ])('%s ⇒ 拒绝', (_label, raw) => expectRejected(raw));

  it('限制每分配的证据与全请求的结果规模', () => {
    expectRejected(
      v3({
        allocations: [
          allocation({
            evidenceAttachmentIds: Array.from({ length: 21 }, (_, index) => `attachment-${index}`),
          }),
        ],
      }),
    );
    expectRejected(
      v3({
        results: Array.from({ length: 2001 }, (_, index) =>
          validResult({ participationIdentityId: `identity-${index}` }),
        ),
      }),
    );
  });
});

describe('更正内容形状 (合同 §3.25 `requestedChangeJson`;字段表由本刀补齐)', () => {
  // ===== ① 正对照 =========================================================
  describe('① 合规内容解析通过', () => {
    it('只改结果值', () => {
      const parsed = parseCorrectionChangeSet(changeSet());
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].recognizedContributionPoints).toBe(1.2);
      expect(parsed.segments).toHaveLength(0);
    });

    it('只改服务段', () => {
      const parsed = parseCorrectionChangeSet(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T01:00:00.000Z',
              checkOutAt: '2020-03-01T03:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0].checkOutAt.toISOString()).toBe('2020-03-01T03:00:00.000Z');
    });

    it('零时长段(签到签退同刻)是合法形态', () => {
      const parsed = parseCorrectionChangeSet(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T01:00:00.000Z',
              checkOutAt: '2020-03-01T01:00:00.000Z',
              resultCode: 'early_departure_zero',
              serviceHours: '0.00',
            },
          ],
        }),
      );
      expect(parsed.segments[0].serviceHours).toBe(0);
    });
  });

  // ===== ② 形状层(逐条只拨一项)============================================
  describe('② 形状不合规一律拒绝', () => {
    it.each([
      ['不是对象', 'nope'],
      ['schemaVersion 不匹配', changeSet({ schemaVersion: 2 })],
      ['顶层多一个键', { ...changeSet(), extra: 1 }],
      ['顶层少一个键', { schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION, results: [] }],
      ['results 不是数组', changeSet({ results: {} })],
      ['结果项多一个键', changeSet({ results: [{ ...validResult(), extra: 1 }] })],
      ['结果项少一个键', changeSet({ results: [omit(validResult(), 'lateFlag')] })],
      ['空更正', changeSet({ results: [], segments: [] })],
    ])('%s ⇒ 拒绝', (_label, raw) => {
      expectRejected(raw);
    });

    it('同一个人被改两次 ⇒ 拒绝(否则"哪一条生效"取决于数组顺序)', () => {
      expectRejected(changeSet({ results: [validResult(), validResult()] }));
    });
  });

  // ===== ③ 取值层 =========================================================
  describe('③ 取值不合规一律拒绝', () => {
    it.each([
      ['resultCode 不在十值闭集', validResult({ resultCode: 'unknown' })],
      ['金额写成 number 而不是字符串', validResult({ recognizedContributionPoints: 1.2 })],
      ['金额多余小数位', validResult({ recognizedContributionPoints: '1.005' })],
      ['金额为负', validResult({ recognizedContributionPoints: '-1.00' })],
      ['时长超过 24 小时', validResult({ recognizedServiceHours: '25.00' })],
      ['lateFlag 不是布尔', validResult({ lateFlag: 'false' })],
      ['adjustmentReason 是空串', validResult({ adjustmentReason: '' })],
    ])('%s ⇒ 拒绝', (_label, result) => {
      expectRejected(changeSet({ results: [result] }));
    });

    it('🔴 多余小数位**不四舍五入**接受', () => {
      // `numeric(5,2)` 在 DB 侧对 1.005 是**静默归一**成 1.00(第 1 批已实测,不报错)
      // ⇒ 若这里放行,申请人写下的值与最终入账的值可以不同,而两边都没有任何提示。
      expectRejected(changeSet({ results: [validResult({ recognizedServiceHours: '4.005' })] }));
      // 正对照:两位以内照常通过。
      expect(
        parseCorrectionChangeSet(
          changeSet({ results: [validResult({ recognizedServiceHours: '4.50' })] }),
        ).results[0].recognizedServiceHours,
      ).toBe(4.5);
    });

    it('非 present 结果带非零金额 ⇒ 拒绝(补集写法,闭集扩展时 fail-closed)', () => {
      expectRejected(
        changeSet({
          results: [validResult({ resultCode: 'absent', recognizedContributionPoints: '1.20' })],
        }),
      );
      // 正对照:非 present 且金额全零照常通过。
      expect(
        parseCorrectionChangeSet(
          changeSet({
            results: [
              validResult({
                resultCode: 'absent',
                recognizedServiceHours: '0.00',
                recognizedContributionPoints: '0.00',
              }),
            ],
          }),
        ).results[0].resultCode,
      ).toBe('absent');
    });

    it('签退早于签到 ⇒ 拒绝', () => {
      expectRejected(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T03:00:00.000Z',
              checkOutAt: '2020-03-01T01:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
    });

    it('🔴 时刻只接受字符串:`null` 不得被 `new Date(null)` 解析成 1970-01-01', () => {
      // 本仓已栽过一次:`new Date(null)` = 1970-01-01,**不是** Invalid Date。
      expectRejected(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: null,
              checkOutAt: '2020-03-01T03:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
    });
  });
});

describe('更正审核人员隔离 (合同 §7.5)', () => {
  it('操作人 ≠ 提交人 ⇒ 放行', () => {
    expect(
      evaluateCorrectionReviewSeparation({ submittedByUserId: 'user-a' }, 'user-b'),
    ).toBeNull();
  });

  it('🔴 操作人就是提交人 ⇒ self_correction_review', () => {
    expect(evaluateCorrectionReviewSeparation({ submittedByUserId: 'user-a' }, 'user-a')).toBe(
      'self_correction_review',
    );
  });

  it('提交人为 null(结构上不可达)不否决 —— 与第四刀同一口径', () => {
    expect(evaluateCorrectionReviewSeparation({ submittedByUserId: null }, 'user-a')).toBeNull();
  });
});

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
