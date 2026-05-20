import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { AttendanceRecordResponseDto, MyAttendanceRecordsQueryDto } from './attendances.dto';
import { AttendancesService } from './attendances.service';
import { AppMyAttendanceRecordDto } from './dto/app/app-my-attendance-record.dto';
import { ListAppMyAttendanceRecordsQueryDto } from './dto/app/list-app-my-attendance-records-query.dto';

// Phase 2 P2-6 App /api/app/v1/my/attendance-records 薄壳 service。
// 沿 docs/app-api-p2-6-attendance-records-review.md §7 + D-P2-6-2 / D-P2-6-6 / D-P2-6-14:
//   controller → 薄壳 service → 既有 AttendancesService.listMyRecords(thin-wrap)
//
// 职责(沿 §7.1 + §7.4):
//   1. 准入:AppIdentityResolver.resolve + assertCanUseAppOrThrow
//      (canUseApp=false 统一 FORBIDDEN=40300;沿 §8.1 + §8.2)
//   2. thin-wrap 既有 AttendancesService.listMyRecords(签名 0 diff)
//   3. AppMy service 内 2 次 IN 批量自查:
//        - prisma.attendanceSheet.findMany(where: { id: in sheetIds }) 拿 sheetId→activityId
//        - prisma.activity.findMany(where: { id: in activityIds }) 拿派生字段
//      (沿 P2-5a app-my-registrations.service.ts:76-87 范式;**不**改 attendances.service.ts)
//   4. 私有静态 mapper:Admin DTO 字段集 → App DTO 字段集
//      (沿 §5.1 严格白名单 14 项;沿 §7.3)
//
// 铁律(沿 §7.4 + §11.1):
//   - **不**改 attendances.service.ts(沿 D-P2-6-2;完全禁修改)
//   - **不**新增 listMyRecordsRaw 或任何 service method
//   - **不**复刻 listMyRecords 内 where 子句(双权威源漂移)
//   - admin-as-member 走 linked-member self perspective(沿 D-P2-6-13);
//     既有 listMyRecords 内 resolveUserMemberIdOrThrow 用 currentUser.id 锁本人,
//     **禁止** role 短路 / 接收 query memberId(DTO 严格白名单已挡)
//   - 派生 activity 字段必须批量 IN,**禁止** N+1(沿 D-P2-6-6)
//
// 例外退路(沿 §7.4):如发现 listMyRecords 出参 + AppMy 自查无法支撑 §5.1 字段集
// (因 sheetId 三处稳定,理论不应发生),**必须**暂停回到对话,由用户拍板是否
// 新开 v0.2 评审稿解锁 listMyRecordsRaw 或调整字段集。**禁止**自行解锁。
@Injectable()
export class AppMyAttendanceRecordsService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly attendances: AttendancesService,
    private readonly prisma: PrismaService,
  ) {}

  // ============ GET /api/app/v1/my/attendance-records(P2-6)============

  async listMyAttendanceRecords(
    query: ListAppMyAttendanceRecordsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyAttendanceRecordDto>> {
    await this.assertCanUseAppOrThrow(currentUser);

    // thin-wrap 既有 AttendancesService.listMyRecords(签名 0 diff;沿 D-P2-6-2)。
    // admin DTO 出参字段集恰好满足派生需要(sheetId 三处稳定输出:DTO declaration /
    // recordWithMemberSelect / toRecordResponseDto;沿评审稿 §7.3)。
    const adminQuery: MyAttendanceRecordsQueryDto = {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.activityId !== undefined ? { activityId: query.activityId } : {}),
    };
    const result = await this.attendances.listMyRecords(adminQuery, currentUser);

    if (result.items.length === 0) {
      return { items: [], total: result.total, page: result.page, pageSize: result.pageSize };
    }

    // AppMy 内单次 IN 拿 sheetId → activityId 映射(沿 §7.4 默认方案)。
    // **不**复刻 listMyRecords 内 where 子句;只读 sheet 主键集合。
    // sheet.deletedAt 不过滤:既有 listMyRecords 已过滤 sheet.deletedAt=null,本次
    // IN 查到的 sheet 全部已通过过滤;此处仅取 activityId 派生映射。
    const sheetIds = [...new Set(result.items.map((r) => r.sheetId))];
    const sheets = await this.prisma.attendanceSheet.findMany({
      where: { id: { in: sheetIds } },
      select: AppMyAttendanceRecordsService.sheetSelect,
    });
    const activityIdBySheetId = new Map(sheets.map((s) => [s.id, s.activityId]));

    // AppMy 内单次 IN 拿 Activity 派生字段(沿 §7.4 默认方案 step 3)。
    // Activity.deletedAt 不过滤:onDelete=Restrict FK 保证 activity row 存在;
    // soft-delete 状态下字段仍可读,**不**暴露 deletedAt(沿 P2-5a 同处理)。
    const activityIds = [...new Set([...activityIdBySheetId.values()])];
    const activities =
      activityIds.length === 0
        ? []
        : await this.prisma.activity.findMany({
            where: { id: { in: activityIds } },
            select: AppMyAttendanceRecordsService.activitySelect,
          });
    const activityById = new Map(activities.map((a) => [a.id, a]));

    const items = result.items.map((row) =>
      AppMyAttendanceRecordsService.toAppDto(row, activityIdBySheetId, activityById),
    );

    return { items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  // ============ 内部 helpers ============

  // 沿评审稿 §8.1 / §8.2 准入硬约束:canUseApp=false → FORBIDDEN(40300)
  // (member 未关联 / INACTIVE / 软删 / Admin 无 member 全部统一 403);
  // **不**沿 D-P2-3-1 admin-without-member 例外(沿 D-P2-6-12)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<void> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  // Sheet 派生 select(沿 §7.4 step 2):仅 id + activityId,无其它字段。
  // **不** select:deletedAt / statusCode / submitter / reviewer 等内部字段。
  private static readonly sheetSelect = {
    id: true,
    activityId: true,
  } as const satisfies Prisma.AttendanceSheetSelect;

  // Activity 派生 select(沿 §7.4 step 3):5 字段。
  // **不** select:description / capacity / registrationDeadline / registrationNotes /
  // organizationId / 任何 audit / publishedBy* / cancelledBy* / deletedAt / statusCode。
  private static readonly activitySelect = {
    id: true,
    title: true,
    startAt: true,
    endAt: true,
    coverImageUrl: true,
  } as const satisfies Prisma.ActivitySelect;

  // 私有 mapper(沿 §6.4 + §7.3 + P2-5 P0/P1 过渡;不抽独立 Presenter class)。
  // **删除** admin DTO 字段:sheetId / memberId / member 嵌套 / registrationId / updatedAt
  // (沿 §5.2 默认锁定 + §7.3 字段集)。
  // **追加** 派生字段:activityId / activityTitle / activityStartAt / activityEndAt /
  // activityCoverImageUrl(沿 §5.1 D-P2-6-6)。
  // 入参类型为既有 admin AttendanceRecordResponseDto(沿 §7.3 三处稳定;含 sheetId /
  // serviceHours: string / contributionPoints: string | null)。
  private static toAppDto(
    row: AttendanceRecordResponseDto,
    activityIdBySheetId: Map<string, string>,
    activityById: Map<
      string,
      Prisma.ActivityGetPayload<{
        select: typeof AppMyAttendanceRecordsService.activitySelect;
      }>
    >,
  ): AppMyAttendanceRecordDto {
    const activityId = activityIdBySheetId.get(row.sheetId) ?? '';
    const act = activityById.get(activityId);
    return {
      id: row.id,
      activityId,
      activityTitle: act?.title ?? '',
      activityStartAt: act?.startAt ?? row.checkInAt,
      activityEndAt: act?.endAt ?? row.checkOutAt,
      activityCoverImageUrl: act?.coverImageUrl ?? null,
      roleCode: row.roleCode,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      serviceHours: row.serviceHours, // 已是 string(admin DTO 内序列化)
      attendanceStatusCode: row.attendanceStatusCode,
      note: row.note,
      contributionPoints: row.contributionPoints, // 已是 string | null
      createdAt: row.createdAt,
    };
  }
}
