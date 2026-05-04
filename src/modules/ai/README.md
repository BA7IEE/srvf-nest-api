# `modules/ai/` — v1 占位

> v1 **不实现 AI 能力**。本目录仅占位,声明项目 AI 能力的未来落点。

## 当前状态

- **不注册** `AiModule`(本目录无 `ai.module.ts`)
- **不实现** 任何 Provider(无 `*.service.ts` / `*.controller.ts` / `*.dto.ts`)
- **不接入** LLM SDK(OpenAI / Anthropic / Vercel AI SDK 等)
- **不接入** 向量检索(pgvector / 其他)
- **不引入** AI 相关运行时依赖

任何 AI 在 v1 阶段看到此目录,**不要主动创建上述文件**。详见
[`ARCHITECTURE.md`](../../../ARCHITECTURE.md) §1 设计原则、§4 v1 范围
"不做(刻意砍,需要时再加)"清单。

## 何时落地

按 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) §9 升级路径:

> | 触发信号 | 该加什么 | 加在哪里 |
> |---|---|---|
> | 第一个 AI 产品启动 | 再注册 `AiModule`,填充 `modules/ai/`,接 Vercel AI SDK,加 pgvector | `src/modules/ai/` |

**判定原则:不是"觉得以后会用",而是"现在的产品需求里出现了这个明确诉求"。**

## 落地时同步检查

第一个 AI 产品启动时,按 NestJS 业务模块铁律(CLAUDE.md §2)创建 4 文件:

```
modules/ai/
├── ai.module.ts
├── ai.controller.ts
├── ai.service.ts
└── ai.dto.ts
```

并在 `app.module.ts` 显式 `imports: [AiModule]`(`DatabaseModule` 不带
`@Global`,需要 PrismaService 时一并显式 imports)。

PostgreSQL 已是 v1 选定数据库,接入 `pgvector` 扩展即可支撑向量检索,
**不需要换库**(详见 §2 技术栈选型理由)。
