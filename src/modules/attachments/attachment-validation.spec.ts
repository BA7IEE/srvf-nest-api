import { isMimeBlocked } from './attachment-validation';

describe('attachment system MIME blocklist', () => {
  it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml'])(
    'v0.44.0 finding #24 永久拒绝 %s',
    (mime) => {
      expect(isMimeBlocked(mime)).toBe(true);
    },
  );

  it('普通受支持文档类型不被系统黑名单误伤', () => {
    expect(isMimeBlocked('application/pdf')).toBe(false);
  });
});
