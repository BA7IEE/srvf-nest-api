// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist', 'node_modules'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
      parserOptions: {
        // 让 typescript-eslint 同时识别 src / test / prisma 三处源码。
        // 使用显式 project 列表(而非 projectService),因为:
        // - test/ 由 test/tsconfig.test.json 覆盖
        // - prisma/ 单独通过 prisma/tsconfig.eslint.json 覆盖,避免污染运行时构建链路
        project: ['./tsconfig.json', './test/tsconfig.test.json', './prisma/tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  // 测试代码与 prisma seed 不属于运行时业务源码,允许更宽松的类型规则
  // (E2E 测试常见对响应体做 any 取值断言;seed.ts 是一次性脚本)。
  // 仍保留所有非类型类规则(prettier、未使用变量、await 检查等)。
  {
    files: ['test/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
