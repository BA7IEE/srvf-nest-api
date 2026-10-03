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
});
