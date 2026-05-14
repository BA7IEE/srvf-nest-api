import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  CreatePermissionDto,
  ListPermissionsQueryDto,
  PermissionResponseDto,
  UpdatePermissionDto,
} from './permissions.dto';
import { permissionSelect } from './permissions.select';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块业务逻辑。
// 沿 D7 v1.1 §4.2 / §5.1 / §12.1。
//
// **D2 v1.0 code 格式正则**(沿 D7 §5.2.1):
// `<module>.<action>.<resource_type>` — kebab-case 三段点分隔;
// 每段:首字母小写 + 后续 [a-z0-9-] 任意长度;三段间用 `.` 严格分隔。
// 校验失败抛 BizException(BizCode.INVALID_PERMISSION_CODE_FORMAT)(30008)。
const CODE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$/;

type SafePermission = Prisma.PermissionGetPayload<{ select: typeof permissionSelect }>;

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============ helpers ============

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

  // ============ 4 端点业务逻辑 ============

  async list(query: ListPermissionsQueryDto): Promise<PageResultDto<PermissionResponseDto>> {
    const { page, pageSize, module, resourceType } = query;
    const where: Prisma.PermissionWhereInput = {
      ...(module !== undefined ? { module } : {}),
      ...(resourceType !== undefined ? { resourceType } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.permission.findMany({
        where,
        select: permissionSelect,
        // 默认排序:createdAt DESC(沿 baseline §3.2 + CLAUDE.md §4 分页默认)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.permission.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(dto: CreatePermissionDto): Promise<PermissionResponseDto> {
    // 1. 显式格式校验(30008)
    this.assertCodeFormatValid(dto.code);

    // 2. 预检查 code 唯一性,提供 user-friendly 30002(P2002 兜底处理并发)
    const existing = await this.prisma.permission.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.PERMISSION_CODE_ALREADY_EXISTS);
    }

    // 3. 写入(P2002 兜底)
    return this.runCodeUniqueGuard(() =>
      this.prisma.permission.create({
        data: {
          code: dto.code,
          module: dto.module,
          action: dto.action,
          resourceType: dto.resourceType,
          description: dto.description,
        },
        select: permissionSelect,
      }),
    );
  }

  async update(id: string, dto: UpdatePermissionDto): Promise<PermissionResponseDto> {
    // 1. 先确认存在(30001)
    await this.findByIdOrThrow(id);

    // 2. 更新(仅允许 description;DTO 层已白名单 + ValidationPipe forbidNonWhitelisted 兜底)
    return this.prisma.permission.update({
      where: { id },
      data: { description: dto.description },
      select: permissionSelect,
    });
  }

  async delete(id: string): Promise<PermissionResponseDto> {
    // 1. 先确认存在(30001)
    const existing = await this.findByIdOrThrow(id);

    // 2. 物理删(D4 v1.0:Permission 物理删,无 deletedAt;
    //    RolePermission FK Cascade 自动联级清理 — 沿 schema 设计)
    await this.prisma.permission.delete({ where: { id } });
    return existing;
  }
}
