import type { Config } from 'jest';

// E2E 专用 Jest 配置。与 src/ 默认 jest 无关(项目目前不做单元测试)。
// rootDir 指向项目根,便于 ts-jest 解析 src/ 与 test/ 的相对路径。
//
// 串行执行:--runInBand 由 package.json 脚本传入;此处 maxWorkers=1 是双保险,
// 避免后续 14.2 引入测试库后多 spec 共享同一物理库相互踩。
const config: Config = {
  rootDir: '..',
  testRegex: '.*\\.e2e-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/test/tsconfig.test.json',
      },
    ],
  },
  testEnvironment: 'node',
  maxWorkers: 1,
  testTimeout: 30000,
  // 刻意不开启 forceExit:它会掩盖未关闭的连接 / timer / socket。
  // detectOpenHandles 会让 Jest 在所有句柄关闭后才退出,并在卡住时打印泄漏源,
  // 倒逼 spec 在 afterAll 里调用 app.close()(进而触发 PrismaService.onModuleDestroy)。
  detectOpenHandles: true,
  // globalSetup:整个 run 启动一次,负责 load .env.test → 断言 app_test → 建库 → migrate deploy。
  // setupFiles:每个 worker 入口跑一次,在 spec 模块加载前再 load 一遍 .env.test
  // (Jest 30 的 globalSetup 不向 worker 透传 process.env)。
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
};

export default config;
