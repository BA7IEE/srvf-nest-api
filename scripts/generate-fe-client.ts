/**
 * generate-fe-client.ts — 前端 TS client 生成器(架构治理 Phase 5 刀 5-3 / v4 Phase 5)
 *
 * 从 `docs/handoff/openapi.json` 按 surface 生成 **admin 与 app 两份** TypeScript
 * 类型 + 轻客户端,落 `docs/handoff/clients/{admin,app}/`。
 *
 * ── 产物边界(刻意很窄,别顺手扩)────────────────────────────────────────────
 * 只出**类型与调用签名**。**不含任何鉴权逻辑、不含任何 secret / 令牌 / baseURL**:
 * 传输层由消费方注入一个 `Fetcher`,登录态怎么带、令牌怎么刷新,全在前端仓自己手里。
 * 生成器因此永远不需要知道任何凭证 —— 这不是"暂时没做",是产物的定义。
 *
 * ── 只生成 admin 与 app 两个 surface ────────────────────────────────────────
 * 现网 5 个 surface(admin 205 / app 94 / system 46 / auth 20 / open 16 paths)。
 * 本刀按 goal 只出 admin 与 app 两份。**auth/v1(登录/刷新)刻意不在内** ——
 * 它是全端通用的接线,handoff §3.1 已单独成节;要不要一并生成留给维护者拍板,
 * 不在这一刀替他决定。system / open 同理。此边界在收口报告与 handoff README 具名列出。
 *
 * ── inputDigest:确定性,禁时间戳 / git SHA(v4 §9 第 1 条)─────────────────
 * 产物头部带 `inputDigest = sha256(生成输入闭包)`。**不写时间戳、不写 git SHA**:
 * 时间戳让"重新生成逐字比对"恒假红;SHA 提交前不可知、提交后即过期(自引用悖论)。
 * 输入闭包 = 契约内容 + 生成器版本 + surface 定义,枚举**单源在本文件内**,
 * selftest 阳性对照:触碰任一输入必须翻转 digest。
 *
 * 用法:
 *   pnpm docs:feclient          # 生成 / 就地刷新
 *   pnpm docs:feclient:check    # 新鲜度校验(重新生成逐字比对),CI Docs guards 同链
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(scripts/generate-*.ts)。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = 'docs/handoff/openapi.json';
const OUT_DIR = 'docs/handoff/clients';
const GENERATOR_VERSION = '1.0.0';

/** surface 定义 —— 与 inputDigest 闭包同源,改这里必然翻转 digest。 */
export const SURFACES: ReadonlyArray<{ readonly id: string; readonly prefix: string; readonly title: string }> = [
  { id: 'admin', prefix: '/api/admin/', title: 'Admin 管理后台' },
  { id: 'app', prefix: '/api/app/', title: 'App 小程序' },
];

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface AnyObject {
  [key: string]: unknown;
}

export interface Endpoint {
  readonly operationId: string;
  readonly method: string;
  readonly route: string;
  readonly summary: string;
  readonly pathParams: ReadonlyArray<{ name: string; type: string }>;
  readonly queryParams: ReadonlyArray<{ name: string; type: string; required: boolean }>;
  readonly bodyType: string | null;
  readonly dataType: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 类型映射
// ──────────────────────────────────────────────────────────────────────────

function refName(ref: string): string {
  return ref.split('/').pop() as string;
}

/** OpenAPI schema → TS 类型字面量。收集用到的 schema 名到 used。 */
export function tsType(schema: unknown, used: Set<string>, depth = 0): string {
  if (schema === null || typeof schema !== 'object' || depth > 12) return 'unknown';
  const node = schema as AnyObject;

  if (typeof node.$ref === 'string') {
    const name = refName(node.$ref);
    used.add(name);
    return name;
  }
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.map((part) => tsType(part, used, depth + 1)).filter((t) => t !== 'unknown');
    const inline = node.properties ? objectLiteral(node, used, depth + 1) : null;
    const all = inline ? [...parts, inline] : parts;
    return all.length === 0 ? 'unknown' : all.join(' & ');
  }
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    const list = (node.oneOf ?? node.anyOf) as unknown[];
    return list.map((part) => tsType(part, used, depth + 1)).join(' | ') || 'unknown';
  }
  if (Array.isArray(node.enum)) {
    const values = (node.enum as unknown[]).map((value) =>
      typeof value === 'string' ? JSON.stringify(value) : String(value),
    );
    return values.join(' | ') + (node.nullable === true ? ' | null' : '');
  }

  let base: string;
  switch (node.type) {
    case 'string':
      base = 'string';
      break;
    case 'number':
    case 'integer':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'array':
      base = tsType(node.items ?? {}, used, depth + 1) + '[]';
      break;
    case 'object':
      base = node.properties ? objectLiteral(node, used, depth + 1) : 'Record<string, unknown>';
      break;
    default:
      base = node.properties ? objectLiteral(node, used, depth + 1) : 'unknown';
  }
  return node.nullable === true ? base + ' | null' : base;
}

function objectLiteral(node: AnyObject, used: Set<string>, depth: number): string {
  const props = (node.properties ?? {}) as AnyObject;
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  const fields = Object.entries(props).map(([name, value]) => {
    const optional = required.has(name) ? '' : '?';
    return `${JSON.stringify(name)}${optional}: ${tsType(value, used, depth + 1)}`;
  });
  return fields.length === 0 ? 'Record<string, unknown>' : `{ ${fields.join('; ')} }`;
}

// ──────────────────────────────────────────────────────────────────────────
// 契约提取
// ──────────────────────────────────────────────────────────────────────────

/** 从统一 envelope 里剥出 `data` 的类型 —— 前端拿到的是 data,不是 envelope。 */
function dataType(operation: AnyObject, used: Set<string>): string {
  const responses = (operation.responses ?? {}) as AnyObject;
  const code = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort()[0];
  if (!code) return 'void';
  const response = (responses[code] ?? {}) as AnyObject;
  const content = (response.content ?? {}) as AnyObject;
  const json = (content['application/json'] ?? {}) as AnyObject;
  const schema = (json.schema ?? null) as AnyObject | null;
  if (!schema) return 'void';
  const props = (schema.properties ?? {}) as AnyObject;
  if (!props.data) return 'unknown';
  return tsType(props.data, used);
}

export function collectEndpoints(doc: AnyObject, prefix: string, used: Set<string>): Endpoint[] {
  const out: Endpoint[] = [];
  const paths = (doc.paths ?? {}) as AnyObject;
  for (const route of Object.keys(paths).sort()) {
    if (!route.startsWith(prefix)) continue;
    const item = (paths[route] ?? {}) as AnyObject;
    for (const method of METHODS) {
      const operation = item[method] as AnyObject | undefined;
      if (!operation) continue;
      const params = Array.isArray(operation.parameters) ? (operation.parameters as AnyObject[]) : [];
      const body = (operation.requestBody ?? null) as AnyObject | null;
      const bodySchema = body
        ? ((((body.content ?? {}) as AnyObject)['application/json'] ?? {}) as AnyObject).schema
        : null;
      out.push({
        operationId:
          typeof operation.operationId === 'string' && operation.operationId !== ''
            ? operation.operationId
            : method + route.replace(/[^A-Za-z0-9]+/g, '_'),
        method: method.toUpperCase(),
        route,
        summary: typeof operation.summary === 'string' ? operation.summary : '',
        pathParams: params
          .filter((param) => param.in === 'path')
          .map((param) => ({ name: String(param.name), type: tsType(param.schema ?? {}, used) })),
        queryParams: params
          .filter((param) => param.in === 'query')
          .map((param) => ({
            name: String(param.name),
            type: tsType(param.schema ?? {}, used),
            required: param.required === true,
          })),
        bodyType: bodySchema ? tsType(bodySchema, used) : null,
        dataType: dataType(operation, used),
      });
    }
  }
  return out;
}

/** 传递闭包:被用到的 schema 里引用的 schema 也要一起吐出来,否则产物 import 不齐。 */
function closeSchemas(doc: AnyObject, used: Set<string>): string[] {
  const schemas = ((doc.components ?? {}) as AnyObject).schemas as AnyObject;
  const queue = [...used];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    const schema = schemas?.[name];
    if (!schema) continue;
    const nested = new Set<string>();
    tsType(schema, nested);
    for (const child of nested) {
      if (!used.has(child)) {
        used.add(child);
        queue.push(child);
      }
    }
  }
  return [...used].filter((name) => schemas?.[name] !== undefined).sort();
}

// ──────────────────────────────────────────────────────────────────────────
// 渲染
// ──────────────────────────────────────────────────────────────────────────

function fnName(operationId: string): string {
  const cleaned = operationId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const camel = cleaned.replace(/_([a-zA-Z0-9])/g, (_all, ch: string) => ch.toUpperCase());
  return /^[0-9]/.test(camel) ? 'op' + camel : camel;
}

function renderTypes(
  surfaceTitle: string,
  digest: string,
  schemaNames: readonly string[],
  doc: AnyObject,
): string {
  const schemas = ((doc.components ?? {}) as AnyObject).schemas as AnyObject;
  const lines: string[] = [
    '// 由 scripts/generate-fe-client.ts 生成,请勿手改。',
    '// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。',
    `// surface: ${surfaceTitle}`,
    `// generatorVersion: ${GENERATOR_VERSION}`,
    `// inputDigest: ${digest}`,
    '',
    '/** 统一响应 envelope —— 全仓契约恒为 { code, message, data }。 */',
    'export interface ApiEnvelope<T> {',
    '  code: number;',
    '  message: string;',
    '  data: T;',
    '}',
    '',
    '/** 分页形状 —— 由 @ApiWrappedPageResponse 保证,items 元素类型逐接口指定。 */',
    'export interface PageResult<T> {',
    '  items: T[];',
    '  total: number;',
    '  page: number;',
    '  pageSize: number;',
    '}',
    '',
  ];
  for (const name of schemaNames) {
    const schema = (schemas[name] ?? {}) as AnyObject;
    const description = typeof schema.description === 'string' ? schema.description : '';
    if (description) lines.push(`/** ${description.replace(/\r?\n/g, ' ')} */`);
    const body = tsType({ ...schema, $ref: undefined }, new Set<string>());
    if (body.startsWith('{')) {
      lines.push(`export interface ${name} ${body.replace(/; /g, ';\n  ').replace(/^\{ /, '{\n  ').replace(/ \}$/, ';\n}')}`);
    } else {
      lines.push(`export type ${name} = ${body};`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderClient(
  surfaceId: string,
  surfaceTitle: string,
  digest: string,
  endpoints: readonly Endpoint[],
  schemaNames: readonly string[],
): string {
  const clientName = 'create' + surfaceId.charAt(0).toUpperCase() + surfaceId.slice(1) + 'Client';
  const lines: string[] = [
    '// 由 scripts/generate-fe-client.ts 生成,请勿手改。',
    `// surface: ${surfaceTitle}`,
    `// generatorVersion: ${GENERATOR_VERSION}`,
    `// inputDigest: ${digest}`,
    '//',
    '// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。',
    '//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理',
    '//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。',
    '',
    schemaNames.length > 0
      ? `import type {\n  ApiEnvelope,\n  PageResult,\n${schemaNames.map((n) => `  ${n},`).join('\n')}\n} from './types';`
      : "import type { ApiEnvelope, PageResult } from './types';",
    '',
    'export type { ApiEnvelope, PageResult };',
    '',
    '/** 传输层由消费方注入 —— 生成器不产生任何网络与凭证代码。 */',
    'export interface FetchRequest {',
    '  method: string;',
    '  path: string;',
    '  query?: Record<string, unknown>;',
    '  body?: unknown;',
    '}',
    '',
    'export type Fetcher = <T>(request: FetchRequest) => Promise<ApiEnvelope<T>>;',
    '',
    `export function ${clientName}(fetcher: Fetcher) {`,
    '  return {',
  ];

  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    let name = fnName(endpoint.operationId);
    while (seen.has(name)) name = name + '_';
    seen.add(name);

    const args: string[] = [];
    for (const param of endpoint.pathParams) args.push(`${param.name}: ${param.type}`);
    if (endpoint.queryParams.length > 0) {
      const fields = endpoint.queryParams
        .map((param) => `${JSON.stringify(param.name)}${param.required ? '' : '?'}: ${param.type}`)
        .join('; ');
      const allOptional = endpoint.queryParams.every((param) => !param.required);
      args.push(`query${allOptional ? '?' : ''}: { ${fields} }`);
    }
    if (endpoint.bodyType) args.push(`body: ${endpoint.bodyType}`);

    const pathExpr =
      endpoint.pathParams.length === 0
        ? JSON.stringify(endpoint.route)
        : '`' + endpoint.route.replace(/\{([^}]+)\}/g, '${$1}').replace(/:([A-Za-z0-9_]+)/g, '${$1}') + '`';

    const call: string[] = [`method: ${JSON.stringify(endpoint.method)}`, `path: ${pathExpr}`];
    if (endpoint.queryParams.length > 0) call.push('query');
    if (endpoint.bodyType) call.push('body');

    if (endpoint.summary) lines.push(`    /** ${endpoint.summary.replace(/\r?\n/g, ' ')} */`);
    lines.push(
      `    ${name}(${args.join(', ')}): Promise<ApiEnvelope<${endpoint.dataType}>> {`,
      `      return fetcher<${endpoint.dataType}>({ ${call.join(', ')} });`,
      '    },',
    );
  }
  lines.push('  };', '}', '');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// inputDigest + 落盘
// ──────────────────────────────────────────────────────────────────────────

/**
 * 输入闭包的确定性摘要。**枚举单源在这里** —— selftest 阳性对照会逐项触碰,
 * 触碰任一输入必须翻转 digest(防枚举漏项造成静默陈旧,§9 第 7 条)。
 */
export function computeInputDigest(contractText: string): string {
  const closure = [
    'generatorVersion=' + GENERATOR_VERSION,
    'surfaces=' + SURFACES.map((surface) => surface.id + ':' + surface.prefix).join(','),
    'contract=' + crypto.createHash('sha256').update(contractText).digest('hex'),
  ].join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(closure).digest('hex');
}

export function renderAll(contractText: string): Map<string, string> {
  const doc = JSON.parse(contractText) as AnyObject;
  const digest = computeInputDigest(contractText);
  const files = new Map<string, string>();
  for (const surface of SURFACES) {
    const used = new Set<string>();
    const endpoints = collectEndpoints(doc, surface.prefix, used);
    const schemaNames = closeSchemas(doc, used);
    files.set(
      path.posix.join(OUT_DIR, surface.id, 'types.ts'),
      renderTypes(surface.title, digest, schemaNames, doc),
    );
    files.set(
      path.posix.join(OUT_DIR, surface.id, 'client.ts'),
      renderClient(surface.id, surface.title, digest, endpoints, schemaNames),
    );
  }
  return files;
}

/**
 * 产物自校验 —— 生成器**自己**给自己的输出跑 TS 诊断。
 *
 * 为什么必须有(开工核验实测):`pnpm lint` 只扫 `src|test|prisma`,三份 tsconfig 的
 * include 也都不含 `docs/**` —— 也就是说 `docs/handoff/clients/**` 落在现有管线的
 * **射程之外**,产物就算生成成语法废品,lint 与 typecheck 都一声不吭。
 *
 * 修法刻意不是"把 docs/ 加进 tsconfig":那会动到 `ci-control-plane` 红区、平白扩大
 * 授权面,而且会把生成物拉进主类型检查图(生成物一旦有问题就阻塞所有人)。
 * 让生成器自校验,责任落在产出方,范围也只限自己那几个文件。
 */
export function validateEmitted(files: ReadonlyMap<string, string>): string[] {
  const names = [...files.keys()];
  const sources = new Map<string, ts.SourceFile>();
  for (const [rel, content] of files) {
    sources.set(rel, ts.createSourceFile(rel, content, ts.ScriptTarget.ES2022, true));
  }
  const host: ts.CompilerHost = {
    fileExists: (fileName) => sources.has(normalize(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) => files.get(normalize(fileName)) ?? ts.sys.readFile(fileName),
    getSourceFile: (fileName) => {
      const own = sources.get(normalize(fileName));
      if (own) return own;
      const text = ts.sys.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    writeFile: () => undefined,
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram(names, {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && sources.has(normalize(diagnostic.file.fileName)))
    .map((diagnostic) => {
      const file = diagnostic.file as ts.SourceFile;
      const at = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return (
        normalize(file.fileName) +
        ':' +
        (at.line + 1) +
        ' ' +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      );
    });
}

function normalize(fileName: string): string {
  const rel = path.relative(ROOT, path.resolve(ROOT, fileName));
  return rel.split(path.sep).join('/');
}

function main(): void {
  const argv = process.argv.slice(2);
  const checkMode = argv.includes('--check');
  const contractText = fs.readFileSync(path.join(ROOT, CONTRACT), 'utf8');
  const files = renderAll(contractText);

  // 无论 write 还是 check,先证明"要落盘的这份东西编译得过"。
  const diagnostics = validateEmitted(files);
  if (diagnostics.length > 0) {
    process.stderr.write(
      '[L6] 生成的 FE client 无法通过 TypeScript 诊断 —— 生成器产出了不合法的产物:\n' +
        diagnostics.slice(0, 15).map((line) => '  · ' + line).join('\n') +
        (diagnostics.length > 15 ? `\n  · …另有 ${diagnostics.length - 15} 条` : '') +
        '\n处置: 修 scripts/generate-fe-client.ts 的类型映射,不要手改产物。\n',
    );
    process.exit(1);
  }

  if (checkMode) {
    const stale: string[] = [];
    for (const [rel, content] of files) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content) stale.push(rel);
    }
    if (stale.length > 0) {
      process.stderr.write(
        '[L6/R11] 前端 client 产物已陈旧,与当前契约不一致:\n' +
          stale.map((rel) => '  · ' + rel).join('\n') +
          '\n事实: 重新生成后与仓内产物逐字不符 —— 契约改了而 client 没刷新,或产物被手改。\n' +
          '依据: docs/handoff/clients/**(生成物,禁手改;新鲜度由本检查守护)\n' +
          '处置: 跑 `pnpm docs:feclient` 重新生成并提交;不要手改产物。\n',
      );
      process.exit(1);
    }
    process.stdout.write(
      'FE client 产物新鲜:' + files.size + ' 个文件,' + SURFACES.length + ' 个 surface。\n',
    );
    return;
  }

  for (const [rel, content] of files) {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  process.stdout.write(
    'Generated FE clients: ' + files.size + ' files across ' + SURFACES.length + ' surfaces.\n',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      'generate-fe-client failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
    );
    process.exit(1);
  }
}
