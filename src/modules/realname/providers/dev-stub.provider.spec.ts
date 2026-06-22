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

  it('确定性:同一图多次调用结果稳定', async () => {
    const i = input({ name: '李四', idCardNumber: '110101199003070046', clarity: true });
    const a = await provider.recognize(i);
    const b = await provider.recognize(i);
    expect(a).toEqual(b);
    expect(a.recognized).toBe(true);
  });
});
