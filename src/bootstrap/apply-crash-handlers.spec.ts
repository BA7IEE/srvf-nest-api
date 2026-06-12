import { EventEmitter } from 'node:events';
import { applyCrashHandlers } from './apply-crash-handlers';

// G2 进程级崩溃兜底单元测试(goal「会议延期窗口·无等待工作一次收清」)。
// 不在 jest 进程上注册真实 handler:proc 注入 EventEmitter + exit mock,
// 通过 emit 模拟 Node 触发崩溃事件,黑盒断言"记日志 → 崩溃语义保持"。

class FakeProc extends EventEmitter {
  exit = jest.fn();
}

function setup() {
  const logger = { error: jest.fn(), fatal: jest.fn() };
  const proc = new FakeProc();
  applyCrashHandlers(logger, proc);
  return { logger, proc };
}

describe('applyCrashHandlers', () => {
  it('两个崩溃事件各注册恰好 1 个 listener,不触碰 SIGTERM/SIGINT', () => {
    const { proc } = setup();
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  describe('uncaughtException', () => {
    it('记 fatal(含 err + origin 完整上下文)后 exit(1)', () => {
      const { logger, proc } = setup();
      const err = new Error('boom');

      proc.emit('uncaughtException', err, 'uncaughtException');

      expect(logger.fatal).toHaveBeenCalledTimes(1);
      expect(logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ err, origin: 'uncaughtException' }),
      );
      expect(proc.exit).toHaveBeenCalledTimes(1);
      expect(proc.exit).toHaveBeenCalledWith(1);
    });

    it('先记日志后 exit(顺序锁定,日志不被退出吞掉)', () => {
      const { logger, proc } = setup();
      const order: string[] = [];
      logger.fatal.mockImplementation(() => order.push('fatal'));
      proc.exit.mockImplementation(() => {
        order.push('exit');
        return undefined as never;
      });

      proc.emit('uncaughtException', new Error('boom'), 'uncaughtException');

      expect(order).toEqual(['fatal', 'exit']);
    });
  });

  describe('unhandledRejection', () => {
    it('记 error(含 err 上下文)后 re-throw 同一 reason,保持默认崩溃语义', () => {
      const { logger, proc } = setup();
      const reason = new Error('rejected');

      // EventEmitter.emit 同步调用 listener,listener 内 re-throw 会从 emit 抛出 —
      // 等价于生产环境下升级为 uncaughtException 的崩溃路径。
      expect(() => proc.emit('unhandledRejection', reason)).toThrow(reason);

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: reason }));
      // 本 handler 自身不 exit:退出统一走 uncaughtException 单一出口。
      expect(proc.exit).not.toHaveBeenCalled();
    });

    it('非 Error reason(任意值 rejection)同样记日志并原样 re-throw', () => {
      const { logger, proc } = setup();

      let thrown: unknown;
      try {
        proc.emit('unhandledRejection', 'plain-string-reason');
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBe('plain-string-reason');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'plain-string-reason' }),
      );
    });
  });
});
