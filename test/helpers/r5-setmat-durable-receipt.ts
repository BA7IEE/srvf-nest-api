import { closeSync, fsyncSync, openSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Test evidence only. Exclusive creation plus file/directory fsync before returning. */
export function writeR5DurableReceipt(path: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return path;
}

/** Publish a complete control record atomically for the independent watchdog.
 * A hard link is exclusive: an existing final record is never overwritten.
 * Only this call's uniquely named staging file is removed. */
export function writeR5AtomicControlReceipt(path: string, value: unknown) {
  const temporary = path + '.pending-' + randomUUID();
  writeR5DurableReceipt(temporary, value);
  try {
    linkSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    unlinkSync(temporary);
  }
  return path;
}
