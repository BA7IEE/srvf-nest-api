import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type WecomSettings as WecomSettingsRow } from '@prisma/client';
import { createHash } from 'node:crypto';

import appConfig, { isProductionLike } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { maskCorpId } from './wecom.constants';
import { WecomCryptoDecryptError, WecomCryptoService } from './wecom-crypto.service';
import type {
  ResetWecomCredentialsDto,
  UpdateWecomSettingsDto,
  WecomProviderType,
  WecomSettingsResponseDto,
} from './wecom.dto';
import { WecomCredentialStatus, type WecomSettingsResolved } from './wecom.types';

// 企业微信接入 T2(2026-08-01):wecom_settings 读取层 + admin CRUD
// (冻结稿 §5.1 / §6.1;镜像 wechat-settings.service 范式)
//
// 与 WechatSettingsService 的差异:
// - 三个开关而非一个(enabled / loginEnabled / messageEnabled);后两个是二级闸,
//   置 true 必须 enabled=true —— 否则会出现"登录开着但总闸关着"这种自相矛盾的配置,
//   运维看 loginEnabled=true 以为能登,实际全被 enabled=false 挡掉。
// - corpId 有**改动前置条件**:仅 active identity=0 时可改(36020),需持 settings 行锁。
// - 多一个 test-connection(编排在 WecomService,本 Service 只出 resolved snapshot)。
//
// singleton 由第 68 migration 的 unique index on constant((true)) 在 DB 层强制;
// 并发首配由 P2002 后重跑同一事务映射到既有单行,不新增 BizCode(沿 wechat 同款)。
//
// 凭证安全(§5.5 L3 红线):response / 日志 / audit 永不含 CorpSecret 明文或密文;
// update 只记 changedFields;reset 不传 before/after/extra(连字段名都不写)。

// `lockAndRereadSettings` 的返回形状:**锁后**重读到的、参与本次判定的全部列。
// 单列一个类型是为了让"哪些值必须来自锁后行"在签名上显式可见 —— 加判据时必须先加到这里。
type LockedWecomSettings = {
  id: string;
  providerType: string;
  enabled: boolean;
  loginEnabled: boolean;
  messageEnabled: boolean;
  corpId: string | null;
};

@Injectable()
export class WecomSettingsService {
  private readonly logger = new Logger(WecomSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: WecomCryptoService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // RBAC 判权(镜像 wechat/sms 范式):失败统一 RBAC_FORBIDDEN(30100)。
  // `wecom-setting.reset.credentials` 不绑 ops-admin(冻结稿 §11.1),SUPER_ADMIN 经 rbac.can 短路通过。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  /**
   * 读取 PostgreSQL 当前生效配置(singleton row;每次调用直读)
   * - DB 空 → null(调用路径由 WecomService 映射 36030)
   * - 第 68 migration 后 DB 层保证至多一条
   */
  async getActiveSettings(): Promise<WecomSettingsResolved | null> {
    const row = await this.prisma.wecomSettings.findFirst();
    return row === null ? null : this.toResolved(row);
  }

  // ============ admin 四端点其三(第四个 test-connection 在 WecomService)============

  // GET /api/system/v1/wecom-settings:不存在返 null(不抛码);永不回显凭证
  async getForAdmin(user: CurrentUserPayload): Promise<WecomSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'wecom-setting.read.singleton');
    const row = await this.prisma.wecomSettings.findFirst();
    return row === null ? null : this.toResponseDto(row);
  }

  // PATCH /api/system/v1/wecom-settings:upsert;不存在创建 default(providerType=DEV_STUB);
  // 拒绝凭证字段由 DTO 白名单兜底
  async updateSettings(
    dto: UpdateWecomSettingsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<WecomSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'wecom-setting.update.singleton');
    const data = this.buildUpdateData(dto);
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort();

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      // 行锁 → **锁后重读完整行**(2026-08-01 W1;S1 形状收口)。
      //
      // 初版是「`findFirst`(不带锁)→ `FOR UPDATE` → 拿**锁前**的行算终态」。
      // 锁前读到的值在拿到锁的那一刻可能已被别的事务改掉:两个并发 PATCH 各自用锁前快照判
      // 下面的组合不变量,就能合起来写出 `enabled=false + loginEnabled=true` ——
      // 一个自相矛盾却"两边都保存成功"的配置(red-first 见
      // test/e2e/wecom-settings-concurrency.e2e-spec.ts,两个顺序都复现)。
      //
      // 探测只取 id(id 一旦建成不再变);真正被用来判断的每一个值都来自**锁之后**的重读。
      // settings 是 singleton,锁它即锁住"本次配置变更"这条串行化通道(冻结稿 §9.2);
      // corpId 变更判定要读 active identity 计数,读完到写之间不能有人插入新绑定。
      const probe = await tx.wecomSettings.findFirst({ select: { id: true } });
      const lockedExisting = probe === null ? null : await this.lockAndRereadSettings(tx, probe.id);

      // 终态 = 锁后行 + 本次 dto(dto 未提供的字段保持锁后行的值);行不存在时用建 default 的取值。
      // 三个开关是**跨字段组合不变量**,必须在同一份终态上一次判完 —— 各判各的就是上面那个交错。
      const terminal = {
        // DB 侧 providerType 是 String 列(冻结稿 §5.1 逐字),闭集只由 DTO 的 @IsIn 在写入口把关;
        // 这里的断言只是把"库里可能有闭集外的值"这件事收进类型,运行时第②重仍在 resolveRoute。
        providerType: (dto.providerType ??
          lockedExisting?.providerType ??
          'DEV_STUB') as WecomProviderType,
        enabled: dto.enabled ?? lockedExisting?.enabled ?? false,
        loginEnabled: dto.loginEnabled ?? lockedExisting?.loginEnabled ?? false,
        messageEnabled: dto.messageEnabled ?? lockedExisting?.messageEnabled ?? false,
      };

      // ① production-like 禁 DEV_STUB(显式传入或"不存在则建 default"两条路径都拦;第②重在运行时 resolveRoute)
      if (isProductionLike(this.cfg.env) && terminal.providerType === 'DEV_STUB') {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      // ② 二级闸不得脱离总闸:loginEnabled / messageEnabled=true 必须 enabled=true
      if ((terminal.loginEnabled || terminal.messageEnabled) && !terminal.enabled) {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      // ③ webBaseUrl:production-like 仅 HTTPS origin(不含 path/query/fragment)
      if (dto.webBaseUrl !== undefined && !this.isValidWebBaseUrl(dto.webBaseUrl)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      // ④ corpId 仅在 active identity = 0 时可改(冻结稿 §6.1 / §5.1 规则 5)。
      // 已有人绑定时换 CorpID = 所有既有绑定静默失配(corpId 是身份键的一半),
      // 且两条 active partial unique 也按 corpId 分域 —— 换了之后旧行不再互斥,能出双 active。
      // ⚠️ 比对基准是**锁后**的 corpId:拿锁前值比,会把"别人刚改成同值"误判成一次真变更。
      if (
        dto.corpId !== undefined &&
        lockedExisting !== null &&
        lockedExisting.corpId !== null &&
        dto.corpId !== lockedExisting.corpId
      ) {
        const activeIdentities = await tx.wecomIdentity.count({
          where: { corpId: lockedExisting.corpId, status: 'active' },
        });
        if (activeIdentities > 0) {
          throw new BizException(BizCode.WECOM_CORP_ID_IN_USE);
        }
      }

      let updated: WecomSettingsRow;
      if (lockedExisting) {
        updated = await tx.wecomSettings.update({
          where: { id: lockedExisting.id },
          data: { ...data, updatedBy: user.id },
        });
      } else {
        updated = await tx.wecomSettings.create({
          data: {
            ...(data as Prisma.WecomSettingsCreateInput),
            providerType: dto.providerType ?? 'DEV_STUB',
            updatedBy: user.id,
          },
        });
      }

      // Audit 只记 changedFields(§11.3):不写 before/after value ——
      // corpId 的 value 不入 Audit(§5.5),agentId / webBaseUrl 也只记「改过哪些字段」。
      await this.auditLogs.log({
        event: 'wecom-setting.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'wecom_setting',
        resourceId: updated.id,
        meta: auditMeta,
        extra: { changedFields },
        tx,
      });
      return updated;
    });

    return this.toResponseDto(row);
  }

  // POST /api/system/v1/wecom-settings/reset-credentials:仅 SUPER_ADMIN 短路(码不绑 ops-admin);
  // CorpSecret AES-256-GCM 加密落库;不存在则 upsert 创建 default providerType=WECOM;响应不回显
  async resetCredentials(
    dto: ResetWecomCredentialsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<WecomSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'wecom-setting.reset.credentials');
    // WECOM_ENCRYPTION_KEY 缺失(dev/test 留空)时抛 WecomCryptoUnavailableError → 全局过滤器 500
    const corpSecretEncrypted = this.crypto.encrypt(dto.corpSecret);

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.wecomSettings.findFirst({ select: { id: true } });

      let updated: WecomSettingsRow;
      if (existing) {
        updated = await tx.wecomSettings.update({
          where: { id: existing.id },
          data: { corpSecretEncrypted, credentialConfigured: true, updatedBy: user.id },
        });
      } else {
        // 录凭证即意味着真实通道:default WECOM(镜像 wechat reset 默认 WECHAT 语义)
        updated = await tx.wecomSettings.create({
          data: {
            providerType: 'WECOM',
            corpSecretEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      }

      // 最硬红线(§11.3):reset audit 只保留 actor / row.id / AuditMeta;
      // **不传 before/after/extra** —— 连「改的是 corpSecret 这个字段」都不写进去。
      await this.auditLogs.log({
        event: 'wecom-setting.reset-credentials',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'wecom_setting',
        resourceId: updated.id,
        meta: auditMeta,
        tx,
      });
      return updated;
    });

    // 仅 pino 日志记动作 + actorUserId;不含 CorpSecret 明文 / 密文(L3 红线)
    this.logger.log(`wecom_settings credentials reset by user.id=${user.id}; row.id=${row.id}`);

    return this.toResponseDto(row);
  }

  // === helpers ===

  /**
   * 取 singleton 行的 `FOR UPDATE` 行锁,并**在锁之后**重读它。
   *
   * 返回值一定是"锁后行":调用方据此算终态、判组合不变量、比对 corpId。
   * 若该行在探测与取锁之间被删掉,`FOR UPDATE` 取不到任何行、重读也返 `null` ——
   * 调用方走"不存在"分支(create + P2002 兜底),与"从来没有过这一行"同解。
   */
  private async lockAndRereadSettings(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LockedWecomSettings | null> {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "wecom_settings" WHERE "id" = ${id} FOR UPDATE`);
    return tx.wecomSettings.findUnique({
      where: { id },
      select: {
        id: true,
        providerType: true,
        enabled: true,
        loginEnabled: true,
        messageEnabled: true,
        corpId: true,
      },
    });
  }

  private async runSingletonWriteWithUniqueRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const execute = () => this.prisma.$transaction(operation);
    try {
      return await execute();
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      return execute();
    }
  }

  // webBaseUrl 仅 origin:production-like 强制 HTTPS。
  // 拒 path/query/fragment 是防开放重定向 —— OAuth callback path 由代码固定拼接,
  // 若允许配置里带 path,配置面就成了改回跳目标的入口。
  private isValidWebBaseUrl(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (isProductionLike(this.cfg.env)) {
      if (url.protocol !== 'https:') return false;
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }
    if (url.search !== '' || url.hash !== '') return false;
    // URL 会把空 path 规范化成 '/';故 '/' 与 '' 均视作"无 path"
    if (url.pathname !== '/' && url.pathname !== '') return false;
    return true;
  }

  private buildUpdateData(dto: UpdateWecomSettingsDto): Prisma.WecomSettingsUpdateInput {
    const data: Prisma.WecomSettingsUpdateInput = {};
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.loginEnabled !== undefined) data.loginEnabled = dto.loginEnabled;
    if (dto.messageEnabled !== undefined) data.messageEnabled = dto.messageEnabled;
    if (dto.corpId !== undefined) data.corpId = dto.corpId;
    if (dto.agentId !== undefined) data.agentId = dto.agentId;
    if (dto.webBaseUrl !== undefined) data.webBaseUrl = dto.webBaseUrl;
    if (dto.remarks !== undefined) data.remarks = dto.remarks;
    return data;
  }

  private toResolved(row: WecomSettingsRow): WecomSettingsResolved {
    const { credentials, credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      configurationGeneration: this.configurationGeneration(row),
      providerType: row.providerType,
      enabled: row.enabled,
      loginEnabled: row.loginEnabled,
      messageEnabled: row.messageEnabled,
      corpId: row.corpId,
      agentId: row.agentId,
      webBaseUrl: row.webBaseUrl,
      credentials,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }

  // opaque generation(冻结稿 §5.1 规则 8):字段集逐字为
  // id/providerType/enabled/loginEnabled/messageEnabled/corpId/agentId/webBaseUrl/
  // credentialConfigured/corpSecretEncrypted。
  // 不含 remarks(规则 9)—— 改备注不该让全进程 token 作废;
  // 不暴露明文 Secret —— 这是 hash 不是可逆编码,且它本身也永不出响应。
  private configurationGeneration(row: WecomSettingsRow): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          row.id,
          row.providerType,
          row.enabled,
          row.loginEnabled,
          row.messageEnabled,
          row.corpId,
          row.agentId,
          row.webBaseUrl,
          row.credentialConfigured,
          row.corpSecretEncrypted,
        ]),
      )
      .digest('hex');
  }

  // 三档状态合成(镜像 wechat resolveCredentials 语义;单段密文)
  private resolveCredentials(row: WecomSettingsRow): {
    credentials: { corpSecret: string } | null;
    credentialStatus: WecomCredentialStatus;
  } {
    if (!row.credentialConfigured) {
      return { credentials: null, credentialStatus: WecomCredentialStatus.MISSING };
    }
    if (row.corpSecretEncrypted === null) {
      this.logger.warn(
        `wecom_settings.credentialConfigured=true but corpSecretEncrypted is null (id=${row.id}); treating as MISSING`,
      );
      return { credentials: null, credentialStatus: WecomCredentialStatus.MISSING };
    }
    try {
      const corpSecret = this.crypto.decrypt(row.corpSecretEncrypted);
      return { credentials: { corpSecret }, credentialStatus: WecomCredentialStatus.CONFIGURED };
    } catch (err) {
      if (err instanceof WecomCryptoDecryptError) {
        this.logger.warn(
          `wecom_settings credentials decrypt failed (id=${row.id}): ${err.message}; key rotated or ciphertext tampered`,
        );
        return { credentials: null, credentialStatus: WecomCredentialStatus.INVALID };
      }
      // WecomCryptoUnavailableError 或其他 → 同样视作 INVALID(防御;不抛)
      this.logger.warn(
        `wecom_settings credentials decrypt threw unexpected error (id=${row.id}): ${(err as Error).message}`,
      );
      return { credentials: null, credentialStatus: WecomCredentialStatus.INVALID };
    }
  }

  // Prisma row → ResponseDto(出参不含 corpSecretEncrypted / credentials / configurationGeneration;
  // corpId 只回显掩码)
  private toResponseDto(row: WecomSettingsRow): WecomSettingsResponseDto {
    const { credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType as WecomProviderType,
      enabled: row.enabled,
      loginEnabled: row.loginEnabled,
      messageEnabled: row.messageEnabled,
      corpIdMasked: row.corpId === null ? null : maskCorpId(row.corpId),
      agentId: row.agentId,
      webBaseUrl: row.webBaseUrl,
      credentialConfigured: row.credentialConfigured,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}
