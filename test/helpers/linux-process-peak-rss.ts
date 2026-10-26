/** Linux VmHWM describes this executable, unlike getrusage's inherited high-water mark. */
export function linuxProcessPeakRssBytes(status: string): number {
  const matches = [...status.matchAll(/^VmHWM:[ \t]+([0-9]+)[ \t]+kB[ \t]*$/gm)];
  if (matches.length !== 1) throw new Error('Invalid Linux process peak RSS');
  const bytes = Number(matches[0][1]) * 1024;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid Linux process peak RSS');
  return bytes;
}
