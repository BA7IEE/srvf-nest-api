/** Default is pure validation. Explicit execution uses a dedicated, privately piped connection. */
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { loadJwtConfig } from '../src/config/jwt.config';
import { PrismaService } from '../src/database/prisma.service';
import { AuthHumanCommandIdentityService } from '../src/modules/auth/auth-human-command-identity.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { RbacService } from '../src/modules/permissions/rbac.service';
import { ContributionShadowWindowRegistrationService } from '../src/modules/attendances/contribution-shadow-window-registration.service';
import { ContributionShadowDispositionRegistrationService } from '../src/modules/attendances/contribution-shadow-disposition-registration.service';
import { prepareShadowReconciliationManifest } from '../src/modules/attendances/contribution-shadow-reconciliation-command';
import {
  parseRegistrationArguments,
  parseRegistrarCredentialInput,
} from './register-contribution-shadow-mapping';

async function credentialsFromPipe() {
  if (process.stdin.isTTY) throw new Error('Private credentials require a non-echo pipe');
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') throw new Error('Invalid private credential input');
    input += chunk;
    if (input.length > 32_768) throw new Error('Private credential input exceeds limit');
  }
  return parseRegistrarCredentialInput(JSON.parse(input) as unknown);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRegistrationArguments(argv);
  if (args.help) {
    process.stdout.write(
      'Default: validate only; no DB, authentication or approval.\n' +
        '--manifest <file> --expected-manifest-hash <sha256> [--execute]\n' +
        'Execute requires private piped JSON: registrarDatabaseUrl, accessToken.\n',
    );
    return;
  }
  const { manifest, manifestHash } = prepareShadowReconciliationManifest(
    JSON.parse(readFileSync(args.manifestPath, 'utf8')) as unknown,
    args.expectedHash,
  );
  if (!args.execute) {
    process.stdout.write(
      JSON.stringify({
        status: 'manifest_validated_only',
        manifestHash,
        operation: manifest.operation,
        authenticated: false,
        registered: false,
      }) + '\n',
    );
    return;
  }
  const credentials = await credentialsFromPipe();
  const jwt = loadJwtConfig();
  const prisma = new PrismaService({
    datasources: { db: { url: credentials.registrarDatabaseUrl } },
  });
  try {
    const identity = new AuthHumanCommandIdentityService(
      new JwtService({ secret: jwt.secret }),
      new JwtStrategy(new ConfigService({ jwt }), prisma),
    );
    const windowRegistration = new ContributionShadowWindowRegistrationService(
      identity,
      new RbacService(prisma),
    );
    const command =
      manifest.operation === 'register_window'
        ? windowRegistration
        : new ContributionShadowDispositionRegistrationService(windowRegistration);
    const result = await prisma.$transaction(
      (tx) => command.registerInTx(tx, credentials.accessToken, manifest, manifestHash),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000 },
    );
    process.stdout.write(
      JSON.stringify({
        status: 'registered',
        operation: manifest.operation,
        manifestHash,
        ...result,
      }) + '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Reconciliation rejected; credentials and provider details withheld.\n');
    process.exitCode = 1;
  });
}
