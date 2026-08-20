import sharp from 'sharp';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  ACCOUNT_AVATAR_PROFILE,
  AttachmentImageNormalizer,
  UNIFORM_PORTRAIT_V1_PROFILE,
} from './attachment-image-normalizer';

/**
 * issue #1055 T2 —— 图片规范化层的用例。
 *
 * 夹具全部由 sharp **当场生成**,不落任何二进制文件进仓:
 * 图片夹具一旦入库就没人再看得懂它里面是什么,而「这张 fixture 到底带不带 EXIF」
 * 恰恰是本文件几乎每条用例的前提。当场生成 = 前提写在代码里、可读、可改。
 */
describe('AttachmentImageNormalizer', () => {
  const normalizer = new AttachmentImageNormalizer();

  /** 造一张指定尺寸的纯色 JPEG。 */
  const jpeg = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } } })
      .jpeg()
      .toBuffer();

  describe('uniform-portrait-v1(队员标准照)', () => {
    it('把一张 5:7 的合规原图规范成 826×1158 JPEG,并清空元数据', async () => {
      const source = await jpeg(1200, 1680); // 1200/1680 = 5:7
      const result = await normalizer.normalize(source, UNIFORM_PORTRAIT_V1_PROFILE);

      expect(result.mime).toBe('image/jpeg');
      expect(result.width).toBe(826);
      expect(result.height).toBe(1158);
      expect(result.sourceWidth).toBe(1200);
      expect(result.sourceHeight).toBe(1680);
      expect(result.sourceFormat).toBe('jpeg');
      // 「清除结果可断言」是 issue §6.2 的明文要求,不是我们自己加的戏。
      expect(result.metadataStripped).toBe(true);
    });

    it('EXIF 方向为 6 的竖拍照被判为合规;**同一对宽高去掉方向标记后就该被拒**', async () => {
      // 手机竖拍的典型形状:文件里存的是横的 1620×1158,靠 EXIF Orientation=6 告诉阅读器转 90°。
      //
      // ⚠️ 这对尺寸是**挑过的**,不是随手取的:1620 与 1158 **两种朝向下都过得了尺寸闸**
      // (两个数都 ≥826,较大的那个 ≥1158)。第一版我用的是 1158×826 —— 结果反向对照
      // 被**尺寸闸**先拦下(826 < 1158),报的是「分辨率不够」而不是「比例不对」,
      // 于是它根本没走到比例闸,证明不了任何关于方向处理的事。
      // 上层边界会遮蔽下层边界:反面样本必须让被测的那一维成为**唯一**变量。
      const rotated = await sharp({
        create: { width: 1620, height: 1158, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();

      const result = await normalizer.normalize(rotated, UNIFORM_PORTRAIT_V1_PROFILE);
      expect(result.orientationApplied).toBe(true);
      // 有效尺寸是**修正方向之后**的,不是文件里存的那对。
      expect([result.sourceWidth, result.sourceHeight]).toEqual([1158, 1620]);
      expect([result.width, result.height]).toEqual([826, 1158]);

      // 反向对照:同样的 1620×1158,只是**没有**方向标记,那它就真的是一张横图。
      // 少了这条,一个「压根不读 orientation、直接按 min/max 算比例」的错误实现
      // 也会让上面那条全绿。
      const notRotated = await jpeg(1620, 1158);
      await expect(normalizer.normalize(notRotated, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID),
      );
    });

    it('清掉来图携带的 EXIF 与 GPS', async () => {
      // libvips 把 GPS 放在 **IFD3**(sharp 的 Exif 类型只有 IFD0–IFD3,没有名为 GPS 的键)。
      const withGps = await sharp({
        create: { width: 900, height: 1260, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .withMetadata({
          exif: {
            IFD0: { Copyright: 'unit-test' },
            IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
          },
        })
        .jpeg()
        .toBuffer();

      // 先钉住前提:来图**确实**带着 GPS。否则「清干净了」可能只是因为它本来就没有 ——
      // 那样这条用例即使在一个完全不清元数据的实现上也会全绿。
      //
      // sharp 读回来的 `exif` 是**不透明 Buffer**(它不解析成字段),所以这里按结构断言:
      // 0x8825 是 TIFF 规范里的 GPS IFD 指针标签,它出现 = GPS 段真的写进去了。
      // 字节序两种都认,因为 TIFF 头可能是 II(小端)也可能是 MM(大端)。
      const sourceExif = (await sharp(withGps).metadata()).exif;
      expect(sourceExif).toBeDefined();
      const GPS_IFD_POINTER_TAG = [Buffer.from([0x88, 0x25]), Buffer.from([0x25, 0x88])];
      expect(GPS_IFD_POINTER_TAG.some((tag) => sourceExif!.includes(tag))).toBe(true);

      const result = await normalizer.normalize(withGps, UNIFORM_PORTRAIT_V1_PROFILE);
      expect(result.metadataStripped).toBe(true);

      // 输出里**一个元数据段都不该剩**,不是「GPS 被摘掉但 EXIF 还在」。
      const out = await sharp(result.buffer).metadata();
      expect(out.exif).toBeUndefined();
      expect(out.icc).toBeUndefined();
      expect(out.xmp).toBeUndefined();
    });

    it('把透明背景压成纯白,而不是默认的黑', async () => {
      const transparent = await sharp({
        create: {
          width: 826,
          height: 1158,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await normalizer.normalize(transparent, UNIFORM_PORTRAIT_V1_PROFILE);
      const { data } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
      const [r, g, b] = [data[0], data[1], data[2]];
      // JPEG 无 alpha 通道:不压平的话透明像素会被填成 **0,0,0**(实测过)。
      // 标准照要求纯白底,而且黑底会让人以为是上传坏了。
      expect(r).toBeGreaterThan(250);
      expect(g).toBeGreaterThan(250);
      expect(b).toBeGreaterThan(250);
    });

    it('低于最低尺寸拒收 —— 不做插值放大', async () => {
      const small = await jpeg(500, 700); // 比例对,但达不到 826×1158
      await expect(normalizer.normalize(small, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_TOO_SMALL),
      );
    });

    it('宽高比超出 ±1% 容差即拒收', async () => {
      // 3:4 生活照。硬裁成 5:7 极可能切掉下巴或头顶,而系统对此一无所知 —— 宁可让人重拍。
      const fourByThree = await jpeg(1200, 1600);
      await expect(normalizer.normalize(fourByThree, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID),
      );
    });

    it('容差**之内**的轻微偏差放行(证明它不是把所有非精确比例都拒了)', async () => {
      // 826/1158 = 0.71330…;造一张偏 0.5% 的:1200×1688 → 0.71090,偏差 0.34%
      const slightlyOff = await jpeg(1200, 1688);
      const result = await normalizer.normalize(slightlyOff, UNIFORM_PORTRAIT_V1_PROFILE);
      expect([result.width, result.height]).toEqual([826, 1158]);
    });

    it('裁切位置被钉死在居中,且逐字节可复现', async () => {
      // ⚠️ 这条用例的第一版用的是**纯色图**,只断言「跑两次字节相同」——
      // 变异对拍显示它抓不住 `position: 'centre' → 'attention'`(纯色图上 attention
      // 没有信号,退化成居中)。**「不随机」和「裁在哪」是两回事**,前者证明不了后者。
      //
      // 现在用一张三色带图,让两种策略必然分叉:
      //   左 420px 红 | 中 1080px 白 | 右 420px 蓝
      // 居中裁 1080×1080 只会取到中间那条 ⇒ 输出**每一个像素都是白的**。
      // 实测:centre → 白 262144/262144;attention → 混进 101376 个红像素;
      //       entropy → 白 261632(也偏了)。所以「全白」这个判据两种都抓得住。
      const width = 1920;
      const height = 1080;
      const raw = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 3;
          const [r, g, b] = x < 420 ? [255, 0, 0] : x < 1500 ? [255, 255, 255] : [0, 0, 255];
          raw[i] = r;
          raw[i + 1] = g;
          raw[i + 2] = b;
        }
      }
      const source = await sharp(raw, { raw: { width, height, channels: 3 } })
        .jpeg()
        .toBuffer();

      const result = await normalizer.normalize(source, ACCOUNT_AVATAR_PROFILE);
      expect([result.width, result.height]).toEqual([512, 512]);

      const { data } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
      // 阈值留够 JPEG 振铃的余量;真跑偏的话是整片红/蓝,不是几个边缘像素。
      let white = 0;
      for (let i = 0; i < data.length; i += 3) {
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white += 1;
      }
      expect(white).toBe(512 * 512);

      // 再叠一层:同输入两次跑出的字节完全一致。
      // 「同一张原图重传两次得到两张不同的正式肖像」不可接受。
      const again = await normalizer.normalize(source, ACCOUNT_AVATAR_PROFILE);
      expect(result.buffer.equals(again.buffer)).toBe(true);
    });
  });

  describe('拒收面', () => {
    it('多帧 / 动图拒收', async () => {
      // 手搓的最小 2 帧 GIF(1×1,两个 Image Descriptor)。用带标注的 hex 片段拼,
      // 比一个 40 元素的字节数组可读 —— 每一段是 GIF89a 规范里的哪个结构一目了然。
      // sharp 即使在 `animated: false` 下也会如实报 pages=2,所以闸拿得到这个事实。
      const GRAPHIC_CONTROL_EXT = '21f9040000000000';
      const IMAGE_DESCRIPTOR_1X1 = '2c00000000010001000';
      const LZW_ONE_PIXEL = '00202440100';
      const frame = GRAPHIC_CONTROL_EXT + IMAGE_DESCRIPTOR_1X1 + LZW_ONE_PIXEL;
      const animated = Buffer.from(
        [
          '474946383961', // 'GIF89a'
          '0100', // 宽 1
          '0100', // 高 1
          '80', // 有全局色表,2 色
          '00', // 背景色索引
          '00', // 像素宽高比
          'ffffff', // 色表[0] 白
          '000000', // 色表[1] 黑
          frame, // 第 1 帧
          frame, // 第 2 帧
          '3b', // trailer
        ].join(''),
        'hex',
      );
      expect((await sharp(animated).metadata()).pages).toBe(2); // 先钉前提

      await expect(normalizer.normalize(animated, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_ANIMATED_NOT_ALLOWED),
      );
      // 顺序也重要:多帧闸排在尺寸闸**之前**,所以这张 1×1 的图报的是「动图」不是「太小」。
      // 反过来的话,用户拿到的会是一句完全误导的「分辨率不够」。
    });

    it('解不开的文件拒收', async () => {
      // 有效 JPEG 签名 + 垃圾数据:**签名表会放行它**,只有真解码才发现它不是图。
      // 这正是本层存在的理由 —— 13016(签名不符)与 13035(签名对但解不开)是两件事。
      const fakeJpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from('this is definitely not an image', 'utf8'),
      ]);
      await expect(normalizer.normalize(fakeJpeg, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_UNDECODABLE),
      );
    });

    it('解压炸弹按**像素数**拒收(文件很小)', async () => {
      const bomb = await sharp({
        create: { width: 9000, height: 9000, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      // 钉住「这确实是个炸弹」:文件不到 1 MB,却要解出 8100 万像素。
      expect(bomb.byteLength).toBeLessThan(1_000_000);

      await expect(
        normalizer.normalize(bomb, { ...UNIFORM_PORTRAIT_V1_PROFILE, maxSourcePixels: 1_000_000 }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_IMAGE_PIXELS_EXCEEDED));
    });
  });

  describe('account-avatar-v1(账号头像)', () => {
    it('任意比例都接受,居中裁成 512×512', async () => {
      const wide = await jpeg(1920, 1080);
      const result = await normalizer.normalize(wide, ACCOUNT_AVATAR_PROFILE);
      expect([result.width, result.height]).toEqual([512, 512]);
      expect(result.metadataStripped).toBe(true);
    });

    it('短边低于 512 仍然拒收(头像也不放大)', async () => {
      const tiny = await jpeg(400, 400);
      await expect(normalizer.normalize(tiny, ACCOUNT_AVATAR_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_TOO_SMALL),
      );
    });

    it('头像档**不做**比例校验 —— 与标准照档在同一张图上给出相反结论', async () => {
      // 同一张 3:4 的图:标准照档拒收(见上),头像档接受并裁成方形。
      // 两档跑同一个输入、得出相反结果,证明 fit 策略真的在分流,不是摆设。
      const threeByFour = await jpeg(1200, 1600);
      await expect(normalizer.normalize(threeByFour, UNIFORM_PORTRAIT_V1_PROFILE)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID),
      );
      const asAvatar = await normalizer.normalize(threeByFour, ACCOUNT_AVATAR_PROFILE);
      expect([asAvatar.width, asAvatar.height]).toEqual([512, 512]);
    });
  });
});
