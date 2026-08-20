import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import appConfig from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentAccessService, SafeAttachment } from './attachment-access.service';
import {
  ACCOUNT_AVATAR_PROFILE,
  AttachmentImageNormalizer,
  ImageProfile,
  NormalizedImage,
  UNIFORM_PORTRAIT_V1_PROFILE,
} from './attachment-image-normalizer';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type { HeadObjectResult, StorageObjectLocator } from '../storage/storage.types';
import { STORAGE_UNBOUND_GRACE_MS } from '../storage/storage-consistency.types';
import {
  AttachmentUploadStorageIdentity,
  PreparedAttachmentStorageUpload,
  VisualIdentityUploadFinalized,
  VisualIdentityUploadPrepared,
  VisualIdentityUploadValidated,
  VisualIdentityUploadVerified,
} from './attachment-storage.types';
import { AttachmentOwnerType } from './attachment-validation';
import { StorageSettingsService } from '../storage/storage-settings.service';

/**
 * issue #1055 T2 —— 视觉身份资产的**可信 facade**(账号头像 / 队员标准照)。
 *
 * ## 为什么这两个 owner type 不能走通用 Attachment 接口
 *
 * 通用接口只知道「这个文件归谁」,证明不了这三条领域不变量(issue §12):
 *   - 头像必须是**本人的**;
 *   - 一个 Member **至多一张 ACTIVE** 标准照;
 *   - 替换必须**版本化**,不能覆盖旧行。
 * 所以两者在 `attachment-validation.ts` 的 internal-only 集合里,通用端点一律 fail-closed;
 * 唯一入口就是本类。
 *
 * ## 为什么是一个类而不是两个
 *
 * goal 写的是「两个 facade」。**对调用方而言确实是两条独立入口**(kind 区分,
 * 句柄不可跨 kind 复用);但两者的**存储机制逐字相同** —— 同一套
 * 「事务外校验 → 锁内备 intent → 事务外 put+HEAD → 锁内原子落库」。
 * 拆成两个类 = 把 ~150 行编排复制两份,而那正是 T1 刚从 internal-only 名单里
 * 消灭掉的「多份手抄副本」缺陷类:改一处漏一处,且不会编译失败也不会测试变红。
 *
 * 真正不同的两件事都**不在**本类里:
 *   - 图片规格 → `ImageProfile`(数据,不是代码分支);
 *   - 领域不变量(头像指针 / 标准照版本机) → 归调用方的事务管(T3 users / T4 members),
 *     镜像 registration-upload-session 把「session 授权」留给 App 路由的分工。
 *
 * ## 四阶段之间为什么要断开
 *
 * Provider 的 put 与 HEAD 是**网络调用**,绝不能待在数据库事务里(仓内铁律)。
 * 于是编排必须是「短事务 → 出事务做网络 → 再短事务」,句柄把三段串起来,
 * 且每个句柄**一次性**(consume 即失效),顺序错、重放、跨 kind 都拿不到 state。
 */

export type VisualIdentityUploadKind = 'user-avatar' | 'member-official-portrait';

interface VisualIdentityKindConfig {
  readonly ownerType: AttachmentOwnerType;
  /** 与 `attachment_type_configs.ownerTable` 逐字相同;不符即拒(防配置漂移)。 */
  readonly ownerTable: string;
  readonly profile: ImageProfile;
  /** 上传原图体积上限。规范化**之后**的体积由规格决定,与本值无关。 */
  readonly maxUploadBytes: number;
  readonly allowedMime: ReadonlySet<string>;
}

/**
 * ⚠️ `ownerTable` 写的是 `User` / `Member` —— 这两个 model **没有 `@@map`**,
 * 物理表名就是首字母大写的 model 名。写成 `users` / `members` 会在
 * `assertOwnerTypeAllowed` 的回读比对处直接拒掉(seed 里存的也是这两个值)。
 */
const KIND_CONFIG: Readonly<Record<VisualIdentityUploadKind, VisualIdentityKindConfig>> = {
  'user-avatar': {
    ownerType: 'user-avatar',
    ownerTable: 'User',
    profile: ACCOUNT_AVATAR_PROFILE,
    maxUploadBytes: 10 * 1024 * 1024,
    allowedMime: new Set(['image/jpeg', 'image/png']),
  },
  'member-official-portrait': {
    ownerType: 'member-official-portrait',
    ownerTable: 'Member',
    profile: UNIFORM_PORTRAIT_V1_PROFILE,
    maxUploadBytes: 10 * 1024 * 1024,
    allowedMime: new Set(['image/jpeg', 'image/png']),
  },
};

/** 落库后回给调用方的受控摘要。**不含** key / locator / signed URL。 */
export interface VisualIdentityUploadView {
  readonly attachmentId: string;
  readonly mime: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  /** 规格代码。标准照侧要原样写进 `MemberOfficialPortrait.specVersion`。 */
  readonly specCode: string;
  readonly createdAt: Date;
}

type VisualIdentityContextState =
  | {
      stage: 'validated';
      kind: VisualIdentityUploadKind;
      identity: AttachmentUploadStorageIdentity;
      body: Buffer;
      normalized: NormalizedImage;
      locator: StorageObjectLocator;
      expiresAt: Date;
      user: CurrentUserPayload;
    }
  | {
      stage: 'prepared';
      kind: VisualIdentityUploadKind;
      identity: AttachmentUploadStorageIdentity;
      body: Buffer;
      normalized: NormalizedImage;
      locator: StorageObjectLocator;
      expiresAt: Date;
      user: CurrentUserPayload;
      prepared: PreparedAttachmentStorageUpload;
    }
  | {
      stage: 'verified';
      kind: VisualIdentityUploadKind;
      identity: AttachmentUploadStorageIdentity;
      body: Buffer;
      normalized: NormalizedImage;
      locator: StorageObjectLocator;
      expiresAt: Date;
      user: CurrentUserPayload;
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
    }
  | {
      stage: 'finalized';
      kind: VisualIdentityUploadKind;
      normalized: NormalizedImage;
      row: SafeAttachment;
    };

@Injectable()
export class AttachmentVisualIdentityUploadService {
  private readonly contexts = new WeakMap<object, VisualIdentityContextState>();

  constructor(
    private readonly access: AttachmentAccessService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    private readonly imageNormalizer: AttachmentImageNormalizer,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  /**
   * 阶段 ①(事务外):校验 + **规范化**。调用方负责它自己的授权(本人 / scoped 判权)。
   *
   * ⚠️ 落库的**不是**用户传上来的字节,而是本步规范化产出的那份:
   * mime 恒 `image/jpeg`、体积是重编码后的体积、元数据已清空。
   * 客户端声明的 mime / size 只用来**闸控入口**,不进 storage identity ——
   * 「存下去的就是我们自己产出的」这条性质,是整个视觉身份链不被塞进奇怪二进制的地基。
   */
  async validateVisualIdentityUploadOutsideTransactionTrusted(input: {
    kind: VisualIdentityUploadKind;
    ownerId: string;
    originalName: string;
    mime: string;
    size: number;
    body: Buffer;
    uploadedByUserId: string;
    user: CurrentUserPayload;
    expiresAt: Date;
  }): Promise<VisualIdentityUploadValidated> {
    const config = KIND_CONFIG[input.kind];

    // 入口闸:声明值自身要自洽(size 与实际字节数一致),再谈其它。
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.body.length !== input.size ||
      typeof input.mime !== 'string' ||
      input.mime.length === 0
    ) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }
    if (!config.allowedMime.has(input.mime)) {
      throw new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
    }
    if (input.size > config.maxUploadBytes) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }

    // 配置表是运行时权威源:owner type 必须在册且 ACTIVE,且 ownerTable 与本类的预期一致。
    // 后半句是防漂移 —— 运营若把 `user-avatar` 的 ownerTable 改成别的表,
    // 这里立刻拒,而不是拿着错的表去做 ownerId 真实性校验。
    const { ownerTable } = await this.access.assertOwnerTypeAllowed(config.ownerType);
    if (ownerTable !== config.ownerTable) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }
    await this.access.assertMimeAllowed(config.ownerType, input.mime);
    await this.access.assertSizeAllowed(config.ownerType, input.size);
    this.access.assertNoPii({ originalName: input.originalName });

    // 既有的唯一内容校验入口:系统级 MIME 黑名单 + 固定前缀签名表。**不绕开、不重造**。
    this.storageConsistency.validateUploadBufferOutsideTransaction(input.mime, input.body);

    // 本刀新增的一层:真解码 + 形状校验 + 方向修正 + 清元数据 + 重编码。
    // 签名只证明「开头几个字节像 JPEG」,证明不了「这真是一张合规的单帧图」。
    const normalized = await this.imageNormalizer.normalize(input.body, config.profile);
    if (!normalized.metadataStripped) {
      // 走到这里说明 sharp 的默认行为变了(升级?),而我们**不能**把可能带 GPS 的
      // 二进制落进队员档案。宁可整条链失败,也不要静默放行。
      throw new BizException(BizCode.ATTACHMENT_IMAGE_UNDECODABLE);
    }

    const settings = await this.storageSettings.getActiveSettings();
    const key = this.access.generateAttachmentKey(
      settings?.envPrefix ?? this.cfg.env,
      normalized.mime,
    );
    const locator = await this.storageConsistency.resolveUploadLocatorForTransaction(key);

    return this.issue({
      stage: 'validated',
      kind: input.kind,
      identity: {
        key,
        ownerType: config.ownerType,
        ownerId: input.ownerId,
        // 扩展名跟着**实际产物**走:存的是 JPEG,名字就不该还叫 .png。
        // 元数据自相矛盾会让日后任何按名字判类型的工具都出错。
        originalName: toJpegName(input.originalName),
        mime: normalized.mime,
        size: normalized.bytes,
        uploadedByUserId: input.uploadedByUserId,
      },
      body: normalized.buffer,
      normalized,
      locator,
      expiresAt: input.expiresAt,
      user: { ...input.user },
    }) as VisualIdentityUploadValidated;
  }

  /** 阶段 ②(调用方事务内,已持有 User / Member 聚合根锁并复核过归属)。 */
  async prepareVisualIdentityUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: VisualIdentityUploadValidated,
  ): Promise<VisualIdentityUploadPrepared> {
    const state = this.consume(context, 'validated');
    const prepared = await this.storageConsistency.prepareUploadInTransaction(
      tx,
      state.identity,
      'attachment_legacy',
      new Date(state.expiresAt.getTime() + STORAGE_UNBOUND_GRACE_MS),
      state.locator,
    );
    return this.issue({ ...state, stage: 'prepared', prepared }) as VisualIdentityUploadPrepared;
  }

  /** 阶段 ③(事务外):Provider put + 钉住的 HEAD 证据。刻意夹在两个短事务之间。 */
  async putVisualIdentityUploadAndVerifyOutsideTransactionTrusted(
    context: VisualIdentityUploadPrepared,
  ): Promise<VisualIdentityUploadVerified> {
    const state = this.consume(context, 'prepared');
    const head = await this.storageConsistency.putUploadObjectAtAndVerifyOutsideTransaction(
      state.identity,
      'attachment_legacy',
      state.prepared.locator,
      state.body,
    );
    return this.issue({ ...state, stage: 'verified', head }) as VisualIdentityUploadVerified;
  }

  /** 阶段 ④(调用方第二次事务内,已重新取锁并复核绑定):原子完成 Attachment + ledger + audit。 */
  async finalizeVisualIdentityUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: VisualIdentityUploadVerified,
    auditMeta: AuditMeta,
  ): Promise<VisualIdentityUploadFinalized> {
    const state = this.consume(context, 'verified');
    const config = KIND_CONFIG[state.kind];
    const row = await this.storageConsistency.finalizeUploadInTransaction(
      tx,
      {
        identity: state.identity,
        requestHash: state.prepared.requestHash,
        data: {
          key: state.identity.key,
          originalName: state.identity.originalName,
          mime: state.identity.mime,
          size: state.identity.size,
          uploadedBy: state.identity.uploadedByUserId,
          ownerType: state.identity.ownerType,
          ownerId: state.identity.ownerId,
          originalUploaderName: state.user.username,
          etag: state.head.etag ?? null,
        },
        auditKind: 'legacy',
        actorRoleSnap: state.user.role,
        scope: null,
        ownerTable: config.ownerTable,
        auditMeta,
      },
      state.head,
    );
    return this.issue({
      stage: 'finalized',
      kind: state.kind,
      normalized: state.normalized,
      row,
    }) as VisualIdentityUploadFinalized;
  }

  /** 受控摘要。**不返回** storage key / locator / signed URL(issue §11.2 禁记清单同源)。 */
  visualIdentityUploadResponseTrusted(
    context: VisualIdentityUploadFinalized,
  ): VisualIdentityUploadView {
    const state = this.require(context, 'finalized');
    return {
      attachmentId: state.row.id,
      mime: state.row.mime,
      size: state.row.size,
      width: state.normalized.width,
      height: state.normalized.height,
      specCode: KIND_CONFIG[state.kind].profile.code,
      createdAt: state.row.createdAt,
    };
  }

  // ===== 句柄生命周期(沿 registration-upload-session 同一实现)=====
  //
  // 句柄本身是**冻结的空对象**,不带任何字段:即便它被泄露到日志或响应里,
  // 也读不出 key / locator / 用户身份。真正的 state 只在本类的 WeakMap 里。

  private issue(state: VisualIdentityContextState): object {
    const context = Object.freeze(Object.create(null)) as object;
    this.contexts.set(context, state);
    return context;
  }

  private require<Stage extends VisualIdentityContextState['stage']>(
    context: object,
    stage: Stage,
  ): Extract<VisualIdentityContextState, { stage: Stage }> {
    const state = this.contexts.get(context);
    if (!state || state.stage !== stage) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    return state as Extract<VisualIdentityContextState, { stage: Stage }>;
  }

  /** 取出即失效:顺序错、重放同一个句柄、跨阶段复用,都拿不到 state。 */
  private consume<Stage extends VisualIdentityContextState['stage']>(
    context: object,
    stage: Stage,
  ): Extract<VisualIdentityContextState, { stage: Stage }> {
    const state = this.require(context, stage);
    this.contexts.delete(context);
    return state;
  }
}

/**
 * 把文件名的扩展名换成 `.jpg`,其余部分原样保留。
 *
 * 无扩展名时直接追加。**不做任何其它清洗** —— PII 检查在调用点已经跑过,
 * 长度上限由 DTO 承担,这里再动一遍只会造出第二处规则。
 */
function toJpegName(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base}.jpg`;
}
