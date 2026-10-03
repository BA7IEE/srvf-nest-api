import { execSync } from 'child_process';
import type * as DatabaseLifecycle from './test-db';

// Imported by the already-discovered scope suite: no new CI/Jest configuration is needed.
const actual = jest.requireActual<typeof DatabaseLifecycle>('./test-db');

describe('ordinary worker lifecycle (no database)', () => {
  const original = process.env;
  let statements: string[];
  beforeEach(() => {
    process.env = { ...original, SRVF_TEST_RUN_SCOPE: 'app_test,app_test_w1,app_test_w98' };
    delete process.env.DOCKER_HOST;
    statements = [];
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('current_database()')) return 'postgres|';
      if (sql.includes('AS drop_snapshot')) return '0|none';
      if (sql.includes('pg_stat_activity')) return '0';
      return '';
    });
  });
  afterEach(() => {
    process.env = original;
    jest.mocked(execSync).mockReset();
  });

  it('uses ordinary DROP for cleanup and recreation', () => {
    actual.dropWorkerDatabase(1);
    actual.recreateWorkerDatabase(1);
    expect(statements.filter((value) => value.includes('DROP DATABASE'))).toHaveLength(2);
    expect(statements.some((value) => value.includes('WITH (FORCE)'))).toBe(false);
    expect(statements.some((value) => value.includes('CREATE DATABASE'))).toBe(true);
  });

  it('active connections reject cleanup before DROP', () => {
    jest.mocked(execSync).mockImplementation((command) => {
      statements.push(String(command));
      if (String(command).includes('AS drop_snapshot')) return '1|client:idle:1';
      return String(command).includes('pg_stat_activity') ? '1' : 'postgres|';
    });
    expect(() => actual.dropWorkerDatabase(1)).toThrow('活跃连接');
    expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
  });

  it('a connection entering after the count is not force-terminated or retried', () => {
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('DROP DATABASE'))
        throw new Error('database is being accessed by other users');
      if (sql.includes('AS drop_snapshot')) return '0|none';
      return sql.includes('pg_stat_activity') ? '0' : 'postgres|';
    });
    expect(() => actual.dropWorkerDatabase(1)).toThrow('being accessed');
    expect(statements.filter((value) => value.includes('DROP DATABASE'))).toHaveLength(1);
    expect(statements.some((value) => /WITH \(FORCE\)|pg_terminate_backend/.test(value))).toBe(
      false,
    );
  });

  it('rejects undeclared scratch databases before any maintenance SQL', () => {
    process.env.SRVF_TEST_RUN_SCOPE = 'app_test_w1';
    expect(() => actual.dropWorkerDatabase(98)).toThrow('超出已声明范围');
    expect(statements).toHaveLength(0);
  });

  it('reports only classified counts without changing the cleanup refusal', () => {
    jest.mocked(execSync).mockImplementation((command, options) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('AS classified')) {
        expect(options).toEqual(expect.objectContaining({ timeout: 5_000, stdio: 'pipe' }));
        expect(sql).toContain("WHERE datname='app_test_w1' AND pid<>pg_backend_pid()");
        expect(sql).not.toMatch(/application_name|client_addr|SELECT query|pg_terminate_backend/);
        return 'autovacuum:active:1,client:idle:2';
      }
      return sql.includes('pg_stat_activity') ? '3' : 'postgres|';
    });
    expect(() => actual.recreateWorkerDatabase(1)).toThrow('autovacuum:active:1,client:idle:2');
    expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
  });

  it.each(['private-query-or-identity', 'client:idle:1,'.repeat(200), 'client:idle:1\nsecret'])(
    'does not emit malformed or oversized diagnostic output (%#)',
    (output) => {
      jest.mocked(execSync).mockImplementation((command) => {
        const sql = String(command);
        statements.push(sql);
        if (sql.includes('AS classified')) return output;
        return sql.includes('pg_stat_activity') ? '1' : 'postgres|';
      });
      expect(() => actual.recreateWorkerDatabase(1)).toThrow('非原判定快照）: unavailable');
      expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
    },
  );

  it('retains the refusal when diagnostic collection fails and never emits its stderr', () => {
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('AS classified')) throw new Error('private connection failure');
      return sql.includes('pg_stat_activity') ? '1' : 'postgres|';
    });
    expect(() => actual.recreateWorkerDatabase(1)).toThrow('非原判定快照）: unavailable');
    expect(statements.some((value) => /DROP DATABASE|CREATE DATABASE/.test(value))).toBe(false);
  });

  it('labels an empty later snapshot without treating the original refusal as cleared', () => {
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('AS classified')) return 'none';
      return sql.includes('pg_stat_activity') ? '1' : 'postgres|';
    });
    expect(() => actual.recreateWorkerDatabase(1)).toThrow('非原判定快照）: none');
    expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
  });

  it.each(['0|none', '0|autovacuum:active:1'])(
    'allows ordinary DROP for an empty or autovacuum-only snapshot (%#)',
    (snapshot) => {
      jest.mocked(execSync).mockImplementation((command, options) => {
        const sql = String(command);
        statements.push(sql);
        if (sql.includes('AS drop_snapshot')) {
          expect(options).toEqual(expect.objectContaining({ timeout: 5_000, stdio: 'pipe' }));
          expect(sql).toContain("WHERE datname='app_test_w1' AND pid<>pg_backend_pid()");
          return snapshot;
        }
        return 'postgres|';
      });
      actual.dropWorkerDatabase(1);
      expect(statements.filter((value) => value.includes('pg_stat_activity'))).toHaveLength(1);
      expect(statements.filter((value) => value.includes('DROP DATABASE'))).toHaveLength(1);
      expect(statements.some((value) => /WITH \(FORCE\)|pg_terminate_backend/.test(value))).toBe(
        false,
      );
    },
  );

  it.each([
    '1|client:idle:1',
    '1|autovacuum:active:1,client:active:1',
    '1|parallel:active:1',
    '1|other:other:1',
  ])('rejects every non-autovacuum kind in the same snapshot (%#)', (snapshot) => {
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      return sql.includes('AS drop_snapshot') ? snapshot : 'postgres|';
    });
    expect(() => actual.dropWorkerDatabase(1)).toThrow(
      `同一次判定快照）: ${snapshot.split('|')[1]}`,
    );
    expect(statements.filter((value) => value.includes('pg_stat_activity'))).toHaveLength(1);
    expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
  });

  it.each(['0|client:idle:1', '0|private-data', '0|none|private-data', '0|' + 'x'.repeat(2000)])(
    'fails closed on inconsistent or malformed snapshot (%#)',
    (snapshot) => {
      jest.mocked(execSync).mockImplementation((command) => {
        const sql = String(command);
        statements.push(sql);
        return sql.includes('AS drop_snapshot') ? snapshot : 'postgres|';
      });
      expect(() => actual.dropWorkerDatabase(1)).toThrow('同一次判定快照）: unavailable');
      expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
    },
  );

  it('does not retry or DROP when the authoritative snapshot query fails', () => {
    jest.mocked(execSync).mockImplementation((command) => {
      const sql = String(command);
      statements.push(sql);
      if (sql.includes('AS drop_snapshot')) throw new Error('private connection error');
      return 'postgres|';
    });
    expect(() => actual.dropWorkerDatabase(1)).toThrow('同一次判定快照）: unavailable');
    expect(statements.filter((value) => value.includes('pg_stat_activity'))).toHaveLength(1);
    expect(statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
  });
});
