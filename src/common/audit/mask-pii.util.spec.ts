import { maskAddress, maskIdCard, maskName, maskPhone } from './mask-pii.util';

// V2 第一阶段批次 6 audit_logs 打码工具单元测试。
// 覆盖 4 函数 × (null / undefined / 空字符串 / 标准 / 边界长度)= ~20 用例。
// D6 v1.1 §7.1 + D-C 拍板的语义铁律全部断言。

describe('mask-pii.util', () => {
  describe('maskName', () => {
    it('null → null', () => {
      expect(maskName(null)).toBeNull();
    });

    it('undefined → null', () => {
      expect(maskName(undefined)).toBeNull();
    });

    it('空字符串 → null', () => {
      expect(maskName('')).toBeNull();
    });

    it('单字符 "a" → "*" (不暴露原值)', () => {
      expect(maskName('a')).toBe('*');
    });

    it('单中文字符 "张" → "*"', () => {
      expect(maskName('张')).toBe('*');
    });

    it('两字 "张三" → "张*"', () => {
      expect(maskName('张三')).toBe('张*');
    });

    it('三字 "王五六" → "王**"', () => {
      expect(maskName('王五六')).toBe('王**');
    });

    it('四字 "欧阳静雯" → "欧***"', () => {
      expect(maskName('欧阳静雯')).toBe('欧***');
    });
  });

  describe('maskPhone', () => {
    it('null → null', () => {
      expect(maskPhone(null)).toBeNull();
    });

    it('undefined → null', () => {
      expect(maskPhone(undefined)).toBeNull();
    });

    it('空字符串 → null', () => {
      expect(maskPhone('')).toBeNull();
    });

    it('标准 11 位手机号 → 前 3 + **** + 后 4', () => {
      expect(maskPhone('13800001111')).toBe('138****1111');
    });

    it('11 位边界(全 9) → 138****1111 风格', () => {
      expect(maskPhone('99999999999')).toBe('999****9999');
    });

    it('长度 10(非 11)→ "****"', () => {
      expect(maskPhone('1380000111')).toBe('****');
    });

    it('长度 12(非 11)→ "****"', () => {
      expect(maskPhone('138000011112')).toBe('****');
    });

    it('座机或异常输入 "0755-1234" → "****"', () => {
      expect(maskPhone('0755-1234')).toBe('****');
    });
  });

  describe('maskAddress', () => {
    it('null → null', () => {
      expect(maskAddress(null)).toBeNull();
    });

    it('undefined → null', () => {
      expect(maskAddress(undefined)).toBeNull();
    });

    it('空字符串 → null', () => {
      expect(maskAddress('')).toBeNull();
    });

    it('标准长地址 "广东省深圳市福田区莲花街道..." → 前 6 字符 + 6 个 *', () => {
      expect(maskAddress('广东省深圳市福田区莲花街道彩田路')).toBe('广东省深圳市******');
    });

    it('恰 6 字符 "广东省深圳市" → "广东省深圳市******"', () => {
      expect(maskAddress('广东省深圳市')).toBe('广东省深圳市******');
    });

    it('< 6 字符 "深圳" → "深圳******"(前 N 字符 = 全部 + 6 个 *,字面执行)', () => {
      expect(maskAddress('深圳')).toBe('深圳******');
    });
  });

  describe('maskIdCard', () => {
    it('null → null', () => {
      expect(maskIdCard(null)).toBeNull();
    });

    it('undefined → null', () => {
      expect(maskIdCard(undefined)).toBeNull();
    });

    it('空字符串 → null', () => {
      expect(maskIdCard('')).toBeNull();
    });

    it('18 位身份证 → 前 6 + ******** + 后 4', () => {
      expect(maskIdCard('110101199001011234')).toBe('110101********1234');
    });

    it('15 位身份证 → 前 6 + ***** + 后 4', () => {
      // 注:D6 v1.1 §7.1 例值 "110101900101123" 后 4 实际是 "1123";
      //   评审稿 expected "110101*****1234" 与 fixture 不自洽(原文笔误)。
      //   此处用 "110101900101234"(后 4 = 1234)落地"前 6 + 5 个 * + 后 4"语义。
      expect(maskIdCard('110101900101234')).toBe('110101*****1234');
    });

    it('长度 17(非 15/18)→ "****"', () => {
      expect(maskIdCard('11010119900101123')).toBe('****');
    });

    it('长度 19(非 15/18)→ "****"', () => {
      expect(maskIdCard('1101011990010112345')).toBe('****');
    });

    it('字母乱码 "abcdef" → "****"', () => {
      expect(maskIdCard('abcdef')).toBe('****');
    });
  });
});
