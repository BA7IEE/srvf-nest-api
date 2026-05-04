// V1.4-3:Prisma CLI 配置文件。
//
// 由 `package.json#prisma` 迁移而来。Prisma 6.x 已支持本文件;Prisma 7.x 移除
// `package.json#prisma` 配置块,提前迁移可消除 6.x 启动期 deprecation 噪声,
// 并降低未来 Prisma 7 升级 PR 的 diff(详见 docs/v1.4-prisma7-evaluation.md §6.1 / §7 PR A)。
//
// 范围承诺(V1.4-3):
//   - 仅迁移 seed 命令,与原 `package.json#prisma.seed = "tsx prisma/seed.ts"` 行为一致
//   - 不显式声明 schema 路径,保留 Prisma 默认值 `prisma/schema.prisma`,
//     避免与 prisma/schema.prisma 内的 datasource / generator 块产生重复事实源
//   - 不声明 datasource:连接信息仍由 prisma/schema.prisma 的 `datasource db` 块
//     从 env DATABASE_URL 读取(若在此处声明 datasource 会覆盖 schema 中的同名块,
//     与 V1.4-3 "不改变数据库连接逻辑" 要求不符)
//   - 不声明 studio / tables / enums / experimental,本仓库均不需要
//
// 行为对齐:Prisma CLI 检测到 prisma.config.ts 后会**关闭**自动 `.env` 加载
// (CLI 输出 "Prisma config detected, skipping environment variable loading.")。
// 为保持本地开发流程不变(开发者 `cp .env.example .env` 后直接 `pnpm prisma:migrate`
// 等命令仍能拿到 DATABASE_URL),这里显式 `import 'dotenv/config'` 还原 .env 加载。
//   - CI:无 `.env` 文件,dotenv silent-skip;DATABASE_URL 由 Actions `env:` 块注入
//   - 容器构建:无 `.env` 文件,dotenv silent-skip;`prisma generate` 不连库,
//     `prisma migrate deploy` 由部署流程显式注入 DATABASE_URL
//   - 测试:test/setup 自行加载 `.env.test`,本文件不参与
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
