import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { writeConfigAudit } from './config-audit.util';
import { buildPermissionCatalog } from './permission-catalog.presenter';
import {
  CreatePermissionDto,
  ListPermissionsQueryDto,
  PermissionCatalogResponseDto,
  PermissionResponseDto,
  UpdatePermissionDto,
} from './permissions.dto';
import { permissionSelect } from './permissions.select';
import { RbacService } from './rbac.service';
import { isSeedPermissionCode } from './seed-permission-codes';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块业务逻辑。
// 沿 D7 v1.1 §4.2 / §5.1 / §12.1。
//
// **D2 v1.2 code 格式正则**(沿 D7-RBAC v1.2 修订 PR #66 `2b934c5`):
// `<module>.<action>.<resource_type>[.<scope>]` — kebab-case 3-4 段;scope 可选,
// 当前用于 `.self` / `.other` ownership 后缀(沿 §8.2 `action.endsWith('.self')` 触发 ownership 判定)。
// 每段:首字母小写 + 后续 [a-z0-9-] 任意长度;段间用 `.` 严格分隔。
// 校验失败抛 BizException(BizCode.INVALID_PERMISSION_CODE_FORMAT)(30008)。
const CODE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/;

type SafePermission = Prisma.PermissionGetPayload<{ select: typeof permissionSelect }>;

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-1:RBAC 元接口判权(沿 attachments F5 v1.0 范本)。
  // 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);RbacService.can 内部
  // 已实现 SUPER_ADMIN 短路 + DB-backed permission resolution + ownership(.self),元接口粗粒度无 resource。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 业务详情查询:Permission 物理删(D4 v1.0;无 deletedAt),直接 findUnique by id;
  // 找不到统一抛 PERMISSION_NOT_FOUND(30001)。
  private async findByIdOrThrow(id: string): Promise<SafePermission> {
    const found = await this.prisma.permission.findUnique({
      where: { id },
      select: permissionSelect,
    });
    if (!found) throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    return found;
  }

  // P2002 兜底 — DTO @MinLength + Service findUnique 预检查应已拦绝大多数,
  // 这层处理并发场景(两个 create 同时撞 code unique)。
  private async runCodeUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('code')) {
          throw new BizException(BizCode.PERMISSION_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // D2 v1.0 code 格式校验 — 显式 regex 检查,失败抛 30008。
  // **不放在 DTO @Matches**:让本 BizCode 真正可触发并被 e2e 覆盖
  // (DTO @Matches 失败会走通用 BAD_REQUEST 40000,30008 永远不触发)。
  private assertCodeFormatValid(code: string): void {
    if (!CODE_PATTERN.test(code)) {
      throw new BizException(BizCode.INVALID_PERMISSION_CODE_FORMAT);
    }
  }

  // ============ 权限目录护栏(P1-32 PR1;2026-08-22)============
  //
  // 判据唯一谓词 `isSeedPermissionCode()`(唯一清单 seed-permission-codes.ts)。
  // 三条写路径共用它,**不得**各自再判一次 —— 各判各的就会出现「删挡住了、造没挡住」
  // 这种半边闸,而半边闸的症状恰好是「什么都不发生」。
  //
  // ⚠️ 护栏**只**管闭包内的码。闭包外的码(历史上凭空造出来的惰性码)删除行为一字不变 ——
  // 那些码本来就该能清掉,顺手全禁反而把唯一的清理入口也堵死。

  // 删:seed 事实闭包内的码是系统拥有的,任何身份(含 SUPER_ADMIN)均不得经 API 删。
  //
  // 挡的是什么:`RolePermission.permission` 是 onDelete: Cascade ⇒ 删一个码 = 一次性
  // 撤销**所有**角色对它的授权,无确认、无预览、无撤销。实测 `member.read.record`
  // 一次 DELETE 打掉 4 个角色的授权(337 → 333 行);重跑 seed 只能补回内置角色那部分,
  // 自定义角色那条永久丢失。
  private assertSeedPermissionDeletable(code: string): void {
    if (isSeedPermissionCode(code)) {
      throw new BizException(BizCode.SEED_PERMISSION_DELETE_FORBIDDEN);
    }
  }

  // 造:闭包外的码造出来是**惰性**的 —— 端点判的是硬编码的码,新造的码守不住任何端点。
  // 与其让管理员拿到一个「看起来生效、实际什么都不管」的权限且零反馈,不如当场拒绝并说明去处。
  //
  // 结果上这让 POST /permissions 不再可能成功(闭包内的码 seed 后已存在 → 30002;
  // 闭包外的码 → 30106)。这是**刻意的**:v1 的权限码只能改代码并发版,
  // 端点保留是为了给出一个明确的「不能这么干,该去哪」而不是静默造出无效配置。
  private assertPermissionCodeCreatable(code: string): void {
    if (!isSeedPermissionCode(code)) {
      throw new BizException(BizCode.PERMISSION_CODE_NOT_IN_SEED_CATALOG);
    }
  }

  // 改:闭包内的码,其 `description` 的权威源是**代码**(`permission-catalog.ts` 各
  // `*_PERMISSION_SEED` 条目的 `description` 字段),不是 DB 行。
  //
  // 🔴 这是 P1-32 PR 3b 对一条**刻意设计**的推翻,不是补一道漏接的闸:
  // `prisma/seed.ts` 的 upsert 用 `update: {}`,当年的注释逐字写着「防止运营运行时调整被
  // seed 回退」—— 也就是说「运行时可改、seed 不覆盖」是故意的。PR 0 把权限元数据做成
  // 代码侧单一事实源之后,这条设计的代价变成:DB 的 description 与代码常量是同一件事的
  // 两份副本,`update: {}` 保证 seed 永不拉回,于是两份可以各自漂移而**无人比对**。
  // 关掉这个入口 = 让代码常量单向成为唯一写者(seed 的 `create` 是唯一写路径)。
  //
  // ⚠️ 权威源是 `RbacPermissionSeed.description`,**不是**
  // `PERMISSION_CATALOG_METADATA.businessDescription` —— 后者是另一个字段
  // (面向后台编辑器的长句业务说明),从不写进 DB,两者内容本就不同。
  //
  // 结果上这让 PATCH /permissions/:id 不再可能成功(237 条码全在闭包内)。
  // 与 `assertPermissionCodeCreatable` 同型且**刻意**:端点保留是为了给出一个明确的
  // 「不能这么干,该去哪」,而不是静默接受一次什么都不会发生的写入。
  private assertSeedPermissionUpdatable(code: string): void {
    if (isSeedPermissionCode(code)) {
      throw new BizException(BizCode.SEED_PERMISSION_UPDATE_FORBIDDEN);
    }
  }

  // ============ 4 端点业务逻辑 ============

  async list(
    user: CurrentUserPayload,
    query: ListPermissionsQueryDto,
  ): Promise<PageResultDto<PermissionResponseDto>> {
    await this.assertCanOrThrow(user, 'rbac.permission.read');
    const { page, pageSize, module, resourceType } = query;
    const where: Prisma.PermissionWhereInput = {
      ...(module !== undefined ? { module } : {}),
      ...(resourceType !== undefined ? { resourceType } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.permission.findMany({
        where,
        select: permissionSelect,
        // 默认排序:createdAt DESC
        // (沿 baseline §3.2 + docs/reference/response-pagination-errors.md §4)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.permission.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  // P1-32 PR 2(冻结稿 §9.1):权限目录只读投影。
  //
  // **复用 `rbac.permission.read`,不新增权限码** —— 目录与 `GET /permissions` 是同一份
  // 权限定义的两种呈现(一份给机器分页、一份给人按业务区分组),读它们该不该被允许
  // 是同一个问题。新增一条码的连坐面(seed + fixture 独立子集 + selftest 基线 + 四份生成物)
  // 换不来任何判权粒度。
  //
  // 判权之后零查询:目录是代码事实,构造逻辑在 permission-catalog.presenter.ts(纯函数)。
  async catalog(user: CurrentUserPayload): Promise<PermissionCatalogResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.permission.read');
    return buildPermissionCatalog();
  }

  async create(
    user: CurrentUserPayload,
    dto: CreatePermissionDto,
    meta: AuditMeta,
  ): Promise<PermissionResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.permission.create');
    // 1. 显式格式校验(30008)
    this.assertCodeFormatValid(dto.code);

    // 1.5 目录护栏:闭包外的码不得凭空造(30106)。放在格式校验之后、查库之前 ——
    //     格式都不对的码先按 30008 回,不必扯到目录;而目录判定不需要查库。
    this.assertPermissionCodeCreatable(dto.code);

    // 2. 预检查 code 唯一性,提供 user-friendly 30002(P2002 兜底处理并发)
    const existing = await this.prisma.permission.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.PERMISSION_CODE_ALREADY_EXISTS);
    }

    // 3. 写入 + audit(单事务原子;P2002 兜底)。第三轮 review §F&A-2:授权配置写面留痕。
    return this.runCodeUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.permission.create({
          data: {
            code: dto.code,
            module: dto.module,
            action: dto.action,
            resourceType: dto.resourceType,
            description: dto.description,
          },
          select: permissionSelect,
        });
        await writeConfigAudit(tx, {
          event: 'permission.create',
          actor: user,
          resourceType: 'permission',
          resourceId: created.id,
          meta,
          after: {
            code: created.code,
            module: created.module,
            action: created.action,
            resourceType: created.resourceType,
          },
        });
        return created;
      }),
    );
  }

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdatePermissionDto,
    meta: AuditMeta,
  ): Promise<PermissionResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.permission.update');
    // 1. 先确认存在(30001);顺带取 before 快照。
    const before = await this.findByIdOrThrow(id);

    // 2. 目录护栏:闭包内的码禁运行时改写(30110)。放在存在性检查**之后** ——
    //    不存在的 id 应当继续得到 30001,不该被这道闸抢答成 30110。
    this.assertSeedPermissionUpdatable(before.code);

    // 3. 更新 + audit(单事务;仅允许 description;DTO 层已白名单 + ValidationPipe forbidNonWhitelisted 兜底)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.permission.update({
        where: { id },
        data: { description: dto.description },
        select: permissionSelect,
      });
      await writeConfigAudit(tx, {
        event: 'permission.update',
        actor: user,
        resourceType: 'permission',
        resourceId: id,
        meta,
        before: { description: before.description },
        after: { description: updated.description },
      });
      return updated;
    });
  }

  async delete(
    user: CurrentUserPayload,
    id: string,
    meta: AuditMeta,
  ): Promise<PermissionResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.permission.delete');
    // 1. 先确认存在(30001)
    const existing = await this.findByIdOrThrow(id);

    // 1.5 目录护栏:seed 事实闭包内的码不可删(30105)。
    //     次序刻意「先存在性、后护栏」—— 删一个根本不存在的 id 仍返 30001,
    //     不因为护栏而把「不存在」误报成「被保护」。
    this.assertSeedPermissionDeletable(existing.code);

    // 2. 物理删 + audit(单事务;D4 v1.0:Permission 物理删,无 deletedAt;
    //    RolePermission FK Cascade 自动联级清理 — 沿 schema 设计)
    return this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line no-restricted-syntax -- 权限码是控制面配置而非业务数据,删码即撤销;软删码会被 rbac 误读
      await tx.permission.delete({ where: { id } });
      await writeConfigAudit(tx, {
        event: 'permission.delete',
        actor: user,
        resourceType: 'permission',
        resourceId: id,
        meta,
        before: {
          code: existing.code,
          module: existing.module,
          action: existing.action,
          resourceType: existing.resourceType,
        },
      });
      return existing;
    });
  }
}
