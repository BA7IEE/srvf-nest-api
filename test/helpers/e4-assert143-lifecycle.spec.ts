import { E4AssertionCaseOwner } from './e4-assert143-lifecycle';

describe('E4 assertion case ownership', () => {
  afterEach(() => jest.useRealTimers());

  it('finishes normally without cancellation', async () => {
    const cancel = jest.fn();
    const owner = new E4AssertionCaseOwner(cancel);
    await owner.run(() => Promise.resolve(), 30_000);
    owner.assertSettled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels and settles owned work before allowing the failed case to return', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const cancel = jest.fn(async () => finish());
    const owner = new E4AssertionCaseOwner(cancel);
    const result = owner.run(() => pending, 30_000);
    const rejected = expect(result).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(27_000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    owner.assertSettled();
    const later = jest.fn();
    await expect(owner.run(later, 30_000)).rejects.toThrow('further work refused');
    expect(later).not.toHaveBeenCalled();
  });

  it('does not call an unsettled cancellation clean or permit later work', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const owner = new E4AssertionCaseOwner(async () => undefined);
    const rejected = expect(owner.run(() => pending, 30_000)).rejects.toThrow('unknown');
    await jest.advanceTimersByTimeAsync(29_000);
    await rejected;
    expect(() => owner.assertSettled()).toThrow('cleanup unknown');
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(() => owner.assertSettled()).toThrow('cleanup unknown');
  });

  it('preserves a primary assertion failure and refuses the next case', async () => {
    const primary = new Error('primary assertion');
    const owner = new E4AssertionCaseOwner(async () => undefined);
    await expect(owner.run(() => Promise.reject(primary), 120_000)).rejects.toBe(primary);
    owner.assertSettled();
    await expect(owner.run(async () => undefined, 30_000)).rejects.toThrow('prior case failed');
  });

  it('cancels on a synchronous work failure before the deadline timer runs', async () => {
    const cancel = jest.fn(async () => undefined);
    const owner = new E4AssertionCaseOwner(cancel);
    const failure = new Error('synchronous CLI timeout');
    await expect(
      owner.run(() => {
        throw failure;
      }, 30_000),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1);
    owner.assertSettled();
  });

  it('bounds a cancellation that never returns and keeps finalization blocked', async () => {
    jest.useFakeTimers();
    const owner = new E4AssertionCaseOwner(() => new Promise(() => undefined));
    const rejected = expect(
      owner.run(() => Promise.reject(new Error('failure')), 30_000),
    ).rejects.toThrow('cleanup unknown');
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(() => owner.assertSettled()).toThrow('cleanup unknown');
  });
});
