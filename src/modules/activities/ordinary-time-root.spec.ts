import { ordinaryTimeBuckets } from './ordinary-time-root';

describe('ordinaryTimeBuckets', () => {
  it('converts frozen centihours exactly and emits all four policy-free categories', () => {
    const buckets = ordinaryTimeBuckets('participant', '0.50', '1.16');
    expect(buckets).toEqual(
      [
        ['volunteer_service', 1800, 4176],
        ['training', 0, 0],
        ['organization', 0, 0],
        ['non_creditable', 0, 0],
      ].map(([categoryCode, calculatedSeconds, recognizedSeconds]) => ({
        participationIdentityId: 'participant',
        categoryCode,
        calculatedSeconds,
        recognizedSeconds,
        rawCalculatedMilliseconds: BigInt(calculatedSeconds) * 1000n,
        rawRecognizedMilliseconds: BigInt(recognizedSeconds) * 1000n,
        timePolicyVersionId: null,
        definitionHash: null,
        evaluatorVersion: null,
        quantumSeconds: null,
      })),
    );
  });

  it.each(['1.160', '-0.50', '1000', '1e-2'])('rejects invalid legacy hours %s', (hours) => {
    expect(() => ordinaryTimeBuckets('participant', '0', hours)).toThrow();
  });
});
