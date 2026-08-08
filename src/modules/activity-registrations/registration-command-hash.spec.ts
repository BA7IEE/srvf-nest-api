import { Prisma } from '@prisma/client';

import { hashRegistrationAnswers, hashRegistrationCommand } from './registration-command-hash';

const base = {
  actorUserId: 'user-1',
  memberId: 'member-1',
  activityId: 'activity-1',
  source: 'self' as const,
  formVersion: 3,
  answers: [
    { fieldCode: 'b', value: ['b', 'a'] },
    { fieldCode: 'a', value: 'answer' },
  ],
  preferences: [
    { sessionId: 'session-b', positionIds: ['position-b2', 'position-b1'] },
    { sessionId: 'session-a', positionIds: ['position-a1'] },
  ],
};

describe('registration command hashes', () => {
  it('is stable across answer/session object ordering while preserving position preference order', () => {
    const same = {
      ...base,
      answers: [...base.answers].reverse(),
      preferences: [...base.preferences].reverse(),
    };
    expect(hashRegistrationCommand(base)).toBe(hashRegistrationCommand(same));
    expect(
      hashRegistrationCommand({
        ...base,
        answers: [
          { fieldCode: 'b', value: ['a', 'b'] },
          { fieldCode: 'a', value: 'answer' },
        ],
      }),
    ).toBe(hashRegistrationCommand(base));
    expect(
      hashRegistrationCommand({
        ...base,
        preferences: [
          { sessionId: 'session-b', positionIds: ['position-b1', 'position-b2'] },
          { sessionId: 'session-a', positionIds: ['position-a1'] },
        ],
      }),
    ).not.toBe(hashRegistrationCommand(base));
  });

  it('binds actor, member, activity, source, form version, answers and preferences', () => {
    for (const changed of [
      { ...base, actorUserId: 'user-2' },
      { ...base, memberId: 'member-2' },
      { ...base, activityId: 'activity-2' },
      { ...base, formVersion: null },
      { ...base, answers: [{ fieldCode: 'a', value: 'changed' }] },
      { ...base, preferences: [{ sessionId: 'session-a', positionIds: ['changed-position'] }] },
    ]) {
      expect(hashRegistrationCommand(changed)).not.toBe(hashRegistrationCommand(base));
    }
  });

  it('stores only an answer fingerprint and includes file session identity rather than attachment metadata', () => {
    const hash = hashRegistrationAnswers([
      {
        fieldId: 'field-1',
        fieldCode: 'number',
        typeCode: 'number',
        valueNumber: new Prisma.Decimal('1.2'),
      },
      {
        fieldId: 'field-2',
        fieldCode: 'file',
        typeCode: 'file',
        uploadSessionId: 'session-12345678',
      },
    ]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRegistrationAnswers([])).toBeNull();
  });
});
