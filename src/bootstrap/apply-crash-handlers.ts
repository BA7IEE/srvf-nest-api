import type { Logger } from 'nestjs-pino';

// 进程级崩溃路径可观测性兜底(2026-06-12 goal「会议延期窗口·无等待工作一次收清」G2)。
//
// 职责边界(与 main.ts enableShutdownHooks 注释互为犄角,勿混淆):
// - 本文件只管"进程要崩了"的两条路径:uncaughtException / unhandledRejection,
//   目标是崩溃前经 pino logger 留下完整结构化错误上下文(沿 logger-options.ts
//   redact 清单,敏感字段照常 [REDACTED]),而不是裸 stderr 堆栈。
// - 优雅关闭(SIGTERM / SIGINT → HTTP 停接 → in-flight → OnModuleDestroy)
//   仍由 NestJS enableShutdownHooks 统一控制,本文件**不**注册任何信号 handler、
//   **不**参与 shutdown 生命周期。
//
// 行为语义(只加日志,不改变崩溃结局):
// - uncaughtException:进程已处不安全态(Node 官方口径:此后继续运行不可靠),
//   记 fatal 后 exit(1) — 与 Node 默认行为(打印堆栈后退一)结局一致。
//   pino 对 fatal 级别会同步 flush 默认 destination,日志不丢。
// - unhandledRejection:Node 22 默认模式(--unhandled-rejections=throw)下会把
//   未处理 rejection 升级为 uncaughtException 后崩溃;但**一旦注册了 listener,
//   该默认升级即被取代**。这里记完日志后 re-throw,把 rejection 重新升级回
//   uncaughtException(走上面的 fatal + exit(1)),保持"默认随后崩溃"的语义
//   零漂移。代价是同一错误记两行(error + fatal),属刻意取舍:第一行带
//   rejection 原始上下文,第二行确证进程退出。
//
// 测试性:proc 参数可注入(单测传 EventEmitter + exit mock),默认 process;
// 单测见 apply-crash-handlers.spec.ts,不在 jest 进程上注册真实 handler。

type CrashLogger = Pick<Logger, 'error' | 'fatal'>;

export interface CrashHandlerHost {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (err: Error, origin: string) => void): unknown;
  exit(code: number): void;
}

export function applyCrashHandlers(logger: CrashLogger, proc: CrashHandlerHost = process): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    logger.error({
      err: reason,
      msg: 'unhandledRejection:未处理的 Promise rejection,进程即将崩溃(re-throw 升级为 uncaughtException)',
    });
    // 保持 Node 默认"随后崩溃"语义:listener 的存在会吞掉默认升级,必须 re-throw。
    throw reason;
  });

  proc.on('uncaughtException', (err: Error, origin: string) => {
    logger.fatal({
      err,
      origin,
      msg: 'uncaughtException:进程已处不安全态,记录后 exit(1)',
    });
    proc.exit(1);
  });
}
