import {
  LOCAL_ACTIVITY_FRONTEND_ACCOUNTS,
  LocalActivityFrontendFixtureError,
  assertFrozenLoginResponseData,
  assertLocalActivityFrontendPassword,
  assertLocalActivityFrontendTarget,
  assertNoL3Fields,
  requestWrappedData,
  renderGuardedCleanupInstructions,
  runLocalActivityFrontendFixture,
} from './local-activity-frontend-fixture';

const DATABASE = 'app_local_frontend';
const DATABASE_URL =
  'postgresql://fixture_user:database-secret@127.0.0.1:5432/app_local_frontend?schema=public';
const FIXTURE_PASSWORD = 'LocalFixture9!';

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'development',
    DATABASE_URL,
    LOCAL_FIXTURE_CONFIRM_DATABASE: DATABASE,
    LOCAL_FRONTEND_FIXTURE_PASSWORD: FIXTURE_PASSWORD,
    ...overrides,
  };
}

function environmentForDatabase(database: string): NodeJS.ProcessEnv {
  return validEnvironment({
    DATABASE_URL: `postgresql://fixture_user:database-secret@127.0.0.1:5432/${database}?schema=public`,
    LOCAL_FIXTURE_CONFIRM_DATABASE: database,
  });
}

describe('local activity frontend fixture safety guards', () => {
  describe('target guard', () => {
    it.each(['development', 'test'] as const)(
      'accepts APP_ENV=%s for the dedicated database',
      (appEnv) => {
        expect(assertLocalActivityFrontendTarget(validEnvironment({ APP_ENV: appEnv }))).toEqual({
          appEnv,
          database: DATABASE,
          databaseUrl: DATABASE_URL,
        });
      },
    );

    it.each([
      ['production', 'production'],
      ['smoke', 'smoke'],
      ['unset', undefined],
    ])('rejects APP_ENV=%s', (_label, appEnv) => {
      expect(() =>
        assertLocalActivityFrontendTarget(validEnvironment({ APP_ENV: appEnv })),
      ).toThrow('APP_ENV 只允许 development 或 test');
    });

    it.each([
      'app',
      'app_test',
      'unknown',
      'app_local_frontend_BAD',
      'app_local_frontend_-bad',
      'app_local_frontend_',
    ])("rejects database '%s'", (database) => {
      expect(() => assertLocalActivityFrontendTarget(environmentForDatabase(database))).toThrow(
        '目标数据库名只允许 app_local_frontend',
      );
    });

    it.each([
      ['non-public', `${DATABASE_URL.replace('schema=public', 'schema=private')}`],
      ['duplicate schema', `${DATABASE_URL}&schema=public`],
    ])('rejects %s', (_label, databaseUrl) => {
      expect(() =>
        assertLocalActivityFrontendTarget(validEnvironment({ DATABASE_URL: databaseUrl })),
      ).toThrow('只允许 PostgreSQL public schema');
    });

    it('requires the confirmation database to match exactly', () => {
      expect(() =>
        assertLocalActivityFrontendTarget(
          validEnvironment({
            LOCAL_FIXTURE_CONFIRM_DATABASE: 'app_local_frontend_other',
          }),
        ),
      ).toThrow('与 DATABASE_URL 中解析出的数据库名不完全一致');
    });

    it('rejects leading or trailing whitespace in the explicit confirmation', () => {
      expect(() =>
        assertLocalActivityFrontendTarget(
          validEnvironment({
            LOCAL_FIXTURE_CONFIRM_DATABASE: ` ${DATABASE}`,
          }),
        ),
      ).toThrow('不得含首尾空白');
    });

    it('rejects a confirmation mismatch before creating Prisma or entering any write path', async () => {
      const createPrisma = jest.fn(() => {
        throw new Error('createPrisma must not be called');
      });

      await expect(
        runLocalActivityFrontendFixture(
          'setup',
          validEnvironment({
            LOCAL_FIXTURE_CONFIRM_DATABASE: 'app_local_frontend_other',
          }),
          { createPrisma },
        ),
      ).rejects.toBeInstanceOf(LocalActivityFrontendFixtureError);
      expect(createPrisma).not.toHaveBeenCalled();
    });
  });

  describe('password guard', () => {
    it.each([
      ['missing', undefined],
      ['shorter than 8', 'Abc1234'],
      ['longer than 128', `A1${'x'.repeat(127)}`],
      ['without a letter', '12345678'],
      ['without a digit', 'abcdefgh'],
    ])('rejects a password that is %s', (_label, password) => {
      expect(() =>
        assertLocalActivityFrontendPassword(
          validEnvironment({ LOCAL_FRONTEND_FIXTURE_PASSWORD: password }),
        ),
      ).toThrow(LocalActivityFrontendFixtureError);
    });

    it.each(['Abcdefg1', `A1${'x'.repeat(126)}`])(
      'accepts a valid password at the supported length boundaries',
      (password) => {
        expect(
          assertLocalActivityFrontendPassword(
            validEnvironment({ LOCAL_FRONTEND_FIXTURE_PASSWORD: password }),
          ),
        ).toBe(password);
      },
    );
  });

  describe('read-only print and cleanup commands', () => {
    it('cleanup rechecks the database guard and prints only guarded zero-write instructions', async () => {
      const createPrisma = jest.fn(() => {
        throw new Error('createPrisma must not be called');
      });

      const output = await runLocalActivityFrontendFixture('cleanup', validEnvironment(), {
        createPrisma,
      });

      expect(createPrisma).not.toHaveBeenCalled();
      expect(output).toContain('zero database connections and zero writes');
      expect(output).not.toContain(DATABASE_URL);
      expect(output).not.toContain('database-secret');
      expect(output).not.toContain(FIXTURE_PASSWORD);
      expect(() => renderGuardedCleanupInstructions('app')).toThrow(
        'cleanup 数据库名不符合专用本地联调库规则',
      );
    });

    it('print lists exactly the 17 declared usernames without identifiers or L3 fields', async () => {
      const createPrisma = jest.fn(() => {
        throw new Error('createPrisma must not be called');
      });

      const output = await runLocalActivityFrontendFixture('print', validEnvironment(), {
        createPrisma,
      });
      const accountRows = output.split('\n').filter((line) => /^local_fe_[a-z0-9_]+ \|/.test(line));
      const expectedUsernames = LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map(({ username }) => username);

      expect(createPrisma).not.toHaveBeenCalled();
      expect(LOCAL_ACTIVITY_FRONTEND_ACCOUNTS).toHaveLength(17);
      expect(accountRows).toHaveLength(17);
      expect(accountRows.map((line) => line.split(' | ')[0])).toEqual(expectedUsernames);
      for (const username of expectedUsernames) {
        expect(output.match(new RegExp(`^${username} \\|`, 'gm'))).toHaveLength(1);
      }
      expect(output).not.toContain(FIXTURE_PASSWORD);
      expect(output).not.toMatch(/passwordHash|refreshToken|\buserId\b|\bmemberId\b/i);
      expect(output).not.toMatch(/\bUser id\b|\bMember id\b/i);
    });
  });

  describe('L3 response scanner', () => {
    it('accepts nested business response data without L3 fields', () => {
      expect(() =>
        assertNoL3Fields({
          code: 0,
          data: {
            id: 'activity-1',
            memberNo: 'LOCAL-FE-001',
            items: [{ username: 'local_fe_owner', publicUrl: 'https://example.invalid/public' }],
          },
        }),
      ).not.toThrow();
    });

    it.each([
      'passwordHash',
      'refreshToken',
      'tokenHash',
      'accessToken',
      'uploadToken',
      'secretKeyPem',
      'secretIdValue',
      'appSecretValue',
      'clientSecret',
      'session_key',
      'sessionKey',
      'signedUrl',
    ])("rejects nested L3 field '%s'", (field) => {
      expect(() =>
        assertNoL3Fields({
          code: 0,
          data: {
            items: [{ [field]: 'must-not-leak' }],
          },
        }),
      ).toThrow(LocalActivityFrontendFixtureError);
    });
  });

  describe('HTTP verification transport and frozen login contract', () => {
    it('forces redirect=error even when the caller asks fetch to follow redirects', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 0, message: 'ok', data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(
        requestWrappedData(
          fetchMock as unknown as typeof fetch,
          new URL('http://127.0.0.1:3000/'),
          '/api/auth/v1/login',
          { method: 'POST', redirect: 'follow', body: '{"password":"must-not-leave-loopback"}' },
        ),
      ).resolves.toMatchObject({ data: {} });

      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:3000/api/auth/v1/login'),
        expect.objectContaining({ method: 'POST', redirect: 'error' }),
      );
    });

    it('accepts only the frozen five-field login payload and returns its access token', () => {
      expect(
        assertFrozenLoginResponseData(
          {
            accessToken: 'access',
            tokenType: 'Bearer',
            expiresIn: '15m',
            refreshToken: 'refresh',
            refreshExpiresAt: '2026-10-01T00:00:00.000Z',
          },
          'local_fe_owner',
        ),
      ).toBe('access');
    });

    it.each(['passwordHash', 'clientSecret', 'unexpectedField'])(
      "rejects an unexpected login response field '%s'",
      (field) => {
        expect(() =>
          assertFrozenLoginResponseData(
            {
              accessToken: 'access',
              tokenType: 'Bearer',
              expiresIn: '15m',
              refreshToken: 'refresh',
              refreshExpiresAt: '2026-10-01T00:00:00.000Z',
              [field]: 'must-not-leak',
            },
            'local_fe_owner',
          ),
        ).toThrow('登录响应字段集偏离冻结的五字段契约');
      },
    );
  });
});
