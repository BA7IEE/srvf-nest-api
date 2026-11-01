import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { r5CurrentBusinessTableNames } from '../../test/helpers/r5-current-source-pins';

describe('pre155 fixture is a source-qualified historical implementation', () => {
  it('changes no non-import source tokens from the exact 63711 implementation', () => {
    const source = readFileSync(
      resolve('test/fixtures/r5-pre155/correction-application.service.ts'),
      'utf8',
    );
    const provenance = JSON.parse(
      readFileSync(resolve('test/fixtures/r5-pre155/source.json'), 'utf8'),
    ) as Record<string, string>;
    expect(provenance.sha256).toBe(
      '9b6a2db2116a7271ef34326707ecd25ffa2fb15d74fe46800eddcfff6081957d',
    );
    expect(provenance.commit).toBe('63711eb714713f208729065aaff57de2800b968a');
    const ast = ts.createSourceFile('frozen.ts', source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements
      .filter(ts.isImportDeclaration)
      .map((node) => [node.getStart(ast), node.getEnd()]);
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source,
    );
    const tokens: Array<[ts.SyntaxKind, string]> = [];
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        !imports.some(
          ([start, end]) => scanner.getTokenPos() >= start && scanner.getTokenPos() < end,
        )
      )
        tokens.push([token, scanner.getTokenValue() || scanner.getTokenText()]);
    }
    expect(createHash('sha256').update(JSON.stringify(tokens)).digest('hex')).toBe(
      'f022a424072a66ecefb574e69e460931f345f3f2fe47c5cc19879cc257aec96b',
    );
    expect(provenance.nonImportTokenSha256).toBe(
      'f022a424072a66ecefb574e69e460931f345f3f2fe47c5cc19879cc257aec96b',
    );
  });
  it('preserves the full historical table set, excluding only the two tables introduced by155', () => {
    const current = r5CurrentBusinessTableNames(),
      historical = r5CurrentBusinessTableNames('pre155');
    expect(current.filter((name) => !historical.includes(name))).toEqual([
      'CorrectionApprovedInputItem',
      'CorrectionWritePhase',
    ]);
    expect(historical.every((name) => current.includes(name))).toBe(true);
  });

  function finalizer(overrides: Record<string, unknown> = {}) {
    const source = readFileSync(
      resolve('test/helpers/activity-contribution-policy.fixture.ts'),
      'utf8',
    );
    const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    const install = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'installE4ValidationDatabase',
    )!;
    const hooks = install.body!.statements.filter(
      (node): node is ts.ExpressionStatement =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'afterAll',
    );
    expect(hooks).toHaveLength(1);
    const callback = (hooks[0].expression as ts.CallExpression).arguments[0];
    const order: string[] = [];
    const lifecycle = {
      drop: jest.fn((worker: number) => {
        order.push('drop:' + worker);
        return Promise.resolve();
      }),
      create: jest.fn((name: string) => {
        order.push('create:' + name);
        return Promise.resolve();
      }),
    };
    const deploy = jest.fn(() => {
      order.push('deploy-current');
      return Promise.resolve();
    });
    const scope = {
      performance,
      setupPending: 0,
      setupUnknown: false,
      boundedDeployPending: 0,
      boundedDeployUnknown: false,
      options: { boundMigrationProcesses: true },
      dedicated: false,
      lifecyclePlan: { databaseFinalizer: 'DROP' },
      baseline: true,
      historical137: false,
      initialized: true,
      temporary: undefined,
      worker: 2,
      lifecycle,
      deploy,
      deriveTestDbName: () => 'app_test_w2',
      previous: {},
      process: { env: {} },
      ...overrides,
    };
    const code = ts.transpileModule('(' + callback.getText(ast) + ')', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = runInNewContext(code, scope) as () => Promise<void>;
    return { run, order, lifecycle, deploy };
  }

  it('restores the owned CI worker as an empty current install after historical assertions', async () => {
    const harness = finalizer();
    await harness.run();
    expect(harness.order).toEqual(['drop:2', 'create:app_test_w2', 'deploy-current']);
    expect(harness.deploy).toHaveBeenCalledWith(undefined, expect.any(Number));
  });
  it.each([
    { setupUnknown: true },
    { boundedDeployPending: 1 },
    { boundedDeployUnknown: true },
    { worker: undefined },
  ])(
    'refuses reconstruction when ownership or operation terminal is unknown: %j',
    async (state) => {
      const harness = finalizer(state);
      await expect(harness.run()).rejects.toThrow();
      expect(harness.order).toEqual([]);
    },
  );
  it('keeps the dedicated normal DROP path unchanged', async () => {
    const harness = finalizer({ dedicated: true, worker: 98 });
    await harness.run();
    expect(harness.order).toEqual(['drop:98']);
    expect(harness.lifecycle.create).not.toHaveBeenCalled();
    expect(harness.deploy).not.toHaveBeenCalled();
  });
});
