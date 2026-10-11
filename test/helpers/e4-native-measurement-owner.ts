import { AsyncLocalStorage } from 'node:async_hooks';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { acquireScratchDatabaseReadLease, type ScratchReadLease } from './scratch-database-lease';

export type E4NativeMeasurementLease = ScratchReadLease;
export type E4NativeMeasurementBinding = Readonly<{
  database: string;
  owner: E4NativeMeasurementLease;
}>;
type Dependencies = {
  database(): string;
  acquire(database: string): Promise<E4NativeMeasurementLease>;
};

function assignedDatabase(): string {
  const worker = process.env.JEST_WORKER_ID;
  if (!worker || !/^[0-9]{1,2}$/u.test(worker))
    throw new Error('E4 native assigned worker missing');
  const database = deriveTestDbName();
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  assertNamedTestDatabaseScope([database]);
  return database;
}

const validations = new WeakMap<E4NativeMeasurementBinding, () => void>();
const active = new AsyncLocalStorage<E4NativeMeasurementBinding>();

/** One suite's actual owner, acquired before its business fixture and released
 * after child fixtures and native clients close. Dedicated lifecycle keeps its
 * original owner and release hook; ordinary workers acquire the same lease key
 * through a capability which has no database lifecycle operations. */
export class E4NativeMeasurementOwner {
  private binding?: E4NativeMeasurementBinding;
  private starting = false;
  private ended = false;

  constructor(
    private readonly dedicated: boolean,
    private readonly dedicatedOwner: () => E4NativeMeasurementLease | undefined,
    private readonly canonicalDatabase: string,
    private readonly dependencies: Dependencies = {
      database: assignedDatabase,
      acquire: (database) => acquireScratchDatabaseReadLease(database),
    },
  ) {}

  async start(): Promise<void> {
    if (this.starting || this.binding || this.ended)
      throw new Error('E4 native owner cannot start twice');
    this.starting = true;
    let acquired: E4NativeMeasurementLease | undefined;
    try {
      const database = this.dependencies.database();
      if (this.dedicated && database !== this.canonicalDatabase)
        throw new Error('E4 native dedicated scope differs');
      const owner = this.dedicated
        ? this.dedicatedOwner()
        : (acquired = await this.dependencies.acquire(database));
      if (!owner) throw new Error('Terminal actual original lease owner missing');
      const binding = Object.freeze({ database, owner });
      const validate = () => {
        if (this.ended || this.dependencies.database() !== database)
          throw new Error('E4 native assigned scope changed');
        owner.assertHeld();
        if (!Number.isInteger(owner.backendPid) || owner.backendPid! <= 0)
          throw new Error('E4 native owner backend unknown');
      };
      validate();
      validations.set(binding, validate);
      this.binding = binding;
    } catch (error) {
      await acquired?.release();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  current(): E4NativeMeasurementBinding {
    if (!this.binding) throw new Error('Terminal actual original lease owner missing');
    validations.get(this.binding)!();
    return this.binding;
  }

  async finish(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const binding = this.binding;
    this.binding = undefined;
    if (!binding) return;
    validations.delete(binding);
    if (!this.dedicated) await binding.owner.release();
  }
}

export function withE4NativeMeasurementBinding<T>(
  binding: E4NativeMeasurementBinding,
  work: () => T,
): T {
  const validate = validations.get(binding);
  if (!validate) throw new Error('E4 native binding not owned');
  validate();
  if (active.getStore()) throw new Error('E4 native nested measurement refused');
  return active.run(binding, work);
}

/** Default retains the frozen w98 binding. Only an owned ordinary measurement
 * may select its exactly validated current worker, across all async callbacks. */
export function e4NativeMeasurementDatabase(fallback: string): string {
  const binding = active.getStore();
  if (!binding) return fallback;
  const validate = validations.get(binding);
  if (!validate) throw new Error('E4 native binding no longer owned');
  validate();
  return binding.database;
}
