import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

/** Reserve only absent scratch resources. Historical data is never adopted by cleanup. */
export function registerWorkerResources(worker: number): void {
  const manifest = process.env.SRVF_RESOURCE_MANIFEST;
  if (!manifest || process.env.SRVF_RESOURCE_DATABASES === '0') return;
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const name = deriveWorkerTestDbName(worker);
  if (
    readFileSync(manifest, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const entry: { kind: string; name?: string } = JSON.parse(line);
        return entry.kind === 'database' && entry.name === name;
      })
  )
    return;
  const options = {
    encoding: 'utf8' as const,
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };
  const endpoint = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    options,
  ).trim();
  if (
    (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) ||
    !endpoint.startsWith('unix://')
  ) {
    throw new Error('资源治理只允许本机 Unix socket Docker，不回显连接信息。');
  }
  const containerId = execFileSync(
    'docker',
    ['inspect', '--format', '{{.Id}}', 'u-nest-api-postgres'],
    options,
  ).trim();
  const present = execFileSync(
    'docker',
    [
      'exec',
      containerId,
      'psql',
      '--no-psqlrc',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAc',
      `SELECT count(*) FROM pg_database WHERE datname='${name}'`,
    ],
    options,
  ).trim();
  const storage = resolve(`tmp/storage-w${worker}`);
  if (present !== '0' || existsSync(storage)) {
    throw new Error('目标测试库或存储已存在，拒绝认领或删除历史资源；请维护者确认。');
  }
  appendFileSync(manifest, JSON.stringify({ kind: 'database', name, containerId }) + '\n');
  appendFileSync(manifest, JSON.stringify({ kind: 'directory', path: storage }) + '\n');
  appendFileSync(
    manifest,
    JSON.stringify({
      kind: 'postgres-session',
      containerId,
      applicationName: `srvf-test-${process.env.SRVF_RESOURCE_OWNER}`,
    }) + '\n',
  );
  mkdirSync(storage);
}
