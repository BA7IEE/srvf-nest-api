import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { StorageProvider } from '../storage/storage.interface';
import { ATTACHMENT_SIGNATURE_PREFIX_BYTES } from './attachment-signature';
import { AttachmentContentValidator } from './attachment-content-validator';

function makeProvider() {
  return {
    headObject: jest.fn().mockResolvedValue({ exists: true, size: 12 }),
    readObjectPrefix: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  };
}

describe('AttachmentContentValidator', () => {
  describe('validateFromObject', () => {
    it('对象不存在 → 13001', async () => {
      const provider = makeProvider();
      provider.headObject.mockResolvedValue({ exists: false });
      const validator = new AttachmentContentValidator(provider as unknown as StorageProvider);

      await expect(
        validator.validateFromObject({ key: 'missing', mime: 'image/jpeg', size: 12 }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(provider.readObjectPrefix).not.toHaveBeenCalled();
    });

    it('真实 size 与声明不一致 → 13013', async () => {
      const provider = makeProvider();
      provider.headObject.mockResolvedValue({ exists: true, size: 13 });
      const validator = new AttachmentContentValidator(provider as unknown as StorageProvider);

      await expect(
        validator.validateFromObject({ key: 'k', mime: 'image/jpeg', size: 12 }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED));
      expect(provider.readObjectPrefix).not.toHaveBeenCalled();
    });

    it('声明 image/jpeg 但对象前缀为文本 → 13016', async () => {
      const provider = makeProvider();
      provider.readObjectPrefix.mockResolvedValue(Buffer.from('plain text'));
      const validator = new AttachmentContentValidator(provider as unknown as StorageProvider);

      await expect(
        validator.validateFromObject({ key: 'k', mime: 'image/jpeg', size: 12 }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH));
      expect(provider.readObjectPrefix).toHaveBeenCalledWith(
        'k',
        ATTACHMENT_SIGNATURE_PREFIX_BYTES,
      );
    });

    it('合法 JPEG → 通过并返回同一次 headObject 结果', async () => {
      const provider = makeProvider();
      const validator = new AttachmentContentValidator(provider as unknown as StorageProvider);

      await expect(
        validator.validateFromObject({ key: 'k', mime: 'image/jpeg', size: 12 }),
      ).resolves.toEqual({ exists: true, size: 12 });
      expect(provider.headObject).toHaveBeenCalledTimes(1);
    });

    it('签名表外 Office MIME 保持既有契约，不回读前缀', async () => {
      const provider = makeProvider();
      const validator = new AttachmentContentValidator(provider as unknown as StorageProvider);

      await expect(
        validator.validateFromObject({
          key: 'k',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 12,
        }),
      ).resolves.toEqual({ exists: true, size: 12 });
      expect(provider.readObjectPrefix).not.toHaveBeenCalled();
    });
  });

  describe('validateFromBuffer', () => {
    it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml'])(
      '%s 永久 blocklist → 13033',
      (mime) => {
        const validator = new AttachmentContentValidator(
          makeProvider() as unknown as StorageProvider,
        );

        expect(() => validator.validateFromBuffer({ mime, buffer: Buffer.from('x') })).toThrow(
          new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED),
        );
      },
    );

    it('伪装 JPEG 字节 → 13016', () => {
      const validator = new AttachmentContentValidator(
        makeProvider() as unknown as StorageProvider,
      );

      expect(() =>
        validator.validateFromBuffer({ mime: 'image/jpeg', buffer: Buffer.from('plain text') }),
      ).toThrow(new BizException(BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH));
    });

    it.each([
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ])('合法 %s 字节 → 通过', (mime, buffer) => {
      const validator = new AttachmentContentValidator(
        makeProvider() as unknown as StorageProvider,
      );

      expect(() => validator.validateFromBuffer({ mime, buffer })).not.toThrow();
    });
  });
});
