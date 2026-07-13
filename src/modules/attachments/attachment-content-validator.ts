import { Inject, Injectable } from '@nestjs/common';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import type { HeadObjectResult } from '../storage/storage.types';
import {
  ATTACHMENT_SIGNATURE_PREFIX_BYTES,
  matchesAttachmentSignature,
  supportsAttachmentSignature,
} from './attachment-signature';
import { isMimeBlocked } from './attachment-validation';

export interface ValidateAttachmentObjectInput {
  key: string;
  mime: string;
  size: number;
}

export interface ValidateAttachmentBufferInput {
  mime: string;
  buffer: Buffer;
}

/**
 * 文件内容验证的单一入口。
 *
 * - 已上传对象：确认对象存在、实际大小与声明一致，并回读固定前缀核对签名。
 * - multipart buffer：直接核对固定前缀签名。
 * - 两条路径都执行永久 MIME blocklist；签名表只复用 attachment-signature.ts。
 */
@Injectable()
export class AttachmentContentValidator {
  constructor(@Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider) {}

  async validateFromObject(input: ValidateAttachmentObjectInput): Promise<HeadObjectResult> {
    const head = await this.provider.headObject(input.key);
    if (!head.exists) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    if (head.size !== undefined && head.size !== input.size) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }

    this.assertMimeNotBlocked(input.mime);
    if (!supportsAttachmentSignature(input.mime)) return head;

    const prefix = await this.provider.readObjectPrefix(
      input.key,
      ATTACHMENT_SIGNATURE_PREFIX_BYTES,
    );
    this.assertSignatureMatches(input.mime, prefix);
    return head;
  }

  validateFromBuffer(input: ValidateAttachmentBufferInput): void {
    this.assertMimeNotBlocked(input.mime);
    if (!supportsAttachmentSignature(input.mime)) return;

    this.assertSignatureMatches(
      input.mime,
      input.buffer.subarray(0, ATTACHMENT_SIGNATURE_PREFIX_BYTES),
    );
  }

  private assertMimeNotBlocked(mime: string): void {
    if (isMimeBlocked(mime)) {
      throw new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
    }
  }

  private assertSignatureMatches(mime: string, prefix: Buffer): void {
    if (!matchesAttachmentSignature(mime, prefix)) {
      throw new BizException(BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
    }
  }
}
