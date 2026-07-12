export const ATTACHMENT_SIGNATURE_PREFIX_BYTES = 12;

const FIXED_SIGNATURES: Readonly<Record<string, readonly number[]>> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
};

export function supportsAttachmentSignature(mime: string): boolean {
  return mime === 'image/gif' || mime === 'image/webp' || Object.hasOwn(FIXED_SIGNATURES, mime);
}

export function matchesAttachmentSignature(mime: string, prefix: Buffer): boolean {
  if (mime === 'image/gif') {
    const signature = prefix.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (mime === 'image/webp') {
    return (
      prefix.length >= 12 &&
      prefix.subarray(0, 4).equals(Buffer.from('RIFF', 'ascii')) &&
      prefix.subarray(8, 12).equals(Buffer.from('WEBP', 'ascii'))
    );
  }

  const expected = FIXED_SIGNATURES[mime];
  if (expected === undefined || prefix.length < expected.length) return false;
  return expected.every((byte, index) => prefix[index] === byte);
}
