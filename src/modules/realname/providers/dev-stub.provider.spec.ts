import { DevStubRealnameProvider } from './dev-stub.provider';

// 招新一期 · 实名核验通道 T2:DevStub Provider 单测(评审稿 E-R-6)
// 确定性两路:身份证号校验位(第 18 位)偶(含 'X')→ matched;奇 → mismatch。

describe('DevStubRealnameProvider', () => {
  const provider = new DevStubRealnameProvider();

  it('校验位为偶(末位 2)→ matched', async () => {
    // 一个末位为偶数的 18 位号(仅用于 DevStub 确定性判定,非真实有效号)
    const res = await provider.verify({ name: '张三', idCardNumber: '110101199003070012' });
    expect(res.matched).toBe(true);
  });

  it('校验位为奇(末位 3)→ mismatch(带 reason)', async () => {
    const res = await provider.verify({ name: '李四', idCardNumber: '110101199003070013' });
    expect(res.matched).toBe(false);
    expect(res.reason).toBeDefined();
  });

  it("校验位为 'X'(=10,偶)→ matched", async () => {
    const res = await provider.verify({ name: '王五', idCardNumber: '11010119900307001X' });
    expect(res.matched).toBe(true);
  });

  it('确定性:同一号多次调用结果稳定', async () => {
    const input = { name: '赵六', idCardNumber: '110101199003070024' };
    const a = await provider.verify(input);
    const b = await provider.verify(input);
    expect(a.matched).toBe(b.matched);
    expect(a.matched).toBe(true); // 末位 4 = 偶
  });
});
