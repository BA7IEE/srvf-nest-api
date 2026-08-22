import { Injectable } from '@nestjs/common';

import { AttachmentsService } from '../attachments/attachments.service';

/*
 * 活动封面 / 图集的**签名解析层**(P2-14 刀 A)。
 *
 * 为什么需要单独一层:活动的序列化层 `activity-presenter.ts` 是**纯函数**,harness 的
 * ESLint 规则 (j) 对 `*presenter*.ts` 有结构性禁令(Presenter 不碰 DB,入参即全部依赖)。
 * 而签 URL 要读 StorageSettings 与 Attachment.expireAt —— 是取数。按 presenter 文件头
 * 自己写的契约「需要取数的放回调用方,查询**结果**当入参传进来」,取数就落在这一层。
 *
 * 签名本身**不在这里实现**:一律委托 `AttachmentsService.resolveSignedUrlTrusted`,
 * 与内容模块(`content.service.ts` / `content-read.service.ts`)走的是同一个方法。
 * 过期附件返回 null、TTL 取 StorageSettings.downloadUrlTtlSeconds —— 三处口径逐字相同。
 *
 * ⚠️ 可信语义:`resolveSignedUrlTrusted` 只签传入的 key,没有 owner 上下文、不做 RBAC。
 * 调用方必须**先**完成活动自身的可见级 / 判权校验 —— 与内容模块同一条前提。
 *
 * ⚠️ 已知性能边界(与对照组同型,不是本刀引入):`resolveSignedUrlTrusted(key)` 内部要按 key
 * 查一次 Attachment 取 expireAt,故列表页是 per-row 一次查询。内容模块列表(端点 2)此刻
 * 也是这个形状。**刻意不在这里另造批量版本** —— 那会让「怎么签一张封面」有两份实现,
 * 而两份实现漂移时没有症状。要优化就连内容模块一起优化,那是另一刀。
 */

/** 详情面:封面 + 图集。字段名与旧的裸 URL 字段**保持一致**,前端不用改字段名。 */
export interface ActivitySignedImages {
  coverImageUrl: string | null;
  galleryImageUrls: string[] | null;
}

/** 列表面:只有封面(列表精简版本就不返图集)。 */
export interface ActivitySignedCover {
  coverImageUrl: string | null;
}

export interface ActivityCoverKeySource {
  coverImageKey: string | null;
}

export interface ActivityImageKeySource extends ActivityCoverKeySource {
  galleryImageKeys: string[];
}

@Injectable()
export class ActivityImageSigningService {
  constructor(private readonly attachments: AttachmentsService) {}

  async signCover(row: ActivityCoverKeySource): Promise<ActivitySignedCover> {
    return { coverImageUrl: await this.attachments.resolveSignedUrlTrusted(row.coverImageKey) };
  }

  /**
   * 图集:逐位签名后**剔除签不出来的项**(附件已过期 / 已删 ⇒ 该位返 null ⇒ 丢弃)。
   * 剔除而不是留 null,是因为 DTO 契约是 `string[] | null` —— 数组里混 null 会让前端
   * 每一处都要判空。图集全空时返回 `[]` 而不是 null:活动**有没有设过图集**由 DB 列
   * 说了算,而 `galleryImageKeys` 恒非 null(migration 的 CHECK 守着),所以 `[]` 是诚实的
   * 「设过但当前无可展示项」。
   */
  async signImages(row: ActivityImageKeySource): Promise<ActivitySignedImages> {
    const [coverImageUrl, galleryUrls] = await Promise.all([
      this.attachments.resolveSignedUrlTrusted(row.coverImageKey),
      Promise.all(row.galleryImageKeys.map((key) => this.attachments.resolveSignedUrlTrusted(key))),
    ]);
    return {
      coverImageUrl,
      galleryImageUrls: galleryUrls.filter((url): url is string => url !== null),
    };
  }

  /** 列表批量:逐行调 signCover。顺序与入参一致。 */
  async signCovers(rows: readonly ActivityCoverKeySource[]): Promise<ActivitySignedCover[]> {
    return Promise.all(rows.map((row) => this.signCover(row)));
  }
}
