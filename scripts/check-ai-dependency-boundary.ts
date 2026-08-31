/**
 * Activity OS 的 No AI core dependency 裁判。
 *
 * 运行入口：`pnpm exec tsx scripts/check-ai-dependency-boundary.ts`。
 * 实际 CI 消费者是 `src/ai-dependency-boundary.criteria.spec.ts`，因此本文件既有
 * `scripts/check-*.ts` 的红区保护，也不会变成一个未接线的孤立脚本。
 *
 * 这条规则不禁止将来存在经过独立评审的可选 Assist；它禁止核心生产源码依赖 AI 模块或
 * Provider，并要求主应用启动不注册该可选模块。Provider 依赖的新增也必须触发独立评审。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(ROOT, 'src');
const AI_MODULE_ROOT = join(SRC_ROOT, 'modules', 'ai');

export const APP_MODULE = 'src/app.module.ts';

const PROVIDER_PACKAGE_PATTERNS = [
  /^ai$/,
  /^@ai-sdk(?:\/|$)/,
  /^@anthropic-ai(?:\/|$)/,
  /^@google\/generative-ai(?:\/|$)/,
  /^@langchain(?:\/|$)/,
  /^@mistralai(?:\/|$)/,
  /^@nestjs\/ai(?:\/|$)/,
  /^cohere-ai(?:\/|$)/,
  /^groq-sdk(?:\/|$)/,
  /^langchain(?:\/|$)/,
  /^ollama(?:\/|$)/,
  /^openai(?:\/|$)/,
];

export type AiDependencyFindingKind =
  | 'A1_PROVIDER_IMPORT'
  | 'A2_AI_MODULE_IMPORT'
  | 'A3_APP_MODULE_REGISTRATION'
  | 'A4_PROVIDER_DEPENDENCY';

export interface AiDependencyFinding {
  readonly kind: AiDependencyFindingKind;
  readonly file: string;
  readonly detail: string;
}

export interface AiPackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export interface AiDependencyBoundaryReport {
  readonly findings: readonly AiDependencyFinding[];
  readonly productionFileCount: number;
  readonly coreFileCount: number;
  readonly scannedAppModule: boolean;
}

export type AiSourceOverrides = Readonly<Record<string, string>>;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

function sourceText(file: string, overrides: AiSourceOverrides): string {
  const rel = repoPath(file);
  return Object.prototype.hasOwnProperty.call(overrides, rel)
    ? overrides[rel]
    : readFileSync(file, 'utf8');
}

function productionFiles(overrides: AiSourceOverrides): string[] {
  const actual = walkTsFiles(SRC_ROOT).map(repoPath);
  const synthetic = Object.keys(overrides).filter(
    (file) => file.startsWith('src/') && file.endsWith('.ts') && !actual.includes(file),
  );
  return [...new Set([...actual, ...synthetic])]
    .filter((file) => !file.endsWith('.spec.ts'))
    .sort()
    .map((file) => join(ROOT, file));
}

function isCoreFile(file: string): boolean {
  return !repoPath(file).startsWith('src/modules/ai/');
}

function isProviderPackage(specifier: string): boolean {
  return PROVIDER_PACKAGE_PATTERNS.some((pattern) => pattern.test(specifier));
}

function pointsToAiModule(sourceFile: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const candidate = resolve(dirname(sourceFile), specifier);
    return candidate === AI_MODULE_ROOT || candidate.startsWith(`${AI_MODULE_ROOT}${sep}`);
  }
  return /(?:^|\/)modules\/ai(?:\/|$)/.test(specifier);
}

function collectModuleSpecifiers(sourceFile: string, sourceTextValue: string): string[] {
  const source = ts.createSourceFile(sourceFile, sourceTextValue, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const collect = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, collect);
  };

  collect(source);
  return specifiers;
}

function declaredPackageNames(manifest: AiPackageManifest): string[] {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
    .flatMap((dependencies) => Object.keys(dependencies ?? {}))
    .sort();
}

function packageManifest(): AiPackageManifest {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as AiPackageManifest;
}

export function checkAiDependencyBoundary(
  overrides: AiSourceOverrides = {},
  manifest: AiPackageManifest = packageManifest(),
): AiDependencyBoundaryReport {
  const files = productionFiles(overrides);
  const coreFiles = files.filter(isCoreFile);
  const findings: AiDependencyFinding[] = [];

  for (const file of coreFiles) {
    const rel = repoPath(file);
    for (const specifier of collectModuleSpecifiers(file, sourceText(file, overrides))) {
      if (isProviderPackage(specifier)) {
        findings.push({
          kind: 'A1_PROVIDER_IMPORT',
          file: rel,
          detail: `核心源码直接引用 AI Provider 包 '${specifier}'`,
        });
      }
      if (pointsToAiModule(file, specifier)) {
        findings.push({
          kind: 'A2_AI_MODULE_IMPORT',
          file: rel,
          detail: `核心源码直接引用可选 AI 模块 '${specifier}'`,
        });
      }
    }
  }

  const appModule = join(ROOT, APP_MODULE);
  const appModuleSource = sourceText(appModule, overrides);
  if (
    collectModuleSpecifiers(appModule, appModuleSource).some((specifier) =>
      pointsToAiModule(appModule, specifier),
    )
  ) {
    findings.push({
      kind: 'A3_APP_MODULE_REGISTRATION',
      file: APP_MODULE,
      detail: '生产 AppModule 直接 import 可选 AI 模块，核心启动不再可独立运行',
    });
  }

  for (const dependency of declaredPackageNames(manifest)) {
    if (isProviderPackage(dependency)) {
      findings.push({
        kind: 'A4_PROVIDER_DEPENDENCY',
        file: 'package.json',
        detail: `仓库声明了 AI Provider 依赖 '${dependency}'，须在独立 AI 评审中处理`,
      });
    }
  }

  return {
    findings,
    productionFileCount: files.length,
    coreFileCount: coreFiles.length,
    scannedAppModule: files.some((file) => repoPath(file) === APP_MODULE),
  };
}

export function aiDependencyBoundarySelfCheck(report: AiDependencyBoundaryReport): string[] {
  const failures: string[] = [];
  if (report.productionFileCount === 0) failures.push('生产 TypeScript 扫描面为空');
  if (report.coreFileCount === 0) failures.push('核心生产源码扫描面为空');
  if (!report.scannedAppModule) failures.push(`扫描面未包含 ${APP_MODULE}`);
  return failures;
}

function main(): void {
  const report = checkAiDependencyBoundary();
  const failures = [
    ...aiDependencyBoundarySelfCheck(report),
    ...report.findings.map((f) => f.detail),
  ];
  process.stdout.write(
    `AI dependency boundary: production=${report.productionFileCount}, core=${report.coreFileCount}, findings=${report.findings.length}\n`,
  );
  if (failures.length === 0) return;
  process.stderr.write(`${failures.map((failure) => `✗ ${failure}`).join('\n')}\n`);
  process.exitCode = 1;
}

if (require.main === module) main();
