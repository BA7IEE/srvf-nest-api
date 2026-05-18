import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { permissionSelect } from './permissions.select';
import { RbacService } from './rbac.service';
import {
  CreateRbacRoleDto,
  ListRbacRolesQueryDto,
  RbacRoleDetailResponseDto,
  RbacRoleResponseDto,
  UpdateRbacRoleDto,
} from './rbac-roles.dto';
import { rbacRoleSelect } from './rbac-roles.select';

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块业务逻辑。
// 沿 D7 v1.1 §4.1 / §5.1 端点 5-9 / §12.1 / D4 v1.0 软删决议。
//
// **F7 v1.0 code 格式正则**(沿 D7 §5.2.2):`/^[a-z][a-z0-9-]{2,32}$/`
// 首字母小写 + 后续 [a-z0-9-]{2,32};总长 3-33。
// 校验失败抛 BizException(BizCode.INVALID_ROLE_CODE_FORMAT)(30009)。
const CODE_PATTERN = /^[a-z][a-z0-9-]{2,32}$/;

type SafeRbacRole = Prisma.RbacRoleGetPayload<{ select: typeof rbacRoleSelect }>;

@Injectable()
export class RbacRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-1:RBAC 元接口判权(沿 attachments F5 v1.0 范本)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 30005 vs 30003 区分(沿用户拍板):
  // - GET /:id 用本 helper:
  //   - 完全不存在 id → throw 30003 ROLE_NOT_FOUND
  //   - 存在但 deletedAt != null → throw 30005 ROLE_DELETED(410 Gone)
  // - PATCH / DELETE /:id 不用本 helper,改用 findActiveByIdOrThrow(统一返 30003,信息泄漏防御)
  private async findByIdForDetailOrThrow(id: string): Promise<SafeRbacRole> {
    // 先 findUnique 不带过滤(包含软删历史),区分"不存在" vs "已删"
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id },
      select: { ...rbacRoleSelect, deletedAt: true },
    });
    if (!raw) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (raw.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    // 剥除 deletedAt 字段(对外 select 不返)
    const { deletedAt, ...safe } = raw;
    void deletedAt;
    return safe;
  }

  // PATCH / DELETE 路径:活跃(未软删)的查询;不存在或已软删统一抛 30003。
  // 沿 v1 §10 / CLAUDE.md §10:访问已软删资源统一表现为不存在,防止信息泄漏。
  private async findActiveByIdOrThrow(id: string): Promise<SafeRbacRole> {
    const found = await this.prisma.rbacRole.findFirst({
      where: notDeletedWhere({ id }),
      select: rbacRoleSelect,
    });
    if (!found) throw new BizException(BizCode.ROLE_NOT_FOUND);
    return found;
  }

  // P2002 兜底 — DTO @MaxLength + Service findUnique 预检查应已拦绝大多数,
  // 这层处理并发场景(两个 create 同时撞 code unique;含软删历史 — schema unique 不区分 deletedAt)。
  private async runCodeUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('code')) {
          throw new BizException(BizCode.ROLE_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // F7 v1.0 code 格式校验 — 显式 regex 检查,失败抛 30009。
  // **不放在 DTO @Matches**:让本 BizCode 真正可触发并被 e2e 覆盖
  // (DTO @Matches 失败会走通用 BAD_REQUEST 40000,30009 永远不触发)。
  private assertCodeFormatValid(code: string): void {
    if (!CODE_PATTERN.test(code)) {
      throw new BizException(BizCode.INVALID_ROLE_CODE_FORMAT);
    }
  }

  // ============ 5 端点业务逻辑 ============

  async list(
    user: CurrentUserPayload,
    query: ListRbacRolesQueryDto,
  ): Promise<PageResultDto<RbacRoleResponseDto>> {
    await this.assertCanOrThrow(user, 'rbac.role.read');
    const { page, pageSize, code } = query;
    // 列表默认排除软删(沿 v1 §10 / baseline §10);code 过滤走 contains(模糊匹配)
    const where: Prisma.RbacRoleWhereInput = notDeletedWhere(
      code !== undefined ? { code: { contains: code } } : {},
    );

    const [items, total] = await this.prisma.$transaction([
      this.prisma.rbacRole.findMany({
        where,
        select: rbacRoleSelect,
        // 默认排序:createdAt DESC(沿 baseline §3.2 + CLAUDE.md §4)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.rbacRole.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async findOne(user: CurrentUserPayload, id: string): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role.read');
    // 1. 查角色(区分 30003 / 30005)
    const role = await this.findByIdForDetailOrThrow(id);

    // 2. 查已分配的权限点列表(沿 D7 §5.2.6 detail 接口额外含 permissions)。
    //    RolePermission CRUD 尚未实施(留 PR #4),所以这里查到的永远空数组,
    //    但 contract 字段稳定 — 前端可一致依赖 permissions: PermissionResponseDto[]。
    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: id },
      select: {
        permission: { select: permissionSelect },
      },
      orderBy: { createdAt: 'asc' },
    });
    const permissions = rolePermissions.map((rp) => rp.permission);

    return { ...role, permissions };
  }

  async create(user: CurrentUserPayload, dto: CreateRbacRoleDto): Promise<RbacRoleResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role.create');
    // 1. 显式格式校验(30009)
    this.assertCodeFormatValid(dto.code);

    // 2. 预检查 code 唯一性(**含软删历史** — sched unique 不区分 deletedAt,沿 v1 §10
    //    "软删后 username / email 不复用"范式),提供 user-friendly 30004。
    //    用 findUnique(不带 notDeletedWhere)确保撞软删历史也能精准报错。
    const existing = await this.prisma.rbacRole.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ROLE_CODE_ALREADY_EXISTS);
    }

    // 3. 写入(P2002 兜底处理并发场景)
    return this.runCodeUniqueGuard(() =>
      this.prisma.rbacRole.create({
        data: {
          code: dto.code,
          displayName: dto.displayName,
          description: dto.description,
        },
        select: rbacRoleSelect,
      }),
    );
  }

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateRbacRoleDto,
  ): Promise<RbacRoleResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role.update');
    // 1. 先确认活跃(不存在 + 已软删都返 30003,沿 v1 §10 信息泄漏防御)
    await this.findActiveByIdOrThrow(id);

    // 2. 更新(仅允许 displayName / description;DTO 层已白名单 +
    //    ValidationPipe forbidNonWhitelisted 兜底)
    return this.prisma.rbacRole.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        description: dto.description,
      },
      select: rbacRoleSelect,
    });
  }

  async softDelete(user: CurrentUserPayload, id: string): Promise<RbacRoleResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role.delete');
    // 1. 先确认活跃(不存在 + 已软删都返 30003)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. 软删(D4 v1.0;沿 v1 §10:update deletedAt = new Date();
    //    user_roles / role_permissions 不联动,沿 D7 §6.3 "最后一个运营管理员保护" 决策)
    //
    //    **不实装 deletedByUserId**(沿用户拍板方案 A;schema + D7 v1.1 均无此字段;
    //    删除责任后续由 audit_logs 的 rbac.role.delete 事件 + actorUserId 记录)
    await this.prisma.rbacRole.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return existing;
  }
}
