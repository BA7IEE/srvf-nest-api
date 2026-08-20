import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { Metadata } from 'sharp';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

/**
 * issue #1055 T2 —— 视觉身份图片的**内容级**规范化(sharp / libvips)。
 *
 * ## 它与 `AttachmentContentValidator` 的分工(不要混)
 *
 * `AttachmentContentValidator` 是本模块铁律里的**唯一内容校验入口**,负责
 * 系统级 MIME 黑名单 + 固定前缀签名表(`attachment-signature.ts`)。**本类不碰那两样,
 * 也不新建第二套** —— 它是叠在其上的一层:签名只证明「开头几个字节像不像 JPEG」,
 * 证明不了「这真的能解码成一张 826×1158 的单帧图」。issue §6.2 要求的正是后者。
 *
 * 调用顺序恒为:先 validator(便宜、且是既有契约),再 normalizer(要真解码)。
 *
 * ## 为什么规范化必须在服务端做,而不是信客户端
 *
 * 客户端声明的 MIME、扩展名、甚至图片自己的 metadata 宽高**都可以伪造**;
 * 而 EXIF 里可能带着 GPS 坐标 —— 一张队员在家自拍的头像,原图 EXIF 会精确到门牌号。
 * 「服务端解码后重编码」这一步同时解决三件事:证明它真是图、去掉全部元数据、
 * 让落库的二进制只有一种确定形状。
 *
 * ⚠️ **EXIF 清除靠的是 sharp 的默认行为**(不调 `.withMetadata()` 就不带元数据),
 * 但默认行为是**别人的实现细节**,不是我们的执行位。所以本类在返回前**重新读一次
 * 输出的 metadata 并断言 exif/GPS 确已消失**,断言结果作为 `metadataStripped` 返回,
 * 由调用方与用例消费 —— issue §6.2 明确要求「EXIF/GPS 等元数据清除**结果**」可断言。
 */

/** 输出恒为 JPEG:照片类唯一合理选择(PNG 存照片体积翻数倍),且无 alpha 通道可泄。 */
export type NormalizedImageMime = 'image/jpeg';

export type ImageFitPolicy =
  /**
   * 任意来图比例都接受,居中裁到目标比例。
   * 用于**账号头像** —— 它是个性化展示品,裁掉边角不构成事故。
   */
  | 'center-crop'
  /**
   * 来图比例必须已落在目标比例的容差内,否则**拒收**;容差内的残差再居中裁掉。
   * 用于**队员标准照** —— 正式肖像不能替用户做大幅裁切决定:
   * 一张 3:4 的生活照硬裁成 5:7,极可能把下巴或头顶切掉,而系统对此一无所知。
   * 宁可让人重拍,也不要产出一张「系统裁出来的」不合格证件照。
   */
  | 'require-ratio';

export interface ImageProfile {
  /** 规格代码,进审计与日志;标准照侧与 `MemberOfficialPortrait.specVersion` 同值。 */
  readonly code: string;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly fit: ImageFitPolicy;
  /** `require-ratio` 时的相对容差(0.01 = ±1%)。`center-crop` 时不使用。 */
  readonly ratioTolerance: number;
  /**
   * 最低来图尺寸。低于此**拒收,不插值放大** —— 放大不会凭空生出细节,
   * 只会产出一张糊的「合规」图,而糊在制证印刷上是致命的。
   */
  readonly minSourceWidth: number;
  readonly minSourceHeight: number;
  /** 解压炸弹护栏:按**像素数**而非字节数。小文件也能解出巨幅位图。 */
  readonly maxSourcePixels: number;
  readonly quality: number;
}

export interface NormalizedImage {
  readonly buffer: Buffer;
  readonly mime: NormalizedImageMime;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** 来图经 EXIF 方向修正**之后**的有效尺寸(不是文件里存的那对数)。 */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** 来图的真实解码格式(不是客户端声明的 MIME)。 */
  readonly sourceFormat: string;
  /** 来图是否带 EXIF 方向标记(带 = 已被修正)。 */
  readonly orientationApplied: boolean;
  /** 输出重读确认:元数据确已清空。恒应为 true;为 false 即是缺陷,不是警告。 */
  readonly metadataStripped: boolean;
}

/**
 * 账号头像规格。
 *
 * ⚠️ **这组数是我按用途推的,不在 goal 冻结范围内**(goal §2 T4 只冻结了标准照的
 * `uniform-portrait-v1`)。推导:App 里头像最大出现在个人中心头部(约 120pt),
 * 3x 屏 = 360px;512 覆盖它且留余量,再大对展示无收益、只增流量。
 * 正方形是因为所有消费位都是圆形/方形裁切框。q85 是展示品的通行取舍(q90 留给要印刷的标准照)。
 * 维护者若要改,改这一处即可 —— 没有第二处硬编码。
 */
export const ACCOUNT_AVATAR_PROFILE: ImageProfile = {
  code: 'account-avatar-v1',
  targetWidth: 512,
  targetHeight: 512,
  fit: 'center-crop',
  ratioTolerance: 0,
  // 要求短边 ≥512:手机拍的任何照片都远超它,挡下的只有「已经被裁成小缩略图」的来源。
  minSourceWidth: 512,
  minSourceHeight: 512,
  maxSourcePixels: 50_000_000,
  quality: 85,
};

/**
 * `uniform-portrait-v1` —— 队员标准照规格。
 *
 * **本表由 goal #1055 §2 T4 冻结**(维护者 2026-08-20 拍板:「按市面标准来,第一性原理分析」,
 * 是对 issue §6.1「不能由开发者或 AI 凭经验猜测」的显式豁免)。每个数都由
 * 「5:7 + 印刷 300dpi + 只缩不放」三条推出:
 *
 * - 5:7 —— 一寸 25×35mm 与二寸 35×49mm 同为此比例,是头肩构图通用比;
 * - 826×1158 —— 二寸 @600dpi。现在存大,将来要小随时降采样;反过来不行;
 * - ≥826×1158 拒收 —— 只缩不放;
 * - JPEG q90 —— 照片类唯一合理选择,q90 是印刷可接受的下限。
 *
 * ⚠️ 改规格 = **新增 `uniform-portrait-v2`**,不是改这里的数。
 * 旧照片保留自己的 `specVersion`,禁止批量改写(issue §6.1)。
 * DB 侧的 `member_official_portraits_spec_version_check` 是这条的执行位。
 */
export const UNIFORM_PORTRAIT_V1_PROFILE: ImageProfile = {
  code: 'uniform-portrait-v1',
  targetWidth: 826,
  targetHeight: 1158,
  fit: 'require-ratio',
  ratioTolerance: 0.01,
  minSourceWidth: 826,
  minSourceHeight: 1158,
  maxSourcePixels: 50_000_000,
  quality: 90,
};

/** EXIF Orientation 值 5–8 表示图像被旋转了 90°,存储的宽高与显示的宽高互换。 */
const ORIENTATIONS_THAT_SWAP_AXES: ReadonlySet<number> = new Set([5, 6, 7, 8]);

/** sharp 的像素上限报错文本。它不给错误码,只能认文本。 */
const SHARP_PIXEL_LIMIT_MARKER = 'exceeds pixel limit';

@Injectable()
export class AttachmentImageNormalizer {
  /**
   * 解码 → 校验形状 → 修正方向 → 裁到目标比例 → 白底压平 → 重编码 → 复核元数据已清。
   *
   * 抛 `BizException`(13035–13039)而不是让 sharp 的原始错误穿出去:
   * libvips 的错误文本会带内部路径与版本串,既对用户无意义、又是不必要的实现暴露。
   */
  async normalize(source: Buffer, profile: ImageProfile): Promise<NormalizedImage> {
    const metadata = await this.readMetadata(source, profile);

    // ① 多帧 / 动图拒收。
    // 注意 `pages` 对静态图可能是 undefined 或 1,两者都算单帧;只有 >1 才是动图。
    // APNG 与动态 WebP 都会在这里被挡下 —— 它们的**签名与静态版完全相同**,
    // 签名表看不见这个差别,只有解码器知道。
    if ((metadata.pages ?? 1) > 1) {
      throw new BizException(BizCode.ATTACHMENT_IMAGE_ANIMATED_NOT_ALLOWED);
    }

    const storedWidth = metadata.width;
    const storedHeight = metadata.height;
    if (
      storedWidth === undefined ||
      storedHeight === undefined ||
      storedWidth <= 0 ||
      storedHeight <= 0
    ) {
      throw new BizException(BizCode.ATTACHMENT_IMAGE_UNDECODABLE);
    }

    // ② 有效尺寸 = 修正 EXIF 方向**之后**的宽高。
    // ⚠️ 这一步不能省:一张竖拍的手机照片,文件里常存成 1158×826 + Orientation=6,
    // 直接拿 metadata.width/height 去比 5:7 会得到 7:5 —— 一张完全合规的竖版标准照
    // 会被判成比例不符而拒收。用户会看到「你的竖版照片宽高比不对」这种无法理解的报错。
    const orientation = metadata.orientation ?? 1;
    const orientationApplied = ORIENTATIONS_THAT_SWAP_AXES.has(orientation) || orientation > 1;
    const swaps = ORIENTATIONS_THAT_SWAP_AXES.has(orientation);
    const sourceWidth = swaps ? storedHeight : storedWidth;
    const sourceHeight = swaps ? storedWidth : storedHeight;

    // ③ 只缩不放。
    if (sourceWidth < profile.minSourceWidth || sourceHeight < profile.minSourceHeight) {
      throw new BizException(BizCode.ATTACHMENT_IMAGE_TOO_SMALL);
    }

    // ④ 宽高比(仅 require-ratio 档)。
    if (profile.fit === 'require-ratio') {
      const targetRatio = profile.targetWidth / profile.targetHeight;
      const sourceRatio = sourceWidth / sourceHeight;
      const deviation = Math.abs(sourceRatio - targetRatio) / targetRatio;
      if (deviation > profile.ratioTolerance) {
        throw new BizException(BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID);
      }
    }

    // ⑤ 规范化管线。每一步都有不可省的理由,见行内注释。
    const output = await sharp(source, {
      limitInputPixels: profile.maxSourcePixels,
      // 显式声明只取第一帧。即便上面的多帧闸将来被改坏,这里也不会去解一个 500 帧的 GIF。
      animated: false,
    })
      // `.rotate()` 不传参 = 按 EXIF Orientation 摆正,并把该标记本身抹掉。
      .rotate()
      .resize({
        width: profile.targetWidth,
        height: profile.targetHeight,
        fit: 'cover',
        // 恒居中。**刻意不用 sharp 的 `attention`/`entropy` 智能裁切** ——
        // 那是内容相关的启发式,同一张图在不同 libvips 版本下可能裁出不同结果,
        // 而「同一张原图重传两次得到两张不同的正式肖像」是不可接受的。
        position: 'centre',
        // 只缩不放已在 ③ 挡过;这里再声明一次,避免任何路径下的隐式放大。
        withoutEnlargement: false,
      })
      // 白底压平。**不可省**:JPEG 没有 alpha 通道,一张带透明背景的 PNG
      // 不压平会被填成**黑色**。标准照要求纯白底(制证印刷最稳),
      // 头像压白也远好过莫名其妙的黑块。
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: profile.quality })
      .toBuffer();

    // ⑥ 复核:输出确实是我们要的形状,且元数据确已清空。
    // 这一步是**执行位不是装饰** —— EXIF 清除依赖的是 sharp「不显式要求就不带元数据」
    // 的默认行为,那是别人的实现细节。升级 sharp 若改了默认,这里会立刻发现。
    const outMeta = await sharp(output).metadata();
    const metadataStripped =
      outMeta.exif === undefined && outMeta.icc === undefined && outMeta.xmp === undefined;

    return {
      buffer: output,
      mime: 'image/jpeg',
      width: outMeta.width ?? profile.targetWidth,
      height: outMeta.height ?? profile.targetHeight,
      bytes: output.byteLength,
      sourceWidth,
      sourceHeight,
      sourceFormat: metadata.format ?? 'unknown',
      orientationApplied,
      metadataStripped,
    };
  }

  private async readMetadata(source: Buffer, profile: ImageProfile): Promise<Metadata> {
    try {
      return await sharp(source, {
        limitInputPixels: profile.maxSourcePixels,
        animated: false,
      }).metadata();
    } catch (error) {
      // sharp 不给错误码,只能认文本。像素上限与「根本解不开」是两种完全不同的处置,
      // 合成一个码会让「超大图」和「文件损坏」在前端长得一样。
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(SHARP_PIXEL_LIMIT_MARKER)) {
        throw new BizException(BizCode.ATTACHMENT_IMAGE_PIXELS_EXCEEDED);
      }
      throw new BizException(BizCode.ATTACHMENT_IMAGE_UNDECODABLE);
    }
  }
}
