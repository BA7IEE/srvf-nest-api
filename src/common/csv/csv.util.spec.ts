import { escapeCsvField } from './csv.util';

describe('escapeCsvField', () => {
  it.each(['=cmd()', '+SUM(1,2)', '-1+2', '@evil', '\tformula', '\rformula'])(
    'neutralizes spreadsheet formula prefix %p',
    (value) => {
      expect(escapeCsvField(value)).toContain(`'${value}`);
    },
  );

  it('applies RFC 4180 quoting after formula neutralization', () => {
    expect(escapeCsvField('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('formats dates and empty values deterministically', () => {
    expect(escapeCsvField(new Date('2026-07-13T00:00:00.000Z'))).toBe('2026-07-13T00:00:00.000Z');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });
});
