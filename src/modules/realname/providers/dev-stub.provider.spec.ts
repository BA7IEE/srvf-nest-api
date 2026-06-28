import { DevStubRealnameProvider } from './dev-stub.provider';
import type { RealnameOcrInput } from '../realname.types';

// 招新实名环节 OCR 改造 · DevStub OCR Provider 单测(评审稿 E-RO-9)
// 确定性 OCR 桩:把证件照 buffer 当 JSON 信封 {name,idCardNumber,warnings,clarity,documentCategory} 回显;
// 非 JSON → 兜底「清晰、无告警、空字段」;clarity:false → recognized:false。

function input(envelope: unknown, documentTypeCode = 'mainland_id'): RealnameOcrInput {
  return {
    documentTypeCode,
    image: Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)),
    mimeType: 'image/jpeg',
  };
}

describe('DevStubRealnameProvider (OCR)', () => {
  const provider = new DevStubRealnameProvider();

  it('JSON 信封回显:清晰 + 姓名/证件号 + 无告警', async () => {
    const res = await provider.recognize(
      input({ name: '张三', idCardNumber: '110101199003070038', clarity: true, warnings: [] }),
    );
    expect(res.recognized).toBe(true);
    expect(res.name).toBe('张三');
    expect(res.idCardNumber).toBe('110101199003070038');
    expect(res.warnings).toEqual([]);
  });

  it('防伪告警透传(warnings 非空)', async () => {
    const res = await provider.recognize(
      input({ name: '张三', idCardNumber: '110101199003070038', warnings: ['PS'] }),
    );
    expect(res.recognized).toBe(true);
    expect(res.warnings).toEqual(['PS']);
  });

  it('clarity:false → recognized:false(证件照不清晰)', async () => {
    const res = await provider.recognize(input({ clarity: false }));
    expect(res.recognized).toBe(false);
    expect(res.name).toBeNull();
    expect(res.idCardNumber).toBeNull();
    expect(res.reason).toBeDefined();
  });

  it('回乡证类别透传(documentCategory)', async () => {
    const res = await provider.recognize(
      input(
        { name: '陈某', idCardNumber: 'H1234567', documentCategory: '往来港澳通行证' },
        'hk_macau_permit',
      ),
    );
    expect(res.documentCategory).toBe('往来港澳通行证');
  });

  it('非 JSON 图 → 兜底确定性结果(清晰、无字段、无告警)', async () => {
    const res = await provider.recognize(input('not-json-bytes'));
    expect(res.recognized).toBe(true);
    expect(res.name).toBeNull();
    expect(res.idCardNumber).toBeNull();
    expect(res.warnings).toEqual([]);
  });

  it('鉴伪版充分利用:扩展字段/证件类型/cardWarnings/裁剪图 base64 如实透传', async () => {
    const res = await provider.recognize(
      input({
        name: '张三',
        idCardNumber: '110101199003070038',
        clarity: true,
        documentType: '中华人民共和国居民身份证',
        extendedFields: {
          sex: { content: '男', reflect: false, incomplete: false },
          nation: { content: '汉', reflect: false, incomplete: false },
          birth: { content: '1990/3/7', reflect: false, incomplete: false },
          address: { content: '北京市朝阳区某街道', reflect: false, incomplete: false },
          authority: { content: '北京市公安局朝阳分局', reflect: false, incomplete: false },
          validDate: { content: '2010.07.21-2020.07.21', reflect: false, incomplete: false },
        },
        cardWarnings: {
          copy: false,
          reshoot: false,
          ps: false,
          border: true,
          occlusion: false,
          blur: false,
        },
        cardImageBase64: 'card-crop-b64',
        portraitImageBase64: 'portrait-crop-b64',
      }),
    );
    expect(res.documentType).toBe('中华人民共和国居民身份证');
    expect(res.extendedFields?.address?.content).toBe('北京市朝阳区某街道');
    expect(res.cardWarnings?.border).toBe(true);
    expect(res.cardImageBase64).toBe('card-crop-b64');
    expect(res.portraitImageBase64).toBe('portrait-crop-b64');
  });

  it('缺省扩展字段 → 全 null(降级,沿既有简单信封)', async () => {
    const res = await provider.recognize(
      input({ name: '张三', idCardNumber: '110101199003070038', clarity: true }),
    );
    expect(res.documentType).toBeNull();
    expect(res.extendedFields).toBeNull();
    expect(res.cardImageBase64).toBeNull();
  });

  it('确定性:同一图多次调用结果稳定', async () => {
    const i = input({ name: '李四', idCardNumber: '110101199003070046', clarity: true });
    const a = await provider.recognize(i);
    const b = await provider.recognize(i);
    expect(a).toEqual(b);
    expect(a.recognized).toBe(true);
  });
});
