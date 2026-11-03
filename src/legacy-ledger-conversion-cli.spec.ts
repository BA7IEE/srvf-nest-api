import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(resolve(__dirname, '../scripts/legacy-ledger-conversion.ts'), 'utf8');
const entrypoint = source.lastIndexOf('void main().catch(');
if (entrypoint < 0) throw new Error('Legacy conversion CLI entrypoint not found');
// Invoke the real main() with inert imports. Omit only its outer catch because
// the process.exit substitute throws instead of terminating the Jest process.
const code = ts.transpileModule(source.slice(0, entrypoint) + '\nmain();', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function runCli(argv: readonly string[]) {
  const appModule = Symbol('AppModule');
  const prismaService = Symbol('PrismaService');
  const conversionService = Symbol('LegacyLedgerConversionService');
  const findUnique = jest.fn().mockResolvedValue({
    id: 'synthetic-actor',
    username: 'synthetic-operator',
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    memberId: null,
  });
  const findMany = jest
    .fn()
    .mockResolvedValue([
      { activityId: 'synthetic-candidate-1' },
      { activityId: 'synthetic-candidate-2' },
    ]);
  const convertActivity = jest.fn().mockResolvedValue({
    status: 'already-converted',
    detail: 'synthetic outcome',
  });
  const close = jest.fn().mockResolvedValue(undefined);
  const createApplicationContext = jest.fn().mockResolvedValue({
    get: (token: unknown): unknown => {
      if (token === prismaService) return { user: { findUnique }, attendanceSheet: { findMany } };
      if (token === conversionService) return { convertActivity };
      throw new Error('Unexpected synthetic provider');
    },
    close,
  });
  const error = jest.fn();
  const exit = jest.fn((status: number): never => {
    throw Object.assign(new Error('Synthetic process exit'), { status });
  });
  const completion: unknown = runInNewContext(code, {
    exports: {},
    process: { argv: ['node', 'synthetic-cli', ...argv], exit },
    console: { error, log: jest.fn() },
    require: (name: string): unknown => {
      if (name === '@nestjs/core') return { NestFactory: { createApplicationContext } };
      if (name === '../src/app.module') return { AppModule: appModule };
      if (name === '../src/database/prisma.service') return { PrismaService: prismaService };
      if (name === '../src/modules/activities/legacy-ledger-conversion.service')
        return { LegacyLedgerConversionService: conversionService };
      throw new Error(`Unexpected synthetic CLI dependency: ${name}`);
    },
  });
  return {
    completion: Promise.resolve(completion),
    createApplicationContext,
    findUnique,
    findMany,
    convertActivity,
    close,
    error,
    exit,
  };
}

describe('legacy ledger conversion CLI activity selector', () => {
  it.each([
    ['trailing flag', ['--actor-user-id', 'synthetic-actor', '--activity-id']],
    ['empty value', ['--actor-user-id', 'synthetic-actor', '--activity-id', '']],
    ['blank value', ['--actor-user-id', 'synthetic-actor', '--activity-id', ' \t ']],
    ['another flag', ['--activity-id', '--actor-user-id', 'synthetic-actor']],
    [
      'duplicate flag missing its value',
      ['--actor-user-id', 'synthetic-actor', '--activity-id', 'synthetic-target', '--activity-id'],
    ],
    [
      'missing value before a repeated selector',
      ['--actor-user-id', 'synthetic-actor', '--activity-id', '--activity-id', 'synthetic-target'],
    ],
  ])('rejects %s before application creation or database access', async (_name, argv) => {
    const cli = runCli(argv);
    await expect(cli.completion).rejects.toMatchObject({ status: 2 });
    expect(cli.exit).toHaveBeenCalledTimes(1);
    expect(cli.error).toHaveBeenCalledWith(expect.stringContaining('--activity-id'));
    expect(cli.createApplicationContext).not.toHaveBeenCalled();
    expect(cli.findUnique).not.toHaveBeenCalled();
    expect(cli.findMany).not.toHaveBeenCalled();
    expect(cli.convertActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['inline target', ['--actor-user-id', 'synthetic-actor', '--activity-id=synthetic-target']],
    ['empty inline target', ['--actor-user-id', 'synthetic-actor', '--activity-id=']],
    ['blank inline target', ['--actor-user-id', 'synthetic-actor', '--activity-id= \t ']],
    [
      'inline target after a separated target',
      [
        '--actor-user-id',
        'synthetic-actor',
        '--activity-id',
        'synthetic-separated-target',
        '--activity-id=synthetic-inline-target',
      ],
    ],
    [
      'inline target before a separated target',
      [
        '--actor-user-id',
        'synthetic-actor',
        '--activity-id=synthetic-inline-target',
        '--activity-id',
        'synthetic-separated-target',
      ],
    ],
    ['both inline options', ['--actor-user-id=synthetic-actor', '--activity-id=synthetic-target']],
  ])(
    'rejects unsupported %s before application creation or database access',
    async (_name, argv) => {
      const cli = runCli(argv);
      await expect(cli.completion).rejects.toMatchObject({ status: 2 });
      expect(cli.exit).toHaveBeenCalledTimes(1);
      expect(cli.error).toHaveBeenCalledWith(expect.stringContaining('不支持 --activity-id='));
      expect(cli.createApplicationContext).not.toHaveBeenCalled();
      expect(cli.findUnique).not.toHaveBeenCalled();
      expect(cli.findMany).not.toHaveBeenCalled();
      expect(cli.convertActivity).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['actor first', ['--actor-user-id', 'synthetic-actor', '--activity-id', 'synthetic-target']],
    ['selector first', ['--activity-id', 'synthetic-target', '--actor-user-id', 'synthetic-actor']],
  ])('converts only the selected activity with %s', async (_name, argv) => {
    const cli = runCli(argv);
    await cli.completion;
    expect(cli.findUnique).toHaveBeenCalledWith({ where: { id: 'synthetic-actor' } });
    expect(cli.findMany).not.toHaveBeenCalled();
    expect(cli.convertActivity).toHaveBeenCalledTimes(1);
    expect(cli.convertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: 'synthetic-target' }),
    );
    expect(cli.close).toHaveBeenCalledTimes(1);
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it('preserves the candidate scan when the selector is entirely omitted', async () => {
    const cli = runCli(['--actor-user-id', 'synthetic-actor']);
    await cli.completion;
    expect(cli.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, statusCode: 'approved' },
      select: { activityId: true },
      distinct: ['activityId'],
    });
    expect(cli.convertActivity).toHaveBeenCalledTimes(2);
    expect(cli.convertActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ activityId: 'synthetic-candidate-1' }),
    );
    expect(cli.convertActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ activityId: 'synthetic-candidate-2' }),
    );
    expect(cli.close).toHaveBeenCalledTimes(1);
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it('keeps the existing missing-actor rejection before application creation', async () => {
    const cli = runCli(['--activity-id', 'synthetic-target']);
    await expect(cli.completion).rejects.toMatchObject({ status: 2 });
    expect(cli.createApplicationContext).not.toHaveBeenCalled();
    expect(cli.convertActivity).not.toHaveBeenCalled();
  });
});
