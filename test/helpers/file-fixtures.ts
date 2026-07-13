const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_PREFIX = Buffer.from('89504e470d0a1a0a', 'hex');

// 真实 1x1 PNG，用于 multipart 正向 e2e；不含任何 PII。
export const VALID_PNG_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export function attachmentBytesForMime(mime: string, size: number): Buffer {
  const body = Buffer.alloc(size);
  const prefix =
    mime === 'image/jpeg'
      ? JPEG_PREFIX
      : mime === 'image/png'
        ? PNG_PREFIX
        : mime === 'image/gif'
          ? Buffer.from('GIF89a', 'ascii')
          : mime === 'image/webp'
            ? Buffer.from('524946460400000057454250', 'hex')
            : mime === 'application/pdf'
              ? Buffer.from('%PDF-1.7', 'ascii')
              : Buffer.alloc(0);
  prefix.copy(body, 0, 0, Math.min(prefix.length, body.length));
  return body;
}

// DevStub OCR 的测试信封：合法 JPEG 前缀 + JSON；Provider 只从首个 `{` 开始解析信封。
export function devStubOcrImage(envelope: Record<string, unknown>): Buffer {
  return Buffer.concat([JPEG_PREFIX, Buffer.from(JSON.stringify(envelope), 'utf8')]);
}
