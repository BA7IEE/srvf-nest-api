import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { PermissionResponseDto } from './permissions.dto';
import { RbacRoleDetailResponseDto, RbacRoleResponseDto } from './rbac-roles.dto';
import {
  AssignRolePermissionsDto,
  ReplaceRolePermissionsDto,
  RevokeRolePermissionParamDto,
  RolePermissionDiffItemDto,
  RolePermissionPreviewIssueDto,
  RolePermissionPreviewOutcomeDto,
  RolePermissionPreviewResponseDto,
  RolePermissionSetEditPolicyDto,
  RolePermissionSetResponseDto,
  RolePermissionSetRoleDto,
} from './role-permissions.dto';
import { RolePermissionsService } from './role-permissions.service';

// 从 @Req() 构造 AuditMeta(沿 user-roles.controller 范式)。第三轮 review §F&A-2:
// 角色权限点授予/撤销写 audit(resourceType='role_permission')。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表 Controller。
// 5 个端点(沿 D7 v1.1 §5.1 端点 10-11 + P1-32 PR 4a + 4b):
//   GET    /api/system/v1/roles/:id/permissions       取当前权限集(4b;冻结稿 §9.2)
//   POST   /api/system/v1/roles/:id/permissions       批量授权(幂等,增量)
//   PUT    /api/system/v1/roles/:id/permissions       整集替换(带 expectedRevision 乐观并发)
//   POST   /api/system/v1/roles/:id/permissions/preview  变更预览(4b;冻结稿 §9.3,零写入)
//   DELETE /api/system/v1/roles/:id/permissions/:permissionId  撤权(精确)
//
// ─── P1-32 PR 4b(2026-08-24):读 / 预览面 ─────────────────────────────────
//
// 🔴 **preview 与 PUT 的准入判定是同一段代码的同一次执行。**
//    两者都只调 `RolePermissionsService.runReplaceSet()`,唯一差别是最后一个参数:
//    传 `AuditMeta` = 真写,传 `null` = dry-run(走完全部判定后零写入)。
//    ⇒ 「预览说能过、真 PUT 拒绝」(或反过来)**结构上不可能** —— 那种不一致没有任何症状,
//    是这一刀真正要消灭的东西。执行位:`scripts/check-role-permission-read-preview.ts`
//    + 薄运行器 `role-permission-read-preview.criteria.spec.ts`。
//
// 🔴 **零新增权限码**:
//    · `GET` 复用 `rbac.role.read` —— `GET /roles/:id` 拿同一条码,而它今天就已经返回
//      完整 `permissions[]` ⇒ 新端点暴露面 ⊆ 既有暴露面,判权粒度一点没变。
//    · `preview` 复用 `rbac.role-permission.{create,delete}` + `require:'all'`,**与 PUT 逐字相同**
//      —— 「能预览 ⟺ 能真改」,多一条可被判据钉住的同源轴。
//      ⚠️ 刻意**不**照抄 `role-bindings/preview` 的选择(那条用 read 码):那条是 `GET`+query、
//      预检一条**还不存在**的绑定;本条是 `POST`+**与 PUT 同一个 DTO**,路由闸也相同才自洽。
//
// ⚠️ **分页**:`GET` 返回的是**一个对象**(`{role, permissionRevision, permissionCodes[], editPolicy}`,
//    冻结稿 §9.2 逐字形状),不是集合端点 ⇒ 分页铁律(入参 `PaginationQueryDto` / 出参
//    `PageResultDto`)没有适用对象,和 `GET /roles/:id` 返回 `permissions[]` 是同一形状。
//    **也因此不进** `docs/reference/response-pagination-errors.md` §4 那张「整取型只读目录」表:
//    那张表要求「固定参考集合」,而角色权限集的内容是运行时数据 —— 往表里加行等于替它做一个假声明。
//    条数上界仍由**代码事实**兜住:|Permission| ≤ 目录条目数,而 `permission-catalog.ts` 在红区,
//    运行时造不出目录外的 Permission 行(`POST /permissions` 对闭包外的码返 30106)。
//
// ⚠️ **划给 PR 5 的四项(冻结稿 `## PR 5` = 影响预览与 Step-up,本刀一条都不做)**:
//    ① `impact{activeDirectBindingCount / activeDerivedGrantCount / estimatedAffectedUserCount /
//       scopeBreakdown / sources{roleBinding,positionPolicy,supervision}}` —— PR 5 第一项逐字
//       「direct/position/supervision 影响统计」;
//    ② `requiresStepUp` 与 step-up proof —— PR 5 第二、三项;
//    ③ `catalogHash` —— 它的用途是给预览结论**绑版本当证明**,而冻结稿 §2.8 标题就是
//       「预览不是授权证明」,本刀的证明机制是 4a 的 `expectedRevision`;它随 proof 一起进 PR 5;
//    ④ §9.2 `editPolicy` 里的 `addBlocked[]` / `removeBlocked[]`(「哪些码**你**加不了 / 撤不了」)
//       —— 那是把控制面两层闸(含授撤方向不对称)重新表达一遍,同 preview 的第二份真相形状;
//       要做得先把 `assertControlPlaneCodesOrThrow` 拆成 per-code verdict 让两侧共用,属改写路径。
//
// 三条**写**契约互不相同,但**内部只有一条写原语**(RolePermissionsService
// .replaceRolePermissionSet)—— 见该 service 头部「三条端点、一条写原语」。
// 4b 的 preview 走同一条原语的 dry-run 分支 ⇒ 「会发生什么」这个问题全仓只有一处答案。
//
// **路径参数语义**(沿 D7 v1.1 §5.1):
// - `:id` = roleId(cuid 字符串)
// - `:permissionId` = permission.id(cuid 字符串;**不**是 permission.code;
//   有意设计:POST 批量授权用 codes 易读,DELETE 单条撤权用 id 精确)
//
// **出参**:三条**写**端点统一返 RbacRoleDetailResponseDto(沿 RbacRole detail 接口),
// 调用者一次拿到该角色当前完整 permissions 列表,前端"保存当前选中"语义友好。
// P1-32 PR 4a 起该 DTO additive 多一个 `permissionRevision`,前端拿回来直接用于下一次 PUT。
//
// **权限标注**(P0-F PR-1,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 RolePermissionsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 attachments F3 v1.0 范本。
// 映射 seed 现有 2 条权限点:rbac.role-permission.{create,delete}。

@ApiTags('Ops - Role Permissions')
@ApiBearerAuth()
@ApiExtraModels(
  RbacRoleResponseDto,
  RbacRoleDetailResponseDto,
  PermissionResponseDto,
  RolePermissionSetResponseDto,
  RolePermissionSetRoleDto,
  RolePermissionSetEditPolicyDto,
  RolePermissionPreviewResponseDto,
  RolePermissionPreviewOutcomeDto,
  RolePermissionPreviewIssueDto,
  RolePermissionDiffItemDto,
)
@Controller('system/v1/roles/:id/permissions')
export class RolePermissionsController {
  constructor(private readonly service: RolePermissionsService) {}

  // P1-32 PR 4b(冻结稿 §9.2):取角色当前权限集。复用 `rbac.role.read`,零新增权限码。
  //
  // ⚠️ 内建角色**读得到**(不返 30108)—— 「能不能改」由 `editPolicy` 以数据形态回答。
  //    只判存在 / 未软删两态(30003 / 30005),与 `GET /roles/:id` 同口径。
  @Get()
  @RequiresPermission('rbac.role.read')
  @ApiOperation({
    summary:
      '取角色当前权限集(只读;返回角色摘要 + 权限集版本号 permissionRevision + 已排序去重的 permissionCodes[] + editPolicy〔canEdit / readOnlyReason〕;内建角色照样读得到,只是 canEdit=false;角色不存在返 30003、已软删返 30005;**单资源读面不分页**) [rbac: rbac.role.read]',
  })
  @ApiWrappedOkResponse(RolePermissionSetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
  )
  findPermissionSet(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<RolePermissionSetResponseDto> {
    return this.service.findPermissionSet(user, params.id);
  }

  @Post()
  @RequiresPermission('rbac.role-permission.create')
  @ApiOperation({
    summary:
      '批量给角色加权限点(幂等:已存在的 (roleId, permissionId) 静默跳过;入参 permissionCodes[],非 ids;控制面码非 SUPER_ADMIN 不可分配返 30103;7 条 SA-only 保留码任何身份都不可授予角色返 30109;系统内置角色只读返 30108) [rbac: rbac.role-permission.create]',
  })
  @ApiWrappedCreatedResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY,
    BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
  )
  assign(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: AssignRolePermissionsDto,
    @Req() req: Request,
  ): Promise<RbacRoleDetailResponseDto> {
    return this.service.assign(user, params.id, dto, buildAuditMeta(req));
  }

  // P1-32 PR 4a(2026-08-23):整集替换。
  // **两个码 + require: 'all'** —— 一次替换可能同时授与撤:只拿 create 就能撤权、
  // 只拿 delete 就能授权,两种都是把另一半闸绕过去。Service 侧对应两次 rbac.can()。
  //
  // summary 的鉴权后缀写成通配族 `[rbac: rbac.role-permission.*]` 而不是单码:
  // check-rbac-map 的 G 校验只认「单码」或「`<family>.*` 通配族」两种形态,而本端点
  // 要的**恰好是这一族的全部两条**(该族在 seed 闭包里就只有 create / delete)。
  // ⚠️ 别为了让判据过而改成任一单码 —— 那会在文档面上少说一半闸;
  //    也别去放宽 check-rbac-map(那是裁判,不该被被测方迁就)。具体两条码写在 summary 正文里。
  @Put()
  @RequiresPermission('rbac.role-permission.create', 'rbac.role-permission.delete', {
    require: 'all',
  })
  @ApiOperation({
    summary:
      '整集替换角色的权限点(提交后恰好是 permissionCodes[];传 [] 清空;必带 expectedRevision 做乐观并发,版本不符返 30111;目标集合与现状相同时空转不写不留痕;控制面码非 SUPER_ADMIN 不可分配返 30103;7 条 SA-only 保留码任何身份都不可授予角色返 30109;系统内置角色只读返 30108;**同时**需要 rbac.role-permission.create 与 rbac.role-permission.delete 两条码,少一条即 30100) [rbac: rbac.role-permission.*]',
  })
  @ApiWrappedOkResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY,
    BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
    BizCode.ROLE_PERMISSION_REVISION_CONFLICT,
  )
  replace(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: ReplaceRolePermissionsDto,
    @Req() req: Request,
  ): Promise<RbacRoleDetailResponseDto> {
    return this.service.replace(user, params.id, dto, buildAuditMeta(req));
  }

  // P1-32 PR 4b(冻结稿 §9.3):变更预览 —— **零写入**,与上面那条 `PUT` 走同一段判定。
  //
  // 🔴 **入参就是 `ReplaceRolePermissionsDto` 本身**(不是「同形状的另一个 DTO」):
  //    预览的对象与将要提交的对象在类型层面是同一件事,字段与校验不可能分家。
  //
  // 🔴 **`POST` 而不是 `GET`**:入参含 `permissionCodes[]`(上限 100 条)+ `expectedRevision`,
  //    塞进 query string 就得自己编数组、还会撞 URL 长度上限。零写入靠 `@HttpCode(200)` +
  //    service 里的 dry-run 分支表达,不靠动词。(`role-bindings/preview` 用 `GET` 是因为
  //    它的入参是一条待建绑定的几个标量字段,进 query 很自然 —— 形状不同,选择不同。)
  //
  // ⚠️ **拦下来是 200 数据不是 HTTP 错误**(冻结稿 §9.3「deny/blocked 作为 200 数据返回」;
  //    仓内同款:`role-bindings/preview` 的 summary 逐字写着「deny 是数据」)。
  //    所以下面的错误码清单**不等于** `PUT` 的那份 —— 30103 / 30108 / 30109 / 30111 / 30001 /
  //    30003 / 30005 全部落进 `blockingIssues[0].bizCode`,与 `PUT` 会抛的**同一个码**。
  //    HTTP 层只剩三件:入参不合法、未登录、路由闸拒(那是本端点自己的准入,不是变更的判定)。
  //
  // ⚠️ `blockingIssues` 长度恒为 0 或 1 —— 写路径 fail-fast,**它不是全量诊断**(见 DTO 说明)。
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('rbac.role-permission.create', 'rbac.role-permission.delete', {
    require: 'all',
  })
  @ApiOperation({
    summary:
      '预览整集替换的后果(dry-run:与 PUT 同参、同一段准入判定、同一把角色行锁,**零写入**;返回 valid / blockingIssues〔恒 0 或 1 条,不是全量诊断〕/ outcome〔noOp、currentRevision、nextRevision 预测值、added·removed 带中文名与风险等级、unchangedCount、resultCodes〕;被拦下时 valid=false 且拒绝码与 PUT 抛出的**同一个**,走 200 数据不走 HTTP 错误;预览不是授权证明,真提交仍在锁内重算并可返 30111;**同时**需要 rbac.role-permission.create 与 rbac.role-permission.delete 两条码,与 PUT 逐字相同) [rbac: rbac.role-permission.*]',
  })
  @ApiWrappedOkResponse(RolePermissionPreviewResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  previewReplace(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: ReplaceRolePermissionsDto,
  ): Promise<RolePermissionPreviewResponseDto> {
    return this.service.previewReplace(user, params.id, dto);
  }

  @Delete(':permissionId')
  @RequiresPermission('rbac.role-permission.delete')
  @ApiOperation({
    summary:
      '撤销角色的某个权限点(精确路径 :permissionId 是 permission.id 非 code;关系不存在返 30011;控制面码仅 SUPER_ADMIN 可撤返 30103;系统内置角色只读返 30108) [rbac: rbac.role-permission.delete]',
  })
  @ApiWrappedOkResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.ROLE_PERMISSION_NOT_FOUND,
    BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
  )
  revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: RevokeRolePermissionParamDto,
    @Req() req: Request,
  ): Promise<RbacRoleDetailResponseDto> {
    return this.service.revoke(user, params.id, params.permissionId, buildAuditMeta(req));
  }
}
