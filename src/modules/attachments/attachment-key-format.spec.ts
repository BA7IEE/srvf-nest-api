import { buildDerivedAttachmentKeyRegex, isDerivedAttachmentKey } from './attachment-key-format';

// F2(#399):派生 key 格式校验单测。
// 与 generateAttachmentKey 产物的一致性:这里用与之同构的样例;e2e 另有「upload-url 返回的 key
// 通过 create 校验」的端到端交叉验证守生成器/校验器不漂移。
describe('attachment-key-format', () => {
  const ENV = 'test';

  // 模拟 generateAttachmentKey:attachments/<env>/<yyyy>/<mm>/<dd>/<base64url16><ext>
  const derived = (env = ENV, rand = 'Ab1_cD2-eF3gH4iJ', ext = '.jpg') =>
    `attachments/${env}/2026/05/15/${rand}${ext}`;

  describe('接受合规派生 key', () => {
    it('标准派生 key(16 字符 base64url 随机 + .jpg)', () => {
      expect(isDerivedAttachmentKey(derived(), ENV)).toBe(true);
    });

    it.each(['.jpg', '.png', '.webp', '.gif', '.heic', '.svg', '.pdf', '.txt', '.bin'])(
      'mimeToExt 各扩展名 %s 均接受',
      (ext) => {
        expect(isDerivedAttachmentKey(derived(ENV, 'Ab1_cD2-eF3gH4iJ', ext), ENV)).toBe(true);
      },
    );

    it('随机段 >16 字符也接受(宽容下限)', () => {
      expect(isDerivedAttachmentKey(derived(ENV, 'Ab1_cD2-eF3gH4iJkLmN'), ENV)).toBe(true);
    });
  });

  describe('拒绝非法 key', () => {
    it('短任意 key(如 e2e 旧 "k1")', () => {
      expect(isDerivedAttachmentKey('k1', ENV)).toBe(false);
    });

    it('命名空间外(不以 attachments/ 开头)', () => {
      expect(isDerivedAttachmentKey('other/test/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg', ENV)).toBe(false);
    });

    it('envPrefix 不匹配当前命名空间(test 期收到 prod 段)', () => {
      expect(isDerivedAttachmentKey('attachments/prod/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg', ENV)).toBe(
        false,
      );
    });

    it('缺少 day 段(仅 yyyy/mm)', () => {
      expect(isDerivedAttachmentKey('attachments/test/2026/05/Ab1_cD2-eF3gH4iJ.jpg', ENV)).toBe(
        false,
      );
    });

    it('随机段 <16 字符', () => {
      expect(isDerivedAttachmentKey('attachments/test/2026/05/15/short.jpg', ENV)).toBe(false);
    });

    it('路径穿越(随机段含 ../)', () => {
      expect(
        isDerivedAttachmentKey('attachments/test/2026/05/15/../../../etc/passwd.jpg', ENV),
      ).toBe(false);
    });

    it('尾随多余路径段', () => {
      expect(
        isDerivedAttachmentKey('attachments/test/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg/extra', ENV),
      ).toBe(false);
    });

    it('扩展名含大写/非 alnum', () => {
      expect(isDerivedAttachmentKey('attachments/test/2026/05/15/Ab1_cD2-eF3gH4iJ.JPG', ENV)).toBe(
        false,
      );
    });

    it('空字符串', () => {
      expect(isDerivedAttachmentKey('', ENV)).toBe(false);
    });
  });

  describe('envPrefix 转义(防注入)', () => {
    it('含正则元字符的 envPrefix 被转义(. 不当通配)', () => {
      const re = buildDerivedAttachmentKeyRegex('a.b');
      // 字面 'a.b' 命中
      expect(re.test('attachments/a.b/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg')).toBe(true);
      // 'aXb'(. 若未转义会当通配)不命中
      expect(re.test('attachments/aXb/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg')).toBe(false);
    });
  });
});
