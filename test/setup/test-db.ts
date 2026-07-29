import { execSync } from 'child_process';
import { deriveTemplateTestDbName, deriveTestDbName, deriveWorkerTestDbName } from './worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';

// psql() 恒连容器内的维护库 postgres(不能 DROP 自己正连着的库)。
// 下方 assertLocalPostgresServer() 拿它做逐字比对的预期值。
const MAINTENANCE_DB = 'postgres';

// ─────────────────────────────────────────────────────────────────────────────
// 允许连接的 Postgres 主机名 —— **写死在代码里**,不读配置。
//
// 为什么写死:配置(.env.test / CI env)可以被一条 PR 改掉,而本文件在
// harness/redzone.json 的保护内,改它必须走授权 + CI 审批。把「什么算本机」
// 这条判据放在受保护的一侧,才是真的闸门。
//
// 清单只含「本机或本机容器网络内」的名字:
//   localhost / 127.0.0.1 / ::1        宿主机直连(.env.test 与 CI 用的就是这个)
//   postgres / db                       docker-compose 里两个最常见的服务名
//   u-nest-api-postgres                 本仓容器名(容器内跑 e2e / docker-smoke)
//   host.docker.internal                容器 → 宿主机回连
// 任何域名、任何公网可路由地址都不在其中 —— 这正是本次要堵的那个洞:
// 旧实现只查 url.includes('app_test'),
// `postgresql://u:p@prod.example.com:5432/app_test_prod` 原样放行,
// 随后 reset-db.ts 会对它 TRUNCATE 全部业务表。
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_DB_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'db',
  POSTGRES_CONTAINER,
  'host.docker.internal',
];

// E2E 测试库的核心安全护栏。
//
// 任何破坏性操作(TRUNCATE / migrate reset / migrate deploy)在执行前都必须先调用
// assertTestDatabaseUrl(process.env.DATABASE_URL),不通过 → 立刻抛错,拒绝继续。
//
// 三段判定,任何一段不过就拒:
//   1. 能解析成 postgresql:// URL
//   2. host 在 ALLOWED_DB_HOSTS 内(**不是子串,是逐字相等**)
//   3. 库名 **严格等于** 本进程该用的派生库名 deriveTestDbName()
//      —— 不是 startsWith,不是 includes。派生函数与 load-env 的
//      applyTestDbDerivation() 用的是同一个,所以两侧不可能各自漂移:
//      主进程(globalSetup / CLI)→ 模板库;jest worker 内 → 该 worker 的克隆库。
//
// 为什么第 3 段要严格相等:`app_test_prod`、`app_test_backup`、别的 lane 的
// `app_test_<slug>_<hash>` 全都含 'app_test' 子串,旧实现对它们一律放行。
export function assertTestDatabaseUrl(url: string | undefined): void {
  if (!url) {
    throw new Error('DATABASE_URL 未设置,拒绝执行测试库操作');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL 不是合法 URL,无法判定它指向哪台机器的哪个库 —— 拒绝执行破坏性操作。\n` +
        `实际 DATABASE_URL: ${maskUrl(url)}`,
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `DATABASE_URL 协议必须是 postgresql: / postgres:,实际是 '${parsed.protocol}' —— 拒绝执行破坏性操作。\n` +
        `实际 DATABASE_URL: ${maskUrl(url)}`,
    );
  }

  // URL.hostname 对 IPv6 已去掉方括号(`[::1]` → `::1`),与清单里的写法一致
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DB_HOSTS.includes(host)) {
    throw new Error(
      `DATABASE_URL 指向的主机 '${host}' 不在允许清单内 —— 拒绝执行 truncate / migrate / reset 等破坏性操作。\n` +
        `只允许本机或本机容器网络:${ALLOWED_DB_HOSTS.join(' / ')}\n` +
        `实际 DATABASE_URL: ${maskUrl(url)}`,
    );
  }

  const actualDbName = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const expectedDbName = deriveTestDbName();
  if (actualDbName !== expectedDbName) {
    throw new Error(
      `DATABASE_URL 的库名必须严格等于本进程派生的测试库名。\n` +
        `  期望:${expectedDbName}\n` +
        `  实际:${actualDbName}\n` +
        `拒绝执行 truncate / migrate / reset 等破坏性操作。\n` +
        `(含 'app_test' 子串不再等于安全 —— app_test_prod / 别的 lane 的库都含它)\n` +
        `实际 DATABASE_URL: ${maskUrl(url)}`,
    );
  }
}

// 第二道护栏:任何建/删库操作前,库名必须落在**本 checkout 派生出的那一族**内
// (模板库本身,或它的 _w1.._w99 克隆)。
//
// 旧实现是 startsWith('app_test') —— 那会放行别的 worktree/lane 的派生库
// (`app_test_<别的 slug>_<别的 hash>`),而 DROP ... WITH (FORCE) 会连人家
// 正在跑的 e2e 一起踩死。现在收紧成逐字比对派生结果。
export function assertDroppableTestDbName(name: string): void {
  const template = deriveTemplateTestDbName();
  const isTemplate = name === template;
  const isWorkerClone = new RegExp(
    `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_w[0-9]{1,2}$`,
  ).test(name);
  if (!isTemplate && !isWorkerClone) {
    throw new Error(
      `测试库生命周期操作只允许本 checkout 派生的库(${template} 或 ${template}_w<N>),` +
        `拒绝对 '${name}' 执行 CREATE / DROP`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 「连接建立之后」再问一次服务器它是谁。
//
// 为什么 URL 判定不够:URL 只是**意图**。DNS 劫持、SSH 端口转发、
// `localhost:5432` 被转到别处 —— 这些都能让一条完全合规的 URL 落到另一台机器上。
// 唯一可信的答案来自连接的另一端。
//
// 判定:
//   · current_database() 必须**逐字等于**预期库名
//   · inet_server_addr() 必须为 NULL(unix socket)或落在非公网地址段
//
// 关于第二条为什么不是逐字比对(如实写明,不假装更强):
// inet_server_addr() 返回的是**服务端接受连接时用的那个地址**。宿主机经 docker
// 端口映射连过去时,它是容器在网桥上的地址(本机实测 192.168.97.2),这个值随
// docker 网络配置而变,写死一个字面量会在别人机器上误伤。所以这里判的是「地址段」,
// 写死的是段的清单和理由 —— 拦不住「同一台机器上的另一个库」(那由 current_database()
// 的逐字比对负责),拦得住「连到了一台公网数据库」。
// ─────────────────────────────────────────────────────────────────────────────
function isNonPublicAddress(addr: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // 环回
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918(docker 默认网段在此)
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // 链路本地
    return false;
  }
  const v6 = addr.toLowerCase();
  if (v6 === '::1') return true; // 环回
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 链路本地
  return false;
}

/** 破坏性操作用的最小客户端形状(PrismaService / 裸 PrismaClient 都满足)。 */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
}

/**
 * 连上之后向服务器求证:你是谁、我连的是哪个库。
 * 任何破坏性 SQL(TRUNCATE / DROP / CREATE)之前调用。
 */
export async function assertConnectedTestDatabase(
  client: RawQueryClient,
  expectedDbName: string = deriveTestDbName(),
): Promise<void> {
  const rows = await client.$queryRawUnsafe<Array<{ db: string; srv: string | null }>>(
    'SELECT current_database() AS db, host(inet_server_addr()) AS srv',
  );
  const facts = rows?.[0];
  if (!facts) {
    throw new Error(
      '无法向 Postgres 求证 current_database() —— 拒绝在无法验证连接目标的情况下执行破坏性操作',
    );
  }
  if (facts.db !== expectedDbName) {
    throw new Error(
      `已连接的库与预期不符,拒绝执行破坏性操作。\n` +
        `  期望 current_database():${expectedDbName}\n` +
        `  实际 current_database():${facts.db}\n` +
        `(URL 只是意图;这一条查的是连接另一端的事实)`,
    );
  }
  if (facts.srv !== null && !isNonPublicAddress(facts.srv)) {
    throw new Error(
      `Postgres 服务端地址 '${facts.srv}' 是公网可路由地址,拒绝对它执行破坏性操作。\n` +
        `测试库只允许落在本机 / 本机容器网络内。`,
    );
  }
}

// docker exec 这条链路的等价求证:先确认 docker 引擎在本机(DOCKER_HOST 可以把
// `docker exec` 指到一台远程主机上 —— 那样容器名再对也没用),再向容器内的
// Postgres 问一次它是谁。结果按进程记忆,不给每条 psql() 加往返。
let localPostgresVerified = false;
function assertLocalPostgresServer(): void {
  if (localPostgresVerified) return;

  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    const local =
      dockerHost.startsWith('unix://') ||
      dockerHost.startsWith('npipe://') ||
      /^tcp:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(dockerHost);
    if (!local) {
      throw new Error(
        `DOCKER_HOST='${dockerHost}' 指向非本机的 docker 引擎 —— ` +
          `拒绝通过它对容器 ${POSTGRES_CONTAINER} 执行建库/删库操作。`,
      );
    }
  }

  const out = execSync(
    `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d ${MAINTENANCE_DB} ` +
      `-tAc "SELECT current_database() || '|' || coalesce(host(inet_server_addr()), '')"`,
    { encoding: 'utf-8' },
  ).trim();
  const [db, srv] = out.split('|');
  if (db !== MAINTENANCE_DB) {
    throw new Error(
      `容器内 psql 连到的是 '${db}' 而非维护库 '${MAINTENANCE_DB}' —— 拒绝执行建库/删库操作`,
    );
  }
  if (srv !== '' && !isNonPublicAddress(srv)) {
    throw new Error(
      `容器 ${POSTGRES_CONTAINER} 内的 psql 连到了公网地址 '${srv}' —— 拒绝执行建库/删库操作`,
    );
  }
  localPostgresVerified = true;
}

function psql(sql: string): string {
  assertLocalPostgresServer();
  return execSync(
    `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d ${MAINTENANCE_DB} -tAc "${sql}"`,
    {
      encoding: 'utf-8',
    },
  ).trim();
}

// 幂等地确保「模板库」存在;不存在则建之,已存在则跳过。
// 通过 docker exec 容器内 psql / createdb,与 npm script `db:test:init` 行为一致。
// 模板库 = checkout 级派生名(主仓 'app_test';linked worktree 'app_test_<slug>_<hash6>'),
// globalSetup 对它跑 migrate deploy,worker 库按它克隆。
export function ensureTemplateDatabaseExists(): string {
  const templateName = deriveTemplateTestDbName();
  let probeOutput = '';
  try {
    probeOutput = psql(`SELECT 1 FROM pg_database WHERE datname='${templateName}'`);
  } catch (err) {
    throw new Error(
      `无法连接 Postgres 容器 ${POSTGRES_CONTAINER}。请先执行 \`docker compose up -d\` 等待 healthy。\n原始错误: ${(err as Error).message}`,
    );
  }

  if (probeOutput !== '1') {
    execSync(`docker exec ${POSTGRES_CONTAINER} createdb -U postgres ${templateName}`, {
      stdio: 'inherit',
    });
  }
  return templateName;
}

// 兼容旧名(reset-test-db-cli.ts 等调用点):语义 = 确保模板库存在。
export const ensureTestDatabaseExists = ensureTemplateDatabaseExists;

function connectionCount(dbName: string): string {
  return psql(
    `SELECT count(*) FROM pg_stat_activity WHERE datname='${dbName}' AND pid<>pg_backend_pid()`,
  );
}

function inspectHint(dbName: string): string {
  return (
    `  docker exec ${POSTGRES_CONTAINER} psql -U postgres ` +
    `-c "SELECT pid, application_name, state FROM pg_stat_activity WHERE datname='${dbName}'"`
  );
}

// CREATE DATABASE ... TEMPLATE 要求模板库零连接;连接残留时给出人话错误,
// 否则非职业程序员维护者会卡死在一条 Postgres 原生报错上。
export function assertTemplateHasNoConnections(): void {
  const templateName = deriveTemplateTestDbName();
  const count = connectionCount(templateName);
  if (count !== '0') {
    throw new Error(
      `模板测试库 '${templateName}' 上还有 ${count} 个活跃连接(Prisma Studio?dev server?),` +
        `无法按模板克隆 worker 库。请关闭这些连接后重跑;查看来源:\n${inspectHint(templateName)}`,
    );
  }
}

// 并行 e2e 需要的最低连接容量:worker 数 × 每 spec 最多 3 个 app × connection_limit
// + seed 子进程/裸 PrismaClient 余量。容器 max_connections 不足时给人话错误,
// 否则表现为随机的 "too many clients" / P2024,极难归因。
export function assertConnectionCapacity(workers: number, connectionLimit = 5): void {
  const required = workers * 3 * connectionLimit + 20;
  const current = Number(psql('SHOW max_connections'));
  if (!Number.isFinite(current) || current < required) {
    throw new Error(
      `Postgres max_connections=${current},低于并行 e2e 所需的 ${required}` +
        `(${workers} worker × 3 app × ${connectionLimit} 连接 + 20 余量)。\n` +
        `修复:docker compose up -d postgres(让容器按 docker-compose.yml 的 max_connections=200 重建);\n` +
        `或临时降低并发:JEST_MAX_WORKERS=2 pnpm test:e2e`,
    );
  }
}

// 重建指定 worker 的克隆库:DROP ... WITH (FORCE)(PG13+,免手动 terminate)后按模板克隆。
// 文件级拷贝(单库实测 13-17MB,约 0.2-0.6s),且保证与模板逐字节同构、
// 天然带上 _prisma_migrations —— worker 内任何再次 migrate deploy 都是 no-op。
export function recreateWorkerDatabase(workerId: string | number): string {
  const templateName = deriveTemplateTestDbName();
  const workerName = deriveWorkerTestDbName(workerId);
  assertDroppableTestDbName(workerName);

  // ⚠️ DROP ... WITH (FORCE) 会先 terminate 目标库的全部连接。若同一 worktree 内
  // 另一条 jest 命令(另一个窗口的 test:e2e / test:contract / agent:check:full)
  // 正在用这个 worker 库,静默 FORCE 删除会让两条 run 共用重建后的同名库、互相
  // TRUNCATE —— 正是本设计要根除的跨 run 互擦。模板库零连接断言检测不到这种情况
  // (并发 run 的 worker 连的是 _wN 而非模板),所以必须在这里对目标库单独把关。
  const inUse = connectionCount(workerName);
  if (inUse !== '0') {
    throw new Error(
      `worker 测试库 '${workerName}' 上有 ${inUse} 个活跃连接,拒绝强制重建。\n` +
        `通常意味着同一 worktree 内已有另一条 jest 命令在跑(test:e2e / test:contract / agent:check:full),` +
        `两条 run 共用测试库会互相 TRUNCATE。请等它跑完或终止后重试;查看来源:\n${inspectHint(workerName)}`,
    );
  }

  psql(`DROP DATABASE IF EXISTS \\"${workerName}\\" WITH (FORCE)`);
  try {
    psql(`CREATE DATABASE \\"${workerName}\\" TEMPLATE \\"${templateName}\\"`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/being accessed by other users|source database .* is being accessed/i.test(msg)) {
      throw new Error(
        `按模板克隆 '${workerName}' 失败:模板库 '${templateName}' 在克隆期间被重新连接` +
          `(Prisma Studio?dev server?)。请关闭后重跑;查看来源:\n${inspectHint(templateName)}`,
      );
    }
    throw err;
  }
  return workerName;
}

// globalTeardown:回收 worker 克隆库(模板库保留 —— 它是下次克隆的源,
// 也让 pnpm db:test:reset / db:test:init 的语义保持不变)。
export function dropWorkerDatabase(workerId: string | number): void {
  const workerName = deriveWorkerTestDbName(workerId);
  assertDroppableTestDbName(workerName);
  psql(`DROP DATABASE IF EXISTS \\"${workerName}\\" WITH (FORCE)`);
}

function maskUrl(url: string): string {
  // 隐藏 user:password 部分,避免抛错信息泄漏凭据
  return url.replace(/:[^:@/]*@/, ':***@');
}
