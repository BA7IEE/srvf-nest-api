/** Disposable container stdin protocol. Credentials never enter argv, env,
 * files, records or output. This invokes the production qualifier and N SQL. */
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/database/prisma.service';
import { HumanCorrectionRuntimeClient } from '../../src/modules/activities/human-correction-runtime-client';
import { createHumanCorrectionTrustedConnection } from '../../src/modules/activities/human-correction-trusted-connection';
import { HumanCorrectionHttpBoundary } from '../../src/modules/activities/human-correction-http-providers';
import type { HumanCorrectionExecution } from '../../src/modules/activities/human-correction-execution.module';
import {
  r5CiInstalledRecord,
  r5CiSourceBinding,
  type R5CiInstanceIdentity,
} from './r5-ci-source-binding';

type Input = {
  mode: 'build' | 'qualify';
  identity: R5CiInstanceIdentity;
  trustedUrl?: string;
  untrustedUrl?: string;
  installationSha256?: string;
  authenticationSha256?: string;
};

async function input(): Promise<Input> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    bytes += buffer.length;
    if (bytes > 32768) throw new Error('INPUT_BOUND');
    parts.push(buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as Input;
}

async function main(): Promise<void> {
  const data = await input();
  const binding = r5CiSourceBinding(data.identity);
  if (data.mode === 'build') {
    process.stdout.write(JSON.stringify(binding));
    return;
  }
  if (
    data.mode !== 'qualify' ||
    !data.trustedUrl ||
    !data.untrustedUrl ||
    !data.installationSha256 ||
    !data.authenticationSha256
  )
    throw new Error('QUALIFY_INPUT');
  const record = r5CiInstalledRecord(data.identity, binding, {
    installationSha256: data.installationSha256,
    authenticationSha256: data.authenticationSha256,
  });
  const trusted = new HumanCorrectionRuntimeClient(data.trustedUrl);
  const untrusted = new PrismaService({ datasourceUrl: data.untrustedUrl, errorFormat: 'minimal' });
  try {
    const connection = createHumanCorrectionTrustedConnection(trusted, record);
    if (!connection) throw new Error('NO_CONNECTION');
    const qualified = await trusted.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return connection.qualifyInTx(tx);
      },
      { timeout: 15000 },
    );
    const wrong = createHumanCorrectionTrustedConnection(untrusted, record);
    let rejected = false;
    try {
      await untrusted.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return wrong!.qualifyInTx(tx);
        },
        { timeout: 15000 },
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('UNTRUSTED_PROVIDER_ACCEPTED');
    const config = new ConfigService({
      app: { contributionShadowMode: 'off' },
      database: { url: data.untrustedUrl, humanCorrectionUrl: data.trustedUrl },
    });
    // Only the production boundary's documented client/database inputs are
    // consumed by this read-only component probe; no business service is called.
    const scope = { client: trusted, database: connection.database } as HumanCorrectionExecution;
    const normalBoundary = new HumanCorrectionHttpBoundary(untrusted, config, scope);
    await normalBoundary.onModuleInit();
    const profile = await trusted.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`RESET ROLE`;
        const rows = await tx.$queryRaw<
          Array<{
            pid: number;
            sessionUser: string;
            currentUser: string;
            backendStart: Date | null;
          }>
        >`
        SELECT pg_backend_pid() AS pid, session_user::text AS "sessionUser", current_user::text AS "currentUser",
          (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS "backendStart"`;
        await tx.$executeRaw`SET LOCAL ROLE "r5_boundary_caller_h7c6"`;
        return rows[0];
      },
      { timeout: 15000 },
    );
    process.stdout.write(
      JSON.stringify({
        status: 'PASS_REAL_AUTHENTICATED_COMPONENTS',
        trustedProvider: qualified,
        untrustedProviderRejected: rejected,
        ordinaryBoundary: 'PASS_ACTUAL_U_SESSION_WITH_C_STARTUP',
        trustedProfile: profile,
        sourceCatalogSha256: binding.catalogSha256,
        recordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        completeHttpOrBusinessProven: false,
      }),
    );
  } finally {
    await Promise.all([trusted.$disconnect(), untrusted.$disconnect()]);
  }
}

void main().catch((error: unknown) => {
  const stage = error && typeof error === 'object' && 'stage' in error ? String(error.stage) : null;
  // Never serialize arbitrary Prisma exceptions, causes, URLs or stdin.
  process.stderr.write(
    JSON.stringify({
      status: 'FAIL',
      type: error instanceof Error ? error.name : 'Unknown',
      stage,
    }),
  );
  process.exitCode = 1;
});
