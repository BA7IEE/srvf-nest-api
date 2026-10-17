import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const label = 'P1 parallel:pg_locks / pg_stat_activity 观测均按当前库或 pid 收敛';
const e4Files = [
  'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
  'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
] as const;

function source(file: string) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function realScannerClauses() {
  const harnessText = source('scripts/harness-guards.selftest.ts');
  const harness = ts.createSourceFile('harness.ts', harnessText, ts.ScriptTarget.Latest, true);
  const clauses: string[] = [];
  function findHarness(node: ts.Node) {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(harness) === 'check' &&
      ts.isStringLiteral(node.expression.arguments[0]) &&
      node.expression.arguments[0].text === label &&
      ts.isBlock(node.parent)
    ) {
      const start = node.parent.statements.find(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => declaration.name.getText(harness) === 'DB_SCOPED',
          ),
      );
      if (!start || start.getStart(harness) >= node.getStart(harness))
        throw new Error('P1 scanner clause unavailable');
      clauses.push(harnessText.slice(start.getStart(harness), node.end));
    }
    ts.forEachChild(node, findHarness);
  }
  findHarness(harness);
  if (clauses.length !== 1) throw new Error('P1 scanner clause is not unique');

  const replayText = source('scripts/replay-incidents.ts');
  const replay = ts.createSourceFile('replay.ts', replayText, ts.ScriptTarget.Latest, true);
  const callbacks: string[] = [];
  function findReplay(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === 'pglocks-db-scoped' &&
      ts.isArrowFunction(node.initializer)
    )
      callbacks.push(node.initializer.getText(replay));
    ts.forEachChild(node, findReplay);
  }
  findReplay(replay);
  if (callbacks.length !== 1) throw new Error('INC-08 scanner clause is not unique');
  return { p1: clauses[0], incident: '(' + callbacks[0] + ')()' };
}

const clauses = realScannerClauses();
const actualSources = Object.fromEntries(e4Files.map((file) => [file, source('test/e2e/' + file)]));

function executeScanner(kind: keyof typeof clauses, files: Record<string, string>) {
  let p1Result: boolean | undefined;
  const context = {
    ROOT: root,
    repoRoot: root,
    path,
    fs: {
      readdirSync: () => Object.keys(files),
      readFileSync: (file: string) => {
        const contents = files[path.basename(file)];
        if (contents === undefined) throw new Error('Unreviewed scanner file');
        return contents;
      },
    },
    check: (name: string, passed: boolean) => {
      if (name !== label || typeof passed !== 'boolean')
        throw new Error('Unexpected P1 scanner result');
      p1Result = passed;
    },
  };
  // Execute the real clauses with reads confined to these reviewed virtual files.
  const compiled = ts.transpileModule(clauses[kind], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.length) throw new Error('Scanner transpilation failed');
  const result: unknown = vm.runInNewContext(compiled.outputText, context, { timeout: 1000 });
  if (kind === 'p1') {
    if (p1Result === undefined) throw new Error('P1 scanner did not execute');
    return p1Result;
  }
  if (!Array.isArray(result) || typeof result[0] !== 'boolean')
    throw new Error('Unexpected INC-08 scanner result');
  return result[0];
}

const probes = [
  ['$queryRaw', 'pg_locks'],
  ['$queryRaw', 'pg_stat_activity'],
  ['Prisma.sql', 'pg_locks'],
  ['Prisma.sql', 'pg_stat_activity'],
] as const;

function executableProbe(call: string, view: string, scoped: boolean) {
  const tag = call === '$queryRaw' ? 'client.$queryRaw' : 'Prisma.sql';
  const predicate = !scoped
    ? ''
    : view === 'pg_locks'
      ? ' lock WHERE lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())'
      : ' WHERE datname = current_database()';
  const probe =
    '\nconst observation = ' + tag + '`SELECT count(*) FROM ' + view + predicate + '`;\n';
  const ast = ts.createSourceFile('probe.ts', probe, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements[0];
  if (
    !ts.isVariableStatement(declaration) ||
    !declaration.declarationList.declarations[0].initializer ||
    !ts.isTaggedTemplateExpression(declaration.declarationList.declarations[0].initializer)
  )
    throw new Error('Observation control is not an executable query expression');
  return probe;
}

describe('E4 historical inverse observation compatibility', () => {
  it('passes both real scanners with the full current E4 sources', () => {
    expect(executeScanner('p1', actualSources)).toBe(true);
    expect(executeScanner('incident', actualSources)).toBe(true);
  });

  it.each(probes)('rejects an executable unscoped %s observation of %s', (call, view) => {
    for (const file of e4Files) {
      const mutated = {
        ...actualSources,
        [file]: actualSources[file] + executableProbe(call, view, false),
      };
      expect(executeScanner('p1', mutated)).toBe(false);
      expect(executeScanner('incident', mutated)).toBe(false);
    }
  });

  it.each(probes)('accepts an executable scoped %s observation of %s', (call, view) => {
    for (const file of e4Files) {
      const mutated = {
        ...actualSources,
        [file]: actualSources[file] + executableProbe(call, view, true),
      };
      expect(executeScanner('p1', mutated)).toBe(true);
      expect(executeScanner('incident', mutated)).toBe(true);
    }
  });
});
