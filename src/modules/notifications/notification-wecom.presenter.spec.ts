import {
  WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
  WECOM_TEXTCARD_TITLE_MAX_CHARS,
  WECOM_TEXTCARD_URL_MAX_BYTES,
  WecomDeepLinkUnavailableError,
  WecomMessagePresenter,
} from './notification-wecom.presenter';

// T5B 企业微信 textcard 呈现单测(冻结稿 §10.6 / D-WC-20 / §14.1「message presenter」行)。
//
// 本文件只测**纯函数**:presenter 零构造依赖、不碰 Prisma,所以这里直接 `new`,
// 不需要 Nest DI、不需要 mock、不需要数据库。

const HTTPS_ORIGIN = 'https://srvf.example.org';
const NOTIFICATION_ID = 'cm00000000000000000000001';

function notification(overrides: Partial<{ id: string; title: string; body: string }> = {}) {
  return { id: NOTIFICATION_ID, title: '标题', body: '正文', ...overrides };
}

// 按**码点**数长度(不是 UTF-16 code unit)—— 判据必须和被测代码用同一把尺子,
// 否则 emoji 用例会因为 `.length` 数成 2 而误判。
const codePoints = (value: string): number => [...value].length;

describe('WecomMessagePresenter', () => {
  const presenter = new WecomMessagePresenter();

  describe('title', () => {
    it('短标题原样保留', () => {
      const card = presenter.present(notification({ title: '周六救援演练通知' }), HTTPS_ORIGIN);
      expect(card.title).toBe('周六救援演练通知');
    });

    it('超长标题按码点裁剪到 128 且带省略号', () => {
      const card = presenter.present(notification({ title: '标'.repeat(200) }), HTTPS_ORIGIN);
      expect(codePoints(card.title)).toBe(WECOM_TEXTCARD_TITLE_MAX_CHARS);
      expect(card.title.endsWith('…')).toBe(true);
    });

    // 增补平面字符(emoji)的 `.length` 是 2 —— 若实现按 `.length` 裁剪,
    // 128 个 emoji 会被砍成 64 个,而且可能从代理对中间切开产生乱码。
    it('emoji 按码点计数,不被 UTF-16 代理对腰斩,也不切出半个字符', () => {
      const card = presenter.present(notification({ title: '🚑'.repeat(200) }), HTTPS_ORIGIN);
      expect(codePoints(card.title)).toBe(WECOM_TEXTCARD_TITLE_MAX_CHARS);
      expect(card.title).not.toContain('�');
      // 裁剪结果里除末尾省略号外全是完整 emoji。
      expect([...card.title].slice(0, -1).every((ch) => ch === '🚑')).toBe(true);
    });

    // 标题是纯文本字段:转义了反而会让 `&` 显示成字面 `&amp;`。
    it('标题不做 HTML 转义(企业微信 title 是纯文本字段)', () => {
      const card = presenter.present(notification({ title: '甲 & 乙' }), HTTPS_ORIGIN);
      expect(card.title).toBe('甲 & 乙');
    });

    it('控制字符被剔除,换行归一为空格', () => {
      const card = presenter.present(notification({ title: 'AB\nC' }), HTTPS_ORIGIN);
      expect(card.title).toBe('AB C');
    });
  });

  describe('description', () => {
    it('正文中的 HTML 被整体转义,绝不透传', () => {
      const card = presenter.present(
        notification({ body: '<script>alert(1)</script><div class="x">y</div>' }),
        HTTPS_ORIGIN,
      );
      expect(card.description).toContain('&lt;script&gt;');
      // 关键判据:转义之后正文里不可能再残留任何可被渲染的标签开头。
      expect(card.description).not.toContain('<script');
      expect(card.description).not.toContain('<div');
    });

    it('正文自带的 <br> 同样被转义,只有 Presenter 生成的换行才是真 <br>', () => {
      const card = presenter.present(
        notification({ body: '第一行<br>仍是第一行\n第二行' }),
        HTTPS_ORIGIN,
      );
      expect(card.description).toBe('第一行&lt;br&gt;仍是第一行<br>第二行');
      // 真 <br> 恰好一个(来自 \n),伪 <br> 零个。
      expect(card.description.match(/<br>/g)).toHaveLength(1);
    });

    it('单引号转成 &#x27; 而不是 &apos;(后者不是 HTML4 实体)', () => {
      const card = presenter.present(notification({ body: `it's` }), HTTPS_ORIGIN);
      expect(card.description).toBe('it&#x27;s');
      expect(card.description).not.toContain('&apos;');
    });

    // 裁剪必须作用在**最终字节串**(含 &amp; 这类展开)上:按纯文本数 512 个 `&`
    // 发出去会是 2560 个字符,被上游截断成半个实体。
    it('裁剪判据作用在转义后的最终串上,而不是转义前的纯文本', () => {
      const card = presenter.present(notification({ body: '&'.repeat(600) }), HTTPS_ORIGIN);
      expect(codePoints(card.description)).toBeLessThanOrEqual(
        WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
      );
      // 末尾不能是被切断的半个实体。
      expect(card.description.endsWith('…')).toBe(true);
      expect(/&(?!amp;)/.test(card.description.replace(/&amp;/g, ''))).toBe(false);
    });

    it('含 <br> 展开时仍不超 512 码点', () => {
      const card = presenter.present(notification({ body: 'ab\n'.repeat(400) }), HTTPS_ORIGIN);
      expect(codePoints(card.description)).toBeLessThanOrEqual(
        WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
      );
    });

    it('恰好 512 码点的正文不加省略号', () => {
      const card = presenter.present(notification({ body: 'x'.repeat(512) }), HTTPS_ORIGIN);
      expect(card.description).toBe('x'.repeat(512));
      expect(card.description.endsWith('…')).toBe(false);
    });
  });

  describe('深链', () => {
    it('固定 path + notification id', () => {
      const card = presenter.present(notification(), HTTPS_ORIGIN);
      expect(card.url).toBe(`${HTTPS_ORIGIN}/notifications/${NOTIFICATION_ID}`);
    });

    it('只取 origin,配置里多余的 path/query 不会进深链', () => {
      const card = presenter.present(notification(), `${HTTPS_ORIGIN}/x?y=1`);
      expect(card.url).toBe(`${HTTPS_ORIGIN}/notifications/${NOTIFICATION_ID}`);
    });

    // §10.6:URL 里不放 JWT / refresh token / state / ticket / signed URL。
    // present() 除 notification 与 origin 外不接受任何入参,所以"放不进去"是**结构性**的;
    // 本用例把这条钉成可回归的判据。
    it('深链只含 origin/path/id —— 无 query、无 fragment、无凭证', () => {
      const card = presenter.present(
        notification({ title: 'token=abc', body: 'state=xyz&ticket=t' }),
        HTTPS_ORIGIN,
      );
      const url = new URL(card.url);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect([...url.searchParams.keys()]).toEqual([]);
    });

    it.each([
      ['null', null],
      ['空串', ''],
      ['http(非 https)', 'http://srvf.example.org'],
      ['不是 URL', 'srvf.example.org'],
    ])('%s 的 webBaseUrl 一律拒(fail-closed)', (_label, value) => {
      expect(() => presenter.present(notification(), value)).toThrow(WecomDeepLinkUnavailableError);
    });

    it('深链超过 2048 字节被拒', () => {
      const longOrigin = `https://${'a'.repeat(WECOM_TEXTCARD_URL_MAX_BYTES)}.example.org`;
      expect(() => presenter.present(notification(), longOrigin)).toThrow(
        WecomDeepLinkUnavailableError,
      );
    });
  });

  // 企业微信 1800 秒重复检查是**按内容判重**的;呈现只要带一丝不确定性,
  // 第二层保险就会静默失效(每次内容都不同 = 永远判不出重复)。
  it('确定性:同一入参恒产出同一字节串', () => {
    const input = notification({ title: '标题 & <b>', body: '正文\n第二行 & <i>' });
    const first = presenter.present(input, HTTPS_ORIGIN);
    const second = presenter.present(input, HTTPS_ORIGIN);
    expect(first).toEqual(second);
  });
});
