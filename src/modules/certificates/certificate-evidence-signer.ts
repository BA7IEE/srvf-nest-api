import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';

// 冻结稿 §13.5 / §15.5 / §15.6:证据图短 TTL signed-URL 的**唯一**签发封装。
//
// 抽出来的理由不是省几行:PR-4a-1 与 PR-5 各写了一遍「取 key → 循环 generateDownloadUrl
// → 拼 expiresAt」,连 TTL 常量都各声明了一个。两份实现意味着任何一次收紧
// (改 TTL、加 provider fail-closed、改 key 过滤)都必须有人记得改两处 ——
// 而 §13.5 明写「Claim 与 Certificate 共用同一套证据签发封装,不写第二套签名逻辑」。
//
// 本类**只负责签**,不判权、不判状态、不写审计:
//   判权在各 service 的入口码(招新走 GLOBAL rbac,证书走 scoped authz),
//   状态闸在各自的状态机,审计必须先于签发落账(fail-closed)。
// 把这三件事塞进签发器会让「谁把的关」变得取决于调用顺序。

/** §13.5:TTL ≤300s。`Cache-Control: no-store` 由各 controller 设置。 */
export const CERTIFICATE_EVIDENCE_URL_TTL_SECONDS = 300;

export interface SignedEvidenceUrls {
  urls: string[];
  expiresAt: Date;
}

@Injectable()
export class CertificateEvidenceSigner {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  /**
   * `imageKeys` Json 列 → 干净的 key 数组。
   *
   * 非数组、含非字符串项一律过滤掉而不是抛:这一列是历史数据可能不规整的地方,
   * 而「取证据」不该因为某一项脏就整条读不出来。
   */
  static keysOf(imageKeys: Prisma.JsonValue | null | undefined): string[] {
    return Array.isArray(imageKeys)
      ? imageKeys.filter((k): k is string => typeof k === 'string')
      : [];
  }

  /**
   * 逐 key 签短 TTL 下载 URL。
   *
   * 逐个串行而不是 `Promise.all`:provider 侧签名有速率上限,而单条 Claim 的证据
   * 最多 3 张(`CERTIFICATE_CLAIM_IMAGES_MAX`),并发省不下可观测的时间,
   * 却会让失败时「已经签了几个」变得不确定。
   *
   * 出参只有 URL —— **key 不外传**(§15.6:key / URL / 文件名一律不进日志与审计)。
   */
  async sign(keys: readonly string[]): Promise<SignedEvidenceUrls> {
    const urls: string[] = [];
    for (const key of keys) {
      const r = await this.storage.generateDownloadUrl({
        key,
        expiresIn: CERTIFICATE_EVIDENCE_URL_TTL_SECONDS,
      });
      urls.push(r.url);
    }
    return {
      urls,
      expiresAt: new Date(Date.now() + CERTIFICATE_EVIDENCE_URL_TTL_SECONDS * 1000),
    };
  }
}
