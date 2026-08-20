import { Injectable } from '@nestjs/common';
import { MemberOfficialPortraitStatus, Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AttachmentVisualIdentityUploadService } from '../attachments/attachment-visual-identity-upload.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { MembersQueryService } from './members-query.service';
import { MEMBER_READ_PERMISSION_CODE } from './member-read-scope';
import type { MemberOfficialPortraitDto } from './members.dto';

/**
 * issue #1055 T4 —— 队员标准照闭环。
 *
 * ## 本类拥有什么
 *
 * `Member` 聚合根的锁与事务、**one-active 版本状态机**、scoped 判权、四个审计事件。
 * 图片规格与 storage 编排全在 `AttachmentVisualIdentityUploadService` 后面(T2),本类只调它的受控出口。
 *
 * ## 为什么标准照要版本化,而头像不用
 *
 * 头像是展示品,换掉就换掉了。标准照是**正式业务事实**:制证 / 年度名录 / 对外报送一旦定稿,
 * 不能因为本人换了照片而背后变图(issue §10.3)。所以每次替换**新建一行**、旧行转 SUPERSEDED
 * 保留,正式材料引用的是 `MemberOfficialPortrait.id` 而不是「当前那张」。
 *
 * ## 三道防线守 one-active
 *
 * 1. `Member` 行 `FOR UPDATE` —— 让同一队员的两次替换串行;
 * 2. 同事务内「旧行转 SUPERSEDED + 新行 ACTIVE」原子完成;
 * 3. **DB partial unique**(`member_official_portrait_one_active_per_member`)——
 *    唯一**不依赖应用代码写对**的兜底。第 3 道不是冗余:锁保证串行,但不保证后来者
 *    看到的是最新状态(除非它在锁内重读,而「忘了重读」不会让任何东西报错)。
 *    冲突表现为 23505,由本类映射成明确 BizCode。
 */
@Injectable()
export class MemberOfficialPortraitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visualIdentity: AttachmentVisualIdentityUploadService,
    private readonly auditLogs: AuditLogsService,
    private readonly authz: AuthzService,
    private readonly membersQuery: MembersQueryService,
  ) {}

  /**
   * 上传 / 替换队员标准照。
   *
   * 事务边界与 T3 头像同形:短事务备 intent → **事务外** Provider put+HEAD → 短事务原子落库。
   * Provider 是网络调用,放进事务会让一次抖动挂住 `Member` 行锁(仓内生产事务只有 5s 预算)。
   */
  async replace(
    memberId: string,
    user: CurrentUserPayload,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    auditMeta: AuditMeta,
  ): Promise<MemberOfficialPortraitDto> {
    await this.assertManageScope(memberId, user);

    const validated =
      await this.visualIdentity.validateVisualIdentityUploadOutsideTransactionTrusted({
        kind: 'member-official-portrait',
        ownerId: memberId,
        originalName: file.originalname,
        mime: file.mimetype,
        size: file.size,
        body: file.buffer,
        uploadedByUserId: user.id,
        user,
        expiresAt: new Date(Date.now() + PORTRAIT_UPLOAD_INTENT_TTL_MS),
      });

    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.lockLiveMember(tx, memberId);
      return this.visualIdentity.prepareVisualIdentityUploadInTransactionTrusted(tx, validated);
    });

    const verified =
      await this.visualIdentity.putVisualIdentityUploadAndVerifyOutsideTransactionTrusted(prepared);

    const { row, supersededAttachmentId } = await this.prisma.$transaction(async (tx) => {
      await this.lockLiveMember(tx, memberId);

      const done = await this.visualIdentity.finalizeVisualIdentityUploadInTransactionTrusted(
        tx,
        verified,
        auditMeta,
      );
      const view = this.visualIdentity.visualIdentityUploadResponseTrusted(done);

      // ⚠️ **锁内重读**当前 ACTIVE,不能用锁外读到的值:阶段 ③ 期间锁是放开的。
      const current = await tx.memberOfficialPortrait.findFirst({
        where: { memberId, status: MemberOfficialPortraitStatus.ACTIVE },
        select: { id: true, version: true, attachmentId: true },
      });

      // 旧版与新版取**同一瞬间**:版本历史不留缝也不重叠。
      // T1 特意把 `activatedAt` 的 `@default(now())` 拿掉,就是为了让这件事可能 ——
      // 有默认值时新版的时间来自库时钟、旧版的 endedAt 来自应用时钟,两个源对不齐。
      const now = new Date();

      if (current !== null) {
        await tx.memberOfficialPortrait.update({
          where: { id: current.id },
          data: {
            status: MemberOfficialPortraitStatus.SUPERSEDED,
            endedAt: now,
            endedByUserId: user.id,
            endReason: SUPERSEDED_BY_REPLACEMENT_REASON,
          },
        });
      }

      // 版本号按队员单调递增。**取 max 而不是 count** —— 作废过的行也占号,
      // count 会在有终态行时给出已被占用的号,撞 `@@unique([memberId, version])`。
      const highest = await tx.memberOfficialPortrait.aggregate({
        where: { memberId },
        _max: { version: true },
      });
      const nextVersion = (highest._max.version ?? 0) + 1;

      // P2002 → 明确 BizCode。走到这里说明两次替换并发穿过了 Member 行锁
      // (锁保证串行,不保证后来者重读到最新状态)—— DB 的 partial unique 是最后一道兜底,
      // 不该把它的 23505 当 500 抛给调用方。
      const created = await this.createPortraitRow(tx, {
        memberId,
        version: nextVersion,
        attachmentId: view.attachmentId,
        specVersion: view.specCode,
        activatedAt: now,
        activatedByUserId: user.id,
      }).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BizException(BizCode.MEMBER_OFFICIAL_PORTRAIT_CONFLICT);
        }
        throw error;
      });

      await this.auditLogs.log({
        event:
          current === null
            ? 'member.official-portrait.activate'
            : 'member.official-portrait.replace',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'member',
        resourceId: memberId,
        meta: auditMeta,
        // extra 闭集(issue §11.2):禁 storage key / signed URL / 二进制 / Provider locator / EXIF。
        extra: {
          memberId,
          portraitVersionId: created.id,
          attachmentId: view.attachmentId,
          specVersion: view.specCode,
          source: created.source,
          ...(current === null ? {} : { oldVersionId: current.id, newVersionId: created.id }),
        },
        tx,
      });

      return { row: created, supersededAttachmentId: current?.attachmentId ?? null };
    });

    // 被顶替的那一版**不清二进制** —— 它是历史事实,正式材料可能还引着它。
    // (与 T3 头像相反:头像换掉就该清。合规清理走 issue §5.2 的 purge 流程,不在本刀。)
    void supersededAttachmentId;

    return this.toDto(row);
  }

  /**
   * 作废当前标准照(ACTIVE → VOIDED)。
   *
   * **必须给 reason**(issue §8.3)。作废后当前标准照为空,界面显示默认占位图;
   * **不自动回退到上一个 SUPERSEDED 版本** —— 历史版本表达的是过去事实,
   * 想重新启用旧照片必须「新建一个正式版本」,而不是把历史行的状态改回去。
   */
  async void(
    memberId: string,
    user: CurrentUserPayload,
    reason: string,
    auditMeta: AuditMeta,
  ): Promise<void> {
    await this.assertManageScope(memberId, user);

    await this.prisma.$transaction(async (tx) => {
      await this.lockLiveMember(tx, memberId);
      const current = await tx.memberOfficialPortrait.findFirst({
        where: { memberId, status: MemberOfficialPortraitStatus.ACTIVE },
        select: { id: true },
      });
      // 没有当前标准照时**不是幂等成功**,而是 404:调用方以为自己作废了某张照片,
      // 实际什么都没发生 —— 这与「清空头像」不同,作废是一个针对具体版本的判断。
      if (current === null) throw new BizException(BizCode.MEMBER_OFFICIAL_PORTRAIT_NOT_FOUND);

      await tx.memberOfficialPortrait.update({
        where: { id: current.id },
        data: {
          status: MemberOfficialPortraitStatus.VOIDED,
          endedAt: new Date(),
          endedByUserId: user.id,
          endReason: reason,
        },
      });

      await this.auditLogs.log({
        event: 'member.official-portrait.void',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'member',
        resourceId: memberId,
        meta: auditMeta,
        extra: { memberId, portraitVersionId: current.id, reason },
        tx,
      });
    });
  }

  /** 当前 ACTIVE 标准照。读取复用 `member.read.record` + 同一套组织范围(issue §8.1)。 */
  async getCurrent(
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<MemberOfficialPortraitDto | null> {
    await this.assertScope(memberId, user, MEMBER_READ_PERMISSION_CODE);
    const row = await this.prisma.memberOfficialPortrait.findFirst({
      where: { memberId, status: MemberOfficialPortraitStatus.ACTIVE },
      select: PORTRAIT_SELECT,
    });
    return row === null ? null : this.toDto(row);
  }

  /** 版本历史(含已顶替 / 已作废)。**另一个权限码** —— 看得见当前不等于看得见历史。 */
  async listHistory(
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<MemberOfficialPortraitDto[]> {
    await this.assertScope(memberId, user, PORTRAIT_READ_HISTORY_PERMISSION_CODE);
    const rows = await this.prisma.memberOfficialPortrait.findMany({
      where: { memberId },
      select: PORTRAIT_SELECT,
      orderBy: { version: 'desc' },
    });
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  // ===== internals =====

  private assertManageScope(memberId: string, user: CurrentUserPayload): Promise<void> {
    return this.assertScope(memberId, user, PORTRAIT_MANAGE_PERMISSION_CODE);
  }

  /**
   * scoped 判权:**先看有没有码,再看这个队员在不在范围内**。
   *
   * ⚠️ 只验第一半是最容易犯的错 —— 那样 A 部门的队长拿着 org-scoped 绑定就能改
   * B 部门队员的标准照,而 `hasPermission` 照样是 true。issue §8.1 要的正是第二半。
   *
   * 范围 → where 的翻译**复用 `MembersQueryService.buildOrganizationScopeFilter`**,
   * 不另写一份:那条链上两端各只有一份实现,漂移的表现会是「多看见了本不该看见的人」,
   * 而这种漂移不会让任何东西报错。
   */
  private async assertScope(
    memberId: string,
    user: CurrentUserPayload,
    permissionCode: string,
  ): Promise<void> {
    const scope = await this.authz.getVisibleOrganizationScope(user, permissionCode);
    if (!scope.hasPermission) throw new BizException(BizCode.RBAC_FORBIDDEN);

    const scopeFilter = await this.membersQuery.buildOrganizationScopeFilter(
      scope,
      undefined,
      undefined,
    );
    const found = await this.prisma.member.findFirst({
      where: { id: memberId, deletedAt: null, ...(scopeFilter ?? {}) },
      select: { id: true },
    });
    // 范围外与不存在**返回同一个错误**:区分开来等于给出一个成员枚举口
    //(「这个 id 存在但你看不见」本身就是信息)。
    if (found === null) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  /**
   * 锁住 `Member` 行并复核未软删。
   *
   * 锁序 `Member → 当前 ACTIVE portrait → Attachment/StorageObject`(issue §8.2);
   * 本方法是第一环,后两环由本类的后续语句与 facade 依次取得。
   */
  private async lockLiveMember(tx: Prisma.TransactionClient, memberId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Member" WHERE "id" = ${memberId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  private createPortraitRow(
    tx: Prisma.TransactionClient,
    data: {
      memberId: string;
      version: number;
      attachmentId: string;
      specVersion: string;
      activatedAt: Date;
      activatedByUserId: string;
    },
  ): Promise<PortraitRow> {
    return tx.memberOfficialPortrait.create({
      data: { ...data, source: 'ADMIN_UPLOAD' },
      select: PORTRAIT_SELECT,
    });
  }

  private async toDto(row: PortraitRow): Promise<MemberOfficialPortraitDto> {
    const signed =
      row.attachmentId === null
        ? null
        : await this.visualIdentity.resolveVisualIdentityAccessUrlTrusted(row.attachmentId);
    return {
      id: row.id,
      memberId: row.memberId,
      version: row.version,
      status: row.status,
      specVersion: row.specVersion,
      source: row.source,
      capturedAt: row.capturedAt,
      activatedAt: row.activatedAt,
      endedAt: row.endedAt,
      endReason: row.endReason,
      attachmentId: row.attachmentId,
      accessUrl: signed?.accessUrl ?? null,
      accessUrlExpiresAt: signed?.expiresAt ?? null,
    };
  }
}

const PORTRAIT_SELECT = {
  id: true,
  memberId: true,
  version: true,
  status: true,
  specVersion: true,
  source: true,
  capturedAt: true,
  activatedAt: true,
  endedAt: true,
  endReason: true,
  attachmentId: true,
} as const;

type PortraitRow = Prisma.MemberOfficialPortraitGetPayload<{ select: typeof PORTRAIT_SELECT }>;

/** 与 `prisma/seed.ts` 的权限码常量同值。两处都是字符串字面量,靠 e2e 钉住一致性。 */
const PORTRAIT_MANAGE_PERMISSION_CODE = 'member-portrait.manage.record';
const PORTRAIT_READ_HISTORY_PERMISSION_CODE = 'member-portrait.read.history';

/**
 * 被替换时写进旧版 `endReason` 的固定文案。
 *
 * DB 的 `member_official_portraits_ended_shape_check` 只要求 `endedAt` 与 `endedByUserId` 非空,
 * 不要求 reason;但留空会让历史行看起来像「不知为何被终结」。**替换**与**作废**是两种终结,
 * 前者是正常世代更替、后者含「这张照片有问题」的判断,写死文案让两者在历史里一眼可分。
 */
const SUPERSEDED_BY_REPLACEMENT_REASON = '被新版本顶替(正常替换,非照片本身无效)';

/** 见 T3 同名常量:multipart 形状下正常路径用不到,只决定崩溃后孤儿 intent 多久可回收。 */
const PORTRAIT_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000;
