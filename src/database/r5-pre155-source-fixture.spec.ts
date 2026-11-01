import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
});
