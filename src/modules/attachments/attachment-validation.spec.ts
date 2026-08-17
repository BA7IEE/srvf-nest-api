import { isKnownAttachmentOwnerType, isMimeBlocked } from './attachment-validation';

describe('attachment system MIME blocklist', () => {
  it('recognizes registration-upload-session as an internal attachment owner type', () => {
    expect(isKnownAttachmentOwnerType('registration-upload-session')).toBe(true);
  });

  it('recognizes registration-form-answer as the final internal-only owner type', () => {
    expect(isKnownAttachmentOwnerType('registration-form-answer')).toBe(true);
  });

  it('recognizes attendance-import-preview as the B6 parser-only internal owner type', () => {
    expect(isKnownAttachmentOwnerType('attendance-import-preview')).toBe(true);
  });

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
