import { matchesAttachmentSignature, supportsAttachmentSignature } from './attachment-signature';

describe('attachment signature validation', () => {
  it.each([
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['image/gif', Buffer.from('GIF89a', 'ascii')],
    ['application/pdf', Buffer.from('%PDF-1.7', 'ascii')],
    ['image/webp', Buffer.from('524946460400000057454250', 'hex')],
  ])('%s 的合法签名通过', (mime, prefix) => {
    expect(supportsAttachmentSignature(mime)).toBe(true);
    expect(matchesAttachmentSignature(mime, prefix)).toBe(true);
  });

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])(
    '%s 声明与文本字节不符时拒绝',
    (mime) => {
      expect(matchesAttachmentSignature(mime, Buffer.from('plain text', 'utf8'))).toBe(false);
    },
  );

  it('未纳入签名表的 MIME 不误判为受支持', () => {
    expect(
      supportsAttachmentSignature(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(false);
  });
});
