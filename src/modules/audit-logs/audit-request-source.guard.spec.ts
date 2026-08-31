import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(__dirname, '../../..');
const CONTROLLERS_ROOT = join(REPOSITORY_ROOT, 'src/modules');
const FORBIDDEN_RAW_HEADERS = new Set([
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-request-id',
]);

type Violation = {
  file: string;
  line: number;
  expression: string;
};

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function stringLiteralValue(node: ts.Expression | undefined): string | null {
  return node !== undefined && ts.isStringLiteral(node) ? node.text.toLowerCase() : null;
}

function isHeadersAccess(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'headers';
}

function isForbiddenHeaderName(value: string | null): boolean {
  return value !== null && FORBIDDEN_RAW_HEADERS.has(value);
}

function findForbiddenRequestHeaderReads(source: string, fileName: string): Violation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  function addViolation(node: ts.Node): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: relative(REPOSITORY_ROOT, fileName),
      line: line + 1,
      expression: node.getText(sourceFile),
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isElementAccessExpression(node) &&
      isHeadersAccess(node.expression) &&
      isForbiddenHeaderName(stringLiteralValue(node.argumentExpression))
    ) {
      addViolation(node);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'forwarded' &&
      isHeadersAccess(node.expression)
    ) {
      addViolation(node);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'get' || node.expression.name.text === 'header') &&
      isForbiddenHeaderName(stringLiteralValue(node.arguments[0]))
    ) {
      addViolation(node);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('HTTP Controller 审计来源静态门', () => {
  it('控制器不得重新解析边界已处理的原始来源请求头', () => {
    const violations = controllerFiles(CONTROLLERS_ROOT).flatMap((file) =>
      findForbiddenRequestHeaderReads(readFileSync(file, 'utf8'), file),
    );

    expect(violations).toEqual([]);
  });

  it('对 ElementAccess、PropertyAccess 与 req.get/req.header 形式均有判别力', () => {
    const probe = `
      req.headers['x-forwarded-for'];
      req.headers.forwarded;
      req.headers['x-real-ip'];
      req.headers['x-request-id'];
      req.get('x-forwarded-for');
      req.header('x-real-ip');
    `;

    expect(findForbiddenRequestHeaderReads(probe, 'probe.controller.ts')).toHaveLength(6);
  });
});
