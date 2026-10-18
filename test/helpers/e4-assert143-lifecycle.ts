/** Test-owned deadline. Reserve cleanup time inside the original Jest budget. */
export class E4AssertionCaseOwner {
  private failed = false;
  private pending = 0;
  private cleanupUnknown = false;
  private deadline?: number;

  constructor(private readonly cancel: () => Promise<void>) {}

  assertSettled() {
    if (this.pending !== 0 || this.cleanupUnknown)
      throw new Error('E4 assertion work or cancellation cleanup unknown');
  }

  remainingMs() {
    const remaining = Math.floor((this.deadline ?? 0) - performance.now() - 3_000);
    if (remaining < 1) throw new Error('E4 assertion case execution deadline exceeded');
    return remaining;
  }

  private async bounded(work: Promise<unknown>, timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('E4 assertion cleanup deadline')), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async run(work: () => Promise<void>, budgetMs: number) {
    if (this.failed) throw new Error('E4 assertion prior case failed; further work refused');
    if (!Number.isInteger(budgetMs) || budgetMs < 5_000)
      throw new Error('E4 assertion case budget invalid');
    this.pending++;
    this.deadline = performance.now() + budgetMs;
    const operation = Promise.resolve()
      .then(work)
      .finally(() => this.pending--);
    void operation.catch(() => undefined);
    let cancellation: Promise<void> | undefined;
    const cancelAndDrain = () =>
      (cancellation ??= (async () => {
        try {
          await this.bounded(Promise.resolve().then(this.cancel), 1_000);
          await this.bounded(
            operation.catch(() => undefined),
            1_000,
          );
        } catch {
          this.cleanupUnknown = true;
          throw new Error('E4 assertion cancellation or settlement unknown');
        }
      })());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.failed = true;
        void cancelAndDrain().then(
          () => reject(new Error('E4 assertion case deadline; owned work cancelled and settled')),
          reject,
        );
      }, budgetMs - 3_000);
    });
    try {
      await Promise.race([operation, deadline]);
      // An operation finishing during cancellation must not turn a timeout green.
      if (cancellation) {
        await cancellation;
        throw new Error('E4 assertion case deadline exceeded');
      }
    } catch (error) {
      this.failed = true;
      // Includes synchronous migration failures, before the JS timer can run.
      try {
        await cancelAndDrain();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'E4 assertion failure; cleanup unknown');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exact previous per-table JSONB canonicalization, in the caller's table order. */
export function e4FullRowSnapshotSql(schema: string, tables: readonly string[]) {
  if (!tables.length || new Set(tables).size !== tables.length)
    throw new Error('E4 assertion snapshot table set invalid');
  const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  return (
    'SELECT snapshot FROM (' +
    tables
      .map(
        (name, index) =>
          `SELECT ${index} AS position,coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text COLLATE "C"),'[]'::jsonb)::text AS snapshot FROM ` +
          identifier(schema) +
          '.' +
          identifier(name) +
          ' row',
      )
      .join(' UNION ALL ') +
    ') snapshots ORDER BY position'
  );
}
