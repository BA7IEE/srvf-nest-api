/** Maintainer-controlled registrar command. No app-owner fallback, retry or background work. */
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { loadJwtConfig } from '../src/config/jwt.config';
import { PrismaService } from '../src/database/prisma.service';
import { AuthHumanCommandIdentityService } from '../src/modules/auth/auth-human-command-identity.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { RbacService } from '../src/modules/permissions/rbac.service';
import {
  ActivityContributionShadowMappingRegistrationService,
  parseShadowMappingRegistrationManifest,
} from '../src/modules/activities/activity-contribution-shadow-mapping-registration.service';
import {
  contributionPolicyObject,
  contributionPolicyHash,
} from '../src/modules/activities/activity-contribution-policy-command';
import { computeActivityTemplateDefinitionHash } from '../src/modules/activities/activity-template-definition';

export function parseRegistrationArguments(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true as const };
  let manifestPath: string | undefined;
  let expectedHash: string | undefined;
  let execute = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--execute' && !execute) {
      execute = true;
    } else if (flag === '--manifest' && manifestPath === undefined) {
      manifestPath = argv[++index];
      if (!manifestPath || manifestPath.startsWith('--')) throw new Error('Invalid manifest path');
    } else if (flag === '--expected-manifest-hash' && expectedHash === undefined) {
      expectedHash = contributionPolicyHash(argv[++index]);
    } else {
      throw new Error('Unknown or duplicate registrar argument');
    }
  }
  if (!manifestPath || !expectedHash) throw new Error('Manifest path and exact hash required');
  return { help: false as const, manifestPath, expectedHash, execute };
}

export function validateRegistrationManifest(value: unknown, expectedHash: string) {
  const manifest = parseShadowMappingRegistrationManifest(value);
  const manifestHash = computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: { domain: 'SRVF:E3-2:shadow-mapping-registration:v1', manifest },
  });
  if (manifestHash !== contributionPolicyHash(expectedHash))
    throw new Error('Manifest digest mismatch');
  return { manifest, manifestHash };
}

export function parseRegistrarCredentialInput(value: unknown) {
  const input = contributionPolicyObject(value, ['registrarDatabaseUrl', 'accessToken']);
  if (
    typeof input.registrarDatabaseUrl !== 'string' ||
    typeof input.accessToken !== 'string' ||
    !input.accessToken ||
    input.accessToken !== input.accessToken.trim()
  ) {
    throw new Error('Invalid private registrar input');
  }
  const url = new URL(input.registrarDatabaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname || url.pathname === '/')
    throw new Error('Invalid private registrar input');
  return { registrarDatabaseUrl: input.registrarDatabaseUrl, accessToken: input.accessToken };
}

async function credentialInput() {
  if (process.stdin.isTTY) throw new Error('Credentials require a non-echo pipe');
  process.stdin.setEncoding('utf8');
  let encoded = '';
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') throw new Error('Invalid private input');
    encoded += chunk;
  }
  const value: unknown = JSON.parse(encoded);
  return parseRegistrarCredentialInput(value);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRegistrationArguments(argv);
  if (args.help) {
    process.stdout.write(
      'Default: validate manifest only; no DB/authentication/approval.\n' +
        '--manifest <file> --expected-manifest-hash <sha256> [--execute]\n' +
        'Execute requires private piped JSON: registrarDatabaseUrl, accessToken. Never pass credentials as arguments.\n',
    );
    return;
  }
  const value: unknown = JSON.parse(readFileSync(args.manifestPath, 'utf8'));
  const { manifest, manifestHash } = validateRegistrationManifest(value, args.expectedHash);
  if (!args.execute) {
    process.stdout.write(
      JSON.stringify({
        status: 'manifest_validated_only',
        manifestHash,
        approvalCount: manifest.approvals.length,
        authenticated: false,
        registered: false,
      }) + '\n',
    );
    return;
  }
  const credentials = await credentialInput();
  const jwt = loadJwtConfig();
  const prisma = new PrismaService({
    datasources: { db: { url: credentials.registrarDatabaseUrl } },
  });
  try {
    const identity = new AuthHumanCommandIdentityService(
      new JwtService({ secret: jwt.secret }),
      new JwtStrategy(new ConfigService({ jwt }), prisma),
    );
    const service = new ActivityContributionShadowMappingRegistrationService(
      identity,
      new RbacService(prisma),
    );
    // Ordinary Prisma transaction budget; no migration, owner fallback or implicit ACL setup.
    await prisma.$transaction((tx) =>
      service.registerInTx(tx, credentials.accessToken, manifest, manifestHash),
    );
    process.stdout.write(
      JSON.stringify({
        status: 'registered',
        manifestHash,
        approvalCount: manifest.approvals.length,
      }) + '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    // Provider errors can contain connection URLs or JWT details. Never print them.
    process.stderr.write('Registration rejected; credentials and provider details withheld.\n');
    process.exitCode = 1;
  });
}
