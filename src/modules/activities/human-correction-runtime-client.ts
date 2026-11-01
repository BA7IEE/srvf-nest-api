import { PrismaService } from '../../database/prisma.service';

export const HUMAN_CORRECTION_CLIENT = Symbol('HUMAN_CORRECTION_CLIENT');
// Retain the existing per-process test/runtime connection envelope. HTTP must
// split it between N and P; the dedicated worker has only P. This is not the
// independent ten-member advisory-lock slot limit.
export const HUMAN_CORRECTION_PROCESS_CONNECTION_LIMIT = 5;

export class HumanCorrectionClientSetupError extends Error {
  constructor(readonly stage: string) {
    super(`Human correction client setup rejected: ${stage}`);
  }
}

function connectionUrl(raw: unknown) {
  try {
    if (typeof raw !== 'string' || !raw) throw new Error();
    const url = new URL(raw);
    const limits = url.searchParams.getAll('connection_limit');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      limits.length !== 1 ||
      !/^[1-5]$/.test(limits[0]) ||
      !url.hostname ||
      !url.username
    )
      throw new Error();
    return { url, limit: Number(limits[0]) };
  } catch {
    // Never include URLs, passwords, parser exceptions or supplied input.
    throw new HumanCorrectionClientSetupError('EXPLICIT_BOUNDED_URL');
  }
}

export function assertHumanCorrectionPoolBudget(normalUrl: unknown, humanUrl: unknown) {
  const n = connectionUrl(normalUrl),
    p = connectionUrl(humanUrl);
  if (
    n.limit + p.limit > HUMAN_CORRECTION_PROCESS_CONNECTION_LIMIT ||
    n.url.hostname !== p.url.hostname ||
    (n.url.port || '5432') !== (p.url.port || '5432') ||
    n.url.pathname !== p.url.pathname ||
    n.url.username === p.url.username
  )
    throw new HumanCorrectionClientSetupError('HTTP_CONNECTION_BOUNDARY');
}

/** A distinct lifecycle owner. No ordinary/admin fallback, role switching,
 * unbounded default pool or additional retry is introduced here. The original
 * trusted provider still checks the actual authenticated P/C on this client. */
export class HumanCorrectionRuntimeClient extends PrismaService {
  constructor(raw: unknown) {
    connectionUrl(raw);
    super({ datasourceUrl: raw as string, errorFormat: 'minimal' });
  }
  override async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      try {
        await this.$disconnect();
      } catch {
        throw new HumanCorrectionClientSetupError('CONNECT_CLEANUP');
      }
      throw new HumanCorrectionClientSetupError('CONNECT');
    }
  }
  override async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch {
      throw new HumanCorrectionClientSetupError('DISCONNECT');
    }
  }
}
