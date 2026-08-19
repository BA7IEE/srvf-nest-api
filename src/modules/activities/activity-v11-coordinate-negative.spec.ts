import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AC-072 判据 —— 「坐标反向验收:本轮**未新增**坐标专用加密仓、隔离库、临时授权角色、
 * 专门期限、删除流程或专用告知上线门」。
 *
 * 这是**否定式**验收:要证的是「这六样东西不存在」。本仓对这类要求有现成范式 ——
 * 不去自由文本 grep(坐标列本来就该被提到,那样必假红),而是**逐个清点可枚举的登记处**:
 * 加密域清单、datasource 块、Role 闭集、env 清单、公开合同路由、同意字段与 *_ENABLED 闸。
 * 六样东西任意一样被加进来,都必须在这些登记处之一留下名字。
 *
 * 🔴 **零命中型判据必须自证**,否则一个坏掉的抽取器会把六条全报成绿 ——
 *    而「全绿」正是本判据要防的那个失效形状,它和「真的没新增」长得一模一样。
 *    所以每个抽取器都在下面第一条用例里跑一遍**正对照**(喂进「机制真被加进来」的
 *    合成文本,必须抓到)与**反对照**(allocation / storaGEObject 这两个子串陷阱,必须放行)。
 *    `prisma/schema.prisma` 是红区文件、不能拿去做外部变异对拍,正对照即其替代证据。
 */

/** 坐标语义的**词元**闭集。按词元精确比,不按子串比 —— 子串会把 allocation / storage 算进来。 */
const COORDINATE_TOKENS: ReadonlySet<string> = new Set([
  'coord',
  'coordinate',
  'coordinates',
  'gps',
  'geo',
  'geolocation',
  'geofence',
  'geohash',
  'longitude',
  'latitude',
  'lnglat',
  'latlng',
  'location',
]);

/** 把 camelCase / SNAKE_CASE / kebab-case 标识符切成小写词元。 */
function tokenize(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function namesCoordinateMechanism(identifier: string): boolean {
  return tokenize(identifier).some((token) => COORDINATE_TOKENS.has(token));
}

// ── 抽取器:全部是「源文本 → 登记项清单」的纯函数,便于用合成文本跑正对照 ──────────

function extractModelNames(schemaSource: string): string[] {
  return [...schemaSource.matchAll(/^model (\w+) \{/gmu)].map((match) => match[1]);
}

function extractEnumNames(schemaSource: string): string[] {
  return [...schemaSource.matchAll(/^enum (\w+) \{/gmu)].map((match) => match[1]);
}

function extractDatasourceCount(schemaSource: string): number {
  return (schemaSource.match(/^datasource /gmu) ?? []).length;
}

function extractRoleMembers(schemaSource: string): string[] {
  const block = /^enum Role \{([\s\S]*?)^\}/mu.exec(schemaSource);
  if (block === null) return [];
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

function extractEnvNames(configSource: string): string[] {
  return [
    ...new Set([...configSource.matchAll(/process\.env\.([A-Z0-9_]+)/gu)].map((match) => match[1])),
  ];
}

function extractConsentFields(schemaSource: string): string[] {
  return [...schemaSource.matchAll(/^\s*(\w*[Cc]onsent\w*)\s/gmu)].map((match) => match[1]);
}

// ── 真实输入 ─────────────────────────────────────────────────────────────────

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const configSource = ['app.config.ts', 'database.config.ts', 'jwt.config.ts']
  .map((file) => readFileSync(resolve(process.cwd(), 'src/config', file), 'utf8'))
  .join('\n');
const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/handoff/openapi.json'), 'utf8'),
) as { paths: Record<string, unknown> };

const modelNames = extractModelNames(schema);
const enumNames = extractEnumNames(schema);
const envNames = extractEnvNames(configSource);
const contractPaths = Object.keys(contract.paths);

describe('AC-072 坐标反向验收(本轮未新增六类坐标专用机制)', () => {
  it('🔴 判据自证:六个抽取器逐个跑正对照与反对照,并确认真实清单非空', () => {
    // ① 匹配器本身:正对照必中。
    expect(namesCoordinateMechanism('GpsVault')).toBe(true);
    expect(namesCoordinateMechanism('COORDINATE_ENCRYPTION_KEY')).toBe(true);
    expect(namesCoordinateMechanism('coordinate-erasure-requests')).toBe(true);
    // ② 匹配器本身:反对照必放行 —— 这两个是子串匹配必踩的坑
    //    (AL-LOCATION / storaGE-Object),词元匹配必须看得出来不是坐标。
    expect(namesCoordinateMechanism('AllocationBatch')).toBe(false);
    expect(namesCoordinateMechanism('StorageObject')).toBe(false);

    // ③ 抽取器 × 匹配器 配对:喂「机制真被加进来」的合成文本,必须抓到。
    //    schema.prisma 是红区文件、不能外部变异,这一格就是它的替代证据。
    const mutatedSchema = [
      schema,
      'model GpsVault {\n  id String @id\n}',
      'datasource geo {\n  provider = "postgresql"\n}',
      'enum GeoFenceMode {\n  STRICT\n}',
    ].join('\n\n');
    expect(extractModelNames(mutatedSchema).filter(namesCoordinateMechanism)).toEqual(['GpsVault']);
    expect(extractDatasourceCount(mutatedSchema)).toBe(2);
    expect(extractEnumNames(mutatedSchema).filter(namesCoordinateMechanism)).toEqual([
      'GeoFenceMode',
    ]);
    expect(
      extractRoleMembers(schema.replace(/^enum Role \{/mu, 'enum Role {\n  GPS_TEMP_AUDITOR')),
    ).toContain('GPS_TEMP_AUDITOR');
    expect(
      extractEnvNames('process.env.GPS_RETENTION_DAYS;process.env.COORDINATE_DISCLOSURE_ENABLED')
        .filter(namesCoordinateMechanism)
        .sort(),
    ).toEqual(['COORDINATE_DISCLOSURE_ENABLED', 'GPS_RETENTION_DAYS']);
    expect(
      extractConsentFields('  geoConsentAcceptedAt DateTime\n').filter(namesCoordinateMechanism),
    ).toEqual(['geoConsentAcceptedAt']);

    // ④ 清点非空 —— 空清单会让下面每一条「零命中」恒真。
    expect(modelNames.length).toBeGreaterThan(100);
    expect(enumNames.length).toBeGreaterThan(0);
    expect(envNames.length).toBeGreaterThan(30);
    expect(contractPaths.length).toBeGreaterThan(400);
  });

  it('① 未新增坐标专用加密仓:加密域清单仍是既有五个,且无坐标仓模型', () => {
    const encryptionDomains = envNames.filter((name) => name.endsWith('_ENCRYPTION_KEY')).sort();
    expect(encryptionDomains).toEqual([
      'REALNAME_ENCRYPTION_KEY',
      'SMS_ENCRYPTION_KEY',
      'STORAGE_ENCRYPTION_KEY',
      'WECHAT_ENCRYPTION_KEY',
      'WECOM_ENCRYPTION_KEY',
    ]);
    // 坐标列仍然只是既有业务表上的普通 Decimal 列,没有独立的坐标仓模型。
    expect(modelNames.filter(namesCoordinateMechanism)).toEqual([]);
  });

  it('② 未新增隔离库:schema 只有一个 datasource 块,且只有一个库连接串 env', () => {
    expect(extractDatasourceCount(schema)).toBe(1);
    expect(envNames.filter((name) => name.includes('DATABASE_URL')).sort()).toEqual([
      'DATABASE_URL',
    ]);
  });

  it('③ 未新增临时授权角色:Role 闭集仍是三态,且无坐标相关枚举', () => {
    expect(extractRoleMembers(schema)).toEqual(['SUPER_ADMIN', 'ADMIN', 'USER']);
    expect(enumNames.filter(namesCoordinateMechanism)).toEqual([]);
  });

  it('④ 未新增坐标专门期限:整份 env 清单里一个坐标词元都没有', () => {
    // 专门期限总得有个开关名;先按期限类 env 筛一遍,再对全清单兜底。
    expect(
      envNames
        .filter((name) => /RETENTION|TTL|PURGE|EXPIRE|ERASURE/u.test(name))
        .filter(namesCoordinateMechanism),
    ).toEqual([]);
    expect(envNames.filter(namesCoordinateMechanism)).toEqual([]);
  });

  it('⑤ 未新增坐标删除流程:公开合同里没有任何坐标专用路由', () => {
    expect(contractPaths.filter(namesCoordinateMechanism)).toEqual([]);
  });

  it('⑥ 未新增坐标专用告知上线门:同意字段与 *_ENABLED 闸里都没有坐标域', () => {
    // 本仓唯一的知情同意留痕是招募线的 privacyConsentAccepted,与坐标无关。
    expect(extractConsentFields(schema).filter(namesCoordinateMechanism)).toEqual([]);
    expect(
      envNames.filter((name) => name.endsWith('_ENABLED')).filter(namesCoordinateMechanism),
    ).toEqual([]);
  });
});
