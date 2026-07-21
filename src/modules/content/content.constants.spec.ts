import { extractAttachmentPlaceholderIds, rewriteBody } from './content.constants';

describe('Content attachment placeholders', () => {
  it('extracts the same ids the read-side rewrite can resolve and de-duplicates them', () => {
    const body = [
      '![first](attachment:cuidimage1)',
      'repeat attachment:cuidimage1',
      'file-like attachment:cuidfile2',
      'not-a-placeholder attachment:bad-id',
    ].join('\n');

    expect(extractAttachmentPlaceholderIds(body)).toEqual(['cuidimage1', 'cuidfile2', 'bad']);
    expect(
      rewriteBody(
        body,
        new Map([
          ['cuidimage1', 'https://signed/image'],
          ['cuidfile2', 'https://signed/file'],
        ]),
      ),
    ).toContain('https://signed/image');
  });

  it('returns a fresh empty array and does not retain global-regex state between calls', () => {
    expect(extractAttachmentPlaceholderIds('attachment:first')).toEqual(['first']);
    expect(extractAttachmentPlaceholderIds('plain body')).toEqual([]);
    expect(extractAttachmentPlaceholderIds('attachment:second')).toEqual(['second']);
  });
});
