import { runInNewContext } from 'node:vm';
import { linuxProcessPeakRssBytes } from './linux-process-peak-rss';

describe('Linux process peak RSS', () => {
  it('reads this executable peak independently of its current RSS', () => {
    expect(linuxProcessPeakRssBytes('Name:\tnode\nVmHWM:\t  76800 kB\nVmRSS:\t  40960 kB\n')).toBe(
      76800 * 1024,
    );
  });

  it('remains executable inside the isolated worker script', () => {
    const parse = runInNewContext(
      `(${linuxProcessPeakRssBytes.toString()})`,
    ) as typeof linuxProcessPeakRssBytes;
    expect(parse('VmHWM: 1024 kB\n')).toBe(1024 * 1024);
    expect(() => parse('VmRSS: 1024 kB\n')).toThrow('Invalid Linux process peak RSS');
  });

  it.each([
    '',
    'VmRSS: 1024 kB\n',
    'VmHWM: 0 kB\n',
    'VmHWM: -1 kB\n',
    'VmHWM: 1.5 kB\n',
    'VmHWM: 1024 MB\n',
    'VmHWM: 1 kB\nVmHWM: 2 kB\n',
    'VmHWM: 9007199254740991 kB\n',
  ])('rejects missing or untrustworthy peak measurements: %j', (status) => {
    expect(() => linuxProcessPeakRssBytes(status)).toThrow('Invalid Linux process peak RSS');
  });
});
