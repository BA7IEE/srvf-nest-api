import { PrismaClient, StorageMimePolicyMode, StorageProviderType } from '@prisma/client';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import appConfig from '../../config/app.config';
import { StorageCryptoService } from './storage-crypto.service';

const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const SAFE_CONFIG_MODE_MASK = 0o077;

export interface StorageSettingsBootstrapArgs {
  configFile: string;
  confirmDatabase: string;
  dryRun: boolean;
}

interface StorageSettingsBootstrapConfig {
  databaseUrl: string;
  bucket: string;
  region: string;
  envPrefix: string;
  secretId: string;
  secretKey: string;
}

interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
  schema: 'public';
}

export interface StorageSettingsBootstrapResult {
  mode: 'dry-run' | 'create';
  target: DatabaseTarget;
  rowCountBefore: number;
  created: boolean;
  verified: boolean;
  providerType: 'COS';
  enabled: true;
  bucket: string;
  region: string;
  envPrefix: string;
  credentialConfigured: true;
}

export class StorageSettingsBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageSettingsBootstrapError';
  }
}

export function parseStorageSettingsBootstrapArgs(
  tokens: readonly string[],
): StorageSettingsBootstrapArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (const token of tokens) {
    if (!token.startsWith('--')) {
      throw new StorageSettingsBootstrapError('只接受 --name 或 --name=value 参数');
    }
    const separator = token.indexOf('=');
    if (separator < 0) {
      const name = token.slice(2);
      if (switches.has(name) || values.has(name)) {
        throw new StorageSettingsBootstrapError(`参数 --${name} 不可重复`);
      }
      switches.add(name);
      continue;
    }
    const name = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (!value) throw new StorageSettingsBootstrapError(`--${name} 不能为空`);
    if (switches.has(name) || values.has(name)) {
      throw new StorageSettingsBootstrapError(`参数 --${name} 不可重复`);
    }
    values.set(name, value);
  }

  for (const name of switches) {
    if (name !== 'dry-run') throw new StorageSettingsBootstrapError(`未知开关 --${name}`);
  }
  for (const name of values.keys()) {
    if (name !== 'config-file' && name !== 'confirm-database') {
      throw new StorageSettingsBootstrapError(`未知参数 --${name}`);
    }
  }

  return {
    configFile: requiredArg(values, 'config-file'),
    confirmDatabase: requiredArg(values, 'confirm-database'),
    dryRun: switches.has('dry-run'),
  };
}

export async function runStorageSettingsBootstrap(
  args: StorageSettingsBootstrapArgs,
): Promise<StorageSettingsBootstrapResult> {
  const config = loadBootstrapConfig(args.configFile);
  const target = parseDatabaseTarget(config.databaseUrl);
  if (args.confirmDatabase !== target.database) {
    throw new StorageSettingsBootstrapError(
      `--confirm-database 与配置目标库不一致:确认值=${args.confirmDatabase},目标库=${target.database}`,
    );
  }

  const cfg = appConfig();
  if (cfg.env !== 'production' && !(cfg.env === 'test' && target.database.startsWith('app_test'))) {
    throw new StorageSettingsBootstrapError(
      '仅允许 APP_ENV=production；测试例外要求 APP_ENV=test 且目标库名以 app_test 开头',
    );
  }

  const crypto = new StorageCryptoService(cfg);
  if (!crypto.isAvailable()) {
    throw new StorageSettingsBootstrapError('STORAGE_ENCRYPTION_KEY 未配置，拒绝初始化');
  }
  const secretIdEncrypted = crypto.encrypt(config.secretId);
  const secretKeyEncrypted = crypto.encrypt(config.secretKey);
  assertCredentialRoundTrip(crypto, config, secretIdEncrypted, secretKeyEncrypted);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl, errorFormat: 'minimal' });
  try {
    await prisma.$connect();
    const rowCountBefore = await prisma.storageSettings.count();
    if (rowCountBefore !== 0) {
      throw new StorageSettingsBootstrapError(
        `storage_settings 已存在 ${rowCountBefore} 行；该命令只允许初始化空表，拒绝覆盖`,
      );
    }

    if (args.dryRun) {
      return resultFor('dry-run', target, config, rowCountBefore, false);
    }

    await prisma.$transaction(async (tx) => {
      const lockedCount = await tx.storageSettings.count();
      if (lockedCount !== 0) {
        throw new StorageSettingsBootstrapError(
          `storage_settings 在写入前已出现 ${lockedCount} 行；拒绝覆盖`,
        );
      }

      const created = await tx.storageSettings.create({
        data: {
          providerType: StorageProviderType.COS,
          enabled: true,
          bucket: config.bucket,
          region: config.region,
          envPrefix: config.envPrefix,
          allowedMimePolicyMode: StorageMimePolicyMode.INHERIT,
          secretIdEncrypted,
          secretKeyEncrypted,
          credentialConfigured: true,
          remarks: 'offline production bootstrap',
          updatedBy: null,
        },
        select: { id: true },
      });
      const persisted = await tx.storageSettings.findUniqueOrThrow({ where: { id: created.id } });
      if (
        persisted.providerType !== StorageProviderType.COS ||
        persisted.enabled !== true ||
        persisted.bucket !== config.bucket ||
        persisted.region !== config.region ||
        persisted.envPrefix !== config.envPrefix ||
        persisted.credentialConfigured !== true ||
        !persisted.secretIdEncrypted ||
        !persisted.secretKeyEncrypted
      ) {
        throw new StorageSettingsBootstrapError(
          '写后读取的 StorageSettings 与预期不一致，事务已回滚',
        );
      }
      assertCredentialRoundTrip(
        crypto,
        config,
        persisted.secretIdEncrypted,
        persisted.secretKeyEncrypted,
      );
    });

    return resultFor('create', target, config, rowCountBefore, true);
  } catch (error) {
    if (error instanceof StorageSettingsBootstrapError) throw error;
    throw databaseError(error);
  } finally {
    await prisma.$disconnect();
  }
}

function loadBootstrapConfig(filePath: string): StorageSettingsBootstrapConfig {
  const absolutePath = resolve(filePath);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new StorageSettingsBootstrapError('config-file 必须是普通文件');
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new StorageSettingsBootstrapError(
      `config-file 超过 ${MAX_CONFIG_FILE_BYTES} bytes，拒绝读取`,
    );
  }
  if ((stat.mode & SAFE_CONFIG_MODE_MASK) !== 0) {
    throw new StorageSettingsBootstrapError(
      'config-file 不得授予 group/other 任何权限；请使用 chmod 600 或 chmod 400',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
  } catch {
    throw new StorageSettingsBootstrapError('config-file 不是合法 JSON');
  }
  if (!isRecord(parsed))
    throw new StorageSettingsBootstrapError('config-file 顶层必须是 JSON object');

  const allowedKeys = new Set([
    'databaseUrl',
    'bucket',
    'region',
    'envPrefix',
    'secretId',
    'secretKey',
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key))
      throw new StorageSettingsBootstrapError(`config-file 含未知字段 ${key}`);
  }

  return {
    databaseUrl: requiredTrimmedString(parsed, 'databaseUrl'),
    bucket: requiredTrimmedString(parsed, 'bucket', 100),
    region: requiredTrimmedString(parsed, 'region', 50),
    envPrefix: requiredTrimmedString(parsed, 'envPrefix', 50),
    secretId: requiredSecret(parsed, 'secretId'),
    secretKey: requiredSecret(parsed, 'secretKey'),
  };
}

function parseDatabaseTarget(databaseUrl: string): DatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new StorageSettingsBootstrapError('databaseUrl 必须是合法 PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new StorageSettingsBootstrapError('databaseUrl 仅允许 postgresql:// 或 postgres://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!database || database.includes('/')) {
    throw new StorageSettingsBootstrapError('databaseUrl 必须显式指定单一数据库名');
  }
  if (['postgres', 'template0', 'template1'].includes(database)) {
    throw new StorageSettingsBootstrapError(`禁止将系统数据库 ${database} 作为初始化目标`);
  }
  const schema = parsed.searchParams.get('schema') ?? 'public';
  if (schema !== 'public') {
    throw new StorageSettingsBootstrapError('databaseUrl 仅允许默认 public schema');
  }
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
    schema: 'public',
  };
}

function resultFor(
  mode: StorageSettingsBootstrapResult['mode'],
  target: DatabaseTarget,
  config: StorageSettingsBootstrapConfig,
  rowCountBefore: number,
  created: boolean,
): StorageSettingsBootstrapResult {
  return {
    mode,
    target,
    rowCountBefore,
    created,
    verified: true,
    providerType: 'COS',
    enabled: true,
    bucket: config.bucket,
    region: config.region,
    envPrefix: config.envPrefix,
    credentialConfigured: true,
  };
}

function assertCredentialRoundTrip(
  crypto: StorageCryptoService,
  config: StorageSettingsBootstrapConfig,
  secretIdEncrypted: string,
  secretKeyEncrypted: string,
): void {
  if (
    crypto.decrypt(secretIdEncrypted) !== config.secretId ||
    crypto.decrypt(secretKeyEncrypted) !== config.secretKey
  ) {
    throw new StorageSettingsBootstrapError('凭证加密写后解密校验失败');
  }
}

function databaseError(error: unknown): StorageSettingsBootstrapError {
  const code =
    isRecord(error) && typeof error.code === 'string'
      ? error.code
      : isRecord(error) && typeof error.errorCode === 'string'
        ? error.errorCode
        : 'UNKNOWN';
  return new StorageSettingsBootstrapError(
    `数据库连接或事务失败(code=${code})；未输出连接串或凭证`,
  );
}

function requiredArg(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new StorageSettingsBootstrapError(`缺少 --${name}=...`);
  return value;
}

function requiredTrimmedString(
  input: Record<string, unknown>,
  key: string,
  maxLength?: number,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StorageSettingsBootstrapError(`config-file.${key} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new StorageSettingsBootstrapError(`config-file.${key} 最长 ${maxLength} 字符`);
  }
  return trimmed;
}

function requiredSecret(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StorageSettingsBootstrapError(`config-file.${key} 必须是非空字符串`);
  }
  if (value !== value.trim()) {
    throw new StorageSettingsBootstrapError(`config-file.${key} 首尾不得含空白字符`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
