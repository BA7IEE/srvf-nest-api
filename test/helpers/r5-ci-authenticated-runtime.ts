import type { INestApplication, Type } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import appConfig from '../../src/config/app.config';
import databaseConfig from '../../src/config/database.config';
import jwtConfig, { loadJwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import {
  getHumanCorrectionService,
  HumanCorrectionExecutionModule,
} from '../../src/modules/activities/human-correction-execution.module';
import {
  assertHumanCorrectionPoolBudget,
  HUMAN_CORRECTION_CLIENT,
} from '../../src/modules/activities/human-correction-runtime-client';
import {
  r5CiAuthenticated,
  r5CiInstalledRecordBytes,
  r5CiScope,
} from '../setup/r5-ci-instance-scope';

type QueryClient = PrismaClient<Prisma.PrismaClientOptions, 'query'>;
type Fixture = { readonly app: INestApplication; readonly humanApp?: INestApplication };
const clients = new Set<PrismaService>();
let record: { directory: string; path: string; sha256: string } | undefined;
let jwt: ReturnType<typeof loadJwtConfig> | undefined;

/** Real one-connection Prisma transport. No SQL, transaction, qualifier or
 * authority method is replaced. Query events stay in memory for D7 probes. */
class R5CiTransport extends PrismaService {
  constructor(url: string, options: Prisma.PrismaClientOptions = {}) {
    if (clients.size >= 5) throw new Error('R5_CI_TOTAL_CONNECTION_BUDGET');
    if (
      (options.datasourceUrl !== undefined && options.datasourceUrl !== url) ||
      (options.datasources?.db?.url !== undefined && options.datasources.db.url !== url)
    )
      throw new Error('R5_CI_TRANSPORT_URL_MISMATCH');
    const parameters = { ...options };
    delete parameters.datasources;
    delete parameters.datasourceUrl;
    super({
      ...parameters,
      datasourceUrl: url,
      errorFormat: 'minimal',
      log: [{ emit: 'event', level: 'query' }],
    });
    clients.add(this);
  }
  override async $disconnect(): Promise<void> {
    await super.$disconnect();
    clients.delete(this);
  }
}

function installedRecord() {
  if (record) return record;
  const { bytes, sha256 } = r5CiInstalledRecordBytes();
  const directory = mkdtempSync(join(tmpdir(), 'srvf-r5-ci-record-'));
  const path = join(directory, 'installed.json');
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  record = { directory, path, sha256 };
  return record;
}

/** Called only by the existing shared test application factory. Config tokens
 * carry URLs in memory; process.env, argv and the installed record never do. */
export function configureR5CiTestApp(builder: TestingModuleBuilder, human: boolean): void {
  if (!r5CiAuthenticated()) {
    if (human) throw new Error('R5_CI_HUMAN_APP_REQUIRES_AUTHENTICATED_SCOPE');
    return;
  }
  const input = r5CiScope();
  assertHumanCorrectionPoolBudget(input.untrustedUrl, input.trustedUrl);
  const normal = new R5CiTransport(human ? input.untrustedUrl : input.ownerUrl);
  builder.overrideProvider(PrismaService).useValue(normal);
  builder.overrideProvider(databaseConfig.KEY).useValue({
    url: human ? input.untrustedUrl : input.ownerUrl,
    contributionShadowUrl: undefined,
    humanCorrectionUrl: human ? input.trustedUrl : undefined,
  });
  const installed = human ? installedRecord() : undefined;
  builder.overrideProvider(appConfig.KEY).useFactory({
    factory: () => ({
      ...appConfig(),
      humanCorrectionBackground: installed
        ? {
            mode: 'first-launch',
            installedRecordPath: installed.path,
            installedRecordSha256: installed.sha256,
          }
        : { mode: 'off' },
    }),
  });
  jwt ??= loadJwtConfig({
    APP_ENV: 'test',
    JWT_SECRET: randomBytes(48).toString('base64'),
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '90d',
  });
  builder.overrideProvider(jwtConfig.KEY).useValue(jwt);
  if (human) {
    // The only P object is also the observer. The trusted factory, source
    // qualifier, bootstrap guard and budget providers remain production code.
    builder.overrideProvider(HUMAN_CORRECTION_CLIENT).useValue(new R5CiTransport(input.trustedUrl));
  }
}

export function r5CiOwnerClient(options: Prisma.PrismaClientOptions = {}): QueryClient {
  return r5CiAuthenticated()
    ? new R5CiTransport(r5CiScope().ownerUrl, options)
    : new PrismaClient<Prisma.PrismaClientOptions, 'query'>(options);
}

export function humanCorrectionTestApp(fixture: Fixture): INestApplication {
  if (!r5CiAuthenticated()) return fixture.app;
  if (!fixture.humanApp) throw new Error('R5_CI_HUMAN_APP_MISSING');
  return fixture.humanApp;
}

export function humanCorrectionTestService<T extends object>(
  fixture: Fixture,
  service: Type<T>,
): T {
  if (!r5CiAuthenticated()) return fixture.app.get(service);
  return getHumanCorrectionService(
    humanCorrectionTestApp(fixture).select(HumanCorrectionExecutionModule),
    service,
  );
}

export function humanCorrectionTestClient(fixture: Fixture): QueryClient {
  if (!r5CiAuthenticated()) throw new Error('R5_CI_P_CLIENT_REQUIRES_AUTHENTICATED_SCOPE');
  const client = humanCorrectionTestApp(fixture)
    .select(HumanCorrectionExecutionModule)
    .get<PrismaService>(HUMAN_CORRECTION_CLIENT, { strict: true });
  if (!clients.has(client)) throw new Error('R5_CI_UNKNOWN_P_TRANSPORT');
  return client;
}

export async function assertR5CiActorsWithoutPositions(db: PrismaService): Promise<void> {
  if (r5CiAuthenticated() && (await db.organizationPositionAssignment.count()) !== 0)
    throw new Error('R5_CI_ZERO_POSITION_PRECONDITION');
}

/** Owner closeouts belong to their original fixtures. This final safety net
 * closes any object left by a failed initializer and then removes only the
 * non-secret installation record. No account or database lifecycle is here. */
export async function closeR5CiRuntime(): Promise<void> {
  const results = await Promise.allSettled([...clients].map((client) => client.$disconnect()));
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('R5_CI_TRANSPORT_CLEANUP_FAILED');
  if (record) rmSync(record.directory, { recursive: true });
  record = undefined;
  jwt = undefined;
}
