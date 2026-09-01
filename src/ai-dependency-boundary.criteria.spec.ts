/**
 * Activity OS 的 No AI core dependency 结构判据。
 *
 * 红区脚本是实际裁判；此测试是已接入 unit runner 的消费者，并用正对照验证裁判不会因
 * 扫描面或匹配逻辑失效而静默放行。它守的不是「仓库永远不得有 AI」，而是核心生产源码
 * 不得依赖 AI 模块或 Provider；将来如经单独评审引入可选 Assist，变更必须同时说明新的
 * 隔离边界。
 */
import {
  APP_MODULE,
  aiDependencyBoundarySelfCheck,
  checkAiDependencyBoundary,
} from '../scripts/check-ai-dependency-boundary';

describe('Activity OS No AI core dependency — 结构判据', () => {
  it('当前生产扫描面、核心扫描面和 AppModule 都真实参与扫描，且无越界依赖', () => {
    const report = checkAiDependencyBoundary();

    expect(aiDependencyBoundarySelfCheck(report)).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it('正对照：核心源码 import Provider 包时必须报 A1', () => {
    const report = checkAiDependencyBoundary({
      'src/modules/activities/synthetic-ai-provider.ts':
        "import OpenAI from 'openai';\nvoid OpenAI;\n",
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'A1_PROVIDER_IMPORT',
          file: 'src/modules/activities/synthetic-ai-provider.ts',
        }),
      ]),
    );
  });

  it('正对照：核心源码 import 可选 AI 模块时必须报 A2', () => {
    const report = checkAiDependencyBoundary({
      'src/modules/activities/synthetic-ai-module.ts':
        "import { AiModule } from '../ai/ai.module';\nvoid AiModule;\n",
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'A2_AI_MODULE_IMPORT',
          file: 'src/modules/activities/synthetic-ai-module.ts',
        }),
      ]),
    );
  });

  it('正对照：AppModule 注册可选 AI 模块时必须报 A3', () => {
    const report = checkAiDependencyBoundary({
      [APP_MODULE]: "import { AiModule } from './modules/ai/ai.module';\nvoid AiModule;\n",
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'A3_APP_MODULE_REGISTRATION' })]),
    );
  });

  it('正对照：声明 AI Provider 依赖时必须报 A4', () => {
    const report = checkAiDependencyBoundary(
      {},
      { dependencies: { openai: '^5.0.0' }, devDependencies: {}, optionalDependencies: {} },
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'A4_PROVIDER_DEPENDENCY', file: 'package.json' }),
      ]),
    );
  });
});
