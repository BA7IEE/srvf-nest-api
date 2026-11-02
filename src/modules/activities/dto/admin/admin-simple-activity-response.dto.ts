import { ApiProperty } from '@nestjs/swagger';
import { AdminSimpleActivityInstanceDto } from './admin-simple-activity.dto';
import { AdminSimpleActivityPlaceDto } from './admin-simple-activity-place.dto';

export class AdminSimpleOrganizationOptionDto {
  @ApiProperty({ description: '有权发起组织 ID' }) organizationId!: string;
  @ApiProperty({ description: '组织名称' }) name!: string;
  @ApiProperty({ description: '组织路径文字' }) pathLabel!: string;
  @ApiProperty({ description: '发起资格来源', enum: ['membership', 'cross-org-grant'] })
  source!: string;
  @ApiProperty({
    description: '有效任职种类；跨组织授权时可空',
    type: String,
    nullable: true,
    enum: ['PRIMARY', 'SECONDARY', 'TEMPORARY', 'SUPPORT'],
  })
  membershipType!: string | null;
}

export class AdminSimpleTemplateFamilyOptionDto {
  @ApiProperty({ description: '全局模板族 ID' }) id!: string;
  @ApiProperty({ description: '模板族稳定编码' }) code!: string;
  @ApiProperty({ description: '模板族名称' }) name!: string;
  @ApiProperty({ description: '模板分类码' }) categoryCode!: string;
}

/** Physical Admin projection; the source query and its 13-field whitelist are shared. */
export class AdminSimpleTemplateVersionOptionDto {
  @ApiProperty({ description: '精确模板版本 ID' }) id!: string;
  @ApiProperty({ description: '模板稳定编码' }) code!: string;
  @ApiProperty({ description: '模板版本名称' }) name!: string;
  @ApiProperty({ description: '显式版本号', minimum: 1 }) version!: number;
  @ApiProperty({ description: '定义 schema 版本', enum: [1, 2, 3, 4, 5] }) schemaVersion!: number;
  @ApiProperty({ description: '精确版本 hash', pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty({ description: '当前可新选版本', enum: ['active'] }) statusCode!: string;
  @ApiProperty({ description: '活动类型码' }) activityTypeCode!: string;
  @ApiProperty({ description: '模板族安全摘要', type: () => AdminSimpleTemplateFamilyOptionDto })
  family!: AdminSimpleTemplateFamilyOptionDto;
  @ApiProperty({ description: '有效期元数据起点', type: String, format: 'date-time' })
  effectiveFrom!: string;
  @ApiProperty({
    description: '有效期元数据终点',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  effectiveTo!: string | null;
  @ApiProperty({ description: '创建时间', type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: '更新时间', type: String, format: 'date-time' }) updatedAt!: string;
}

export class AdminSimpleActivityCreationResultDto {
  @ApiProperty({ description: '创建所得活动 ID' }) activityId!: string;
  @ApiProperty({ description: '首次创建时间', type: String, format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ description: '首次创建时状态，不代表当前发布状态', enum: ['draft'] })
  createdStatusCode!: string;
  @ApiProperty({ description: '是否复用同一成功创建命令' }) replayed!: boolean;
}

export class AdminSimpleDraftReviewDto {
  @ApiProperty({ description: '最新审核 ID' }) id!: string;
  @ApiProperty({
    description: '真实审核状态',
    enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'],
  })
  status!: string;
  @ApiProperty({ description: '审核类型', enum: ['initial', 'change'] }) requestType!: string;
}

export class AdminSimpleDraftSessionDto {
  @ApiProperty({ description: '唯一场次 ID' }) id!: string;
  @ApiProperty({ description: '稳定场次编码' }) code!: string;
  @ApiProperty({ description: '场次名称' }) name!: string;
  @ApiProperty({ description: '场次开始', format: 'date-time' }) startAt!: string;
  @ApiProperty({ description: '场次结束', format: 'date-time' }) endAt!: string;
  @ApiProperty({ description: '本次容量；null 不限', type: Number, nullable: true }) capacity!:
    | number
    | null;
  @ApiProperty({ description: '签到开放', format: 'date-time' }) checkInOpenAt!: string;
  @ApiProperty({ description: '签到关闭', format: 'date-time' }) checkInCloseAt!: string;
  @ApiProperty({ description: '签退开放', format: 'date-time' }) checkOutOpenAt!: string;
  @ApiProperty({ description: '签退关闭', format: 'date-time' }) checkOutCloseAt!: string;
  @ApiProperty({ description: '准备时间', type: String, format: 'date-time', nullable: true })
  preparationStartAt!: string | null;
}

export class AdminSimpleDraftPositionDto {
  @ApiProperty({ description: '唯一默认岗位 ID' }) id!: string;
  @ApiProperty({ description: '稳定岗位编码' }) code!: string;
  @ApiProperty({ description: '岗位名称' }) name!: string;
  @ApiProperty({ description: '现有 attendance role 字典编码' }) attendanceRoleCode!: string;
  @ApiProperty({ description: '本次容量；null 不限', type: Number, nullable: true }) capacity!:
    | number
    | null;
  @ApiProperty({
    description: '显式开始；null 继承场次',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  startAt!: string | null;
  @ApiProperty({
    description: '显式结束；null 继承场次',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  endAt!: string | null;
}

export class AdminSimpleDraftPolicyDto {
  @ApiProperty({ description: '政策种类', enum: ['time', 'contribution'] }) kind!: string;
  @ApiProperty({ description: '选定层级', enum: ['activity', 'session', 'position', 'template'] })
  layerCode!: string;
  @ApiProperty({ description: '原政策选择模式，不接受通过草稿命令修改' }) mode!: string;
  @ApiProperty({ description: '政策名称', type: String, nullable: true }) name!: string | null;
  @ApiProperty({ description: '精确版本号', type: Number, nullable: true }) version!: number | null;
  @ApiProperty({ description: '政策覆盖起点', type: String, format: 'date-time', nullable: true })
  effectiveFrom!: string | null;
  @ApiProperty({ description: '政策覆盖终点', type: String, format: 'date-time', nullable: true })
  effectiveUntil!: string | null;
}

export class AdminSimpleDraftResponseDto {
  @ApiProperty({ description: '活动 ID' }) activityId!: string;
  @ApiProperty({ description: '服务端活动标题' }) title!: string;
  @ApiProperty({ description: '承办组织 ID' }) organizationId!: string;
  @ApiProperty({ description: '原活动类型' }) activityTypeCode!: string;
  @ApiProperty({ description: '首版固定先到先得', enum: ['first_come'] })
  allocationModeCode!: string;
  @ApiProperty({ description: '活动开始', format: 'date-time' }) startAt!: string;
  @ApiProperty({ description: '活动结束', format: 'date-time' }) endAt!: string;
  @ApiProperty({ description: '最终主地点文字' }) location!: string;
  @ApiProperty({ description: '最终实例事实', type: () => AdminSimpleActivityInstanceDto })
  instance!: AdminSimpleActivityInstanceDto;
  @ApiProperty({ description: '实际活动状态' }) statusCode!: string;
  @ApiProperty({
    description: '最新审核；null 尚无审核',
    type: () => AdminSimpleDraftReviewDto,
    nullable: true,
  })
  review!: AdminSimpleDraftReviewDto | null;
  @ApiProperty({ description: '仅当前草稿无待审且模板仍可选时为 true，操作仍重新鉴权' })
  editable!: boolean;
  @ApiProperty({ description: '本次读取的完整并发指纹', pattern: '^[0-9a-f]{64}$' })
  draftHash!: string;
  @ApiProperty({ description: '原精确模板版本 ID' }) selectedTemplateVersionId!: string;
  @ApiProperty({ description: '原精确模板定义摘要', pattern: '^[0-9a-f]{64}$' })
  definitionHash!: string;
  @ApiProperty({ description: '唯一场次最终事实', type: () => AdminSimpleDraftSessionDto })
  session!: AdminSimpleDraftSessionDto;
  @ApiProperty({ description: '唯一默认岗位最终事实', type: () => AdminSimpleDraftPositionDto })
  position!: AdminSimpleDraftPositionDto;
  @ApiProperty({
    description: '同样应用于活动和唯一场次的完整本地地点；读取以 inline 返回',
    type: () => [AdminSimpleActivityPlaceDto],
  })
  places!: AdminSimpleActivityPlaceDto[];
  @ApiProperty({
    description: '原时长/贡献政策的有权安全摘要，不是政策写入口',
    type: () => [AdminSimpleDraftPolicyDto],
  })
  policies!: AdminSimpleDraftPolicyDto[];
}
