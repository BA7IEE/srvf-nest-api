import { ApiProperty } from '@nestjs/swagger';

// App 本人打卡安全视图，字段集冻结为 11 项。严禁继承或映射 Admin DTO。
export class AppActivityCheckInDto {
  @ApiProperty({ description: '打卡证据主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '活动 Activity.id' })
  activityId!: string;

  @ApiProperty({ description: '当前审核通过报名 ActivityRegistration.id' })
  registrationId!: string;

  @ApiProperty({ description: '服务端签到时间(ISO 8601)' })
  checkInAt!: Date;

  @ApiProperty({ description: '服务端首次签退时间(ISO 8601)', nullable: true, type: Date })
  checkOutAt!: Date | null;

  @ApiProperty({
    description: '签到点到活动坐标距离(米；Decimal 字符串)',
    nullable: true,
    type: String,
  })
  checkInDistance!: string | null;

  @ApiProperty({
    description: '签退点到活动坐标距离(米；Decimal 字符串)',
    nullable: true,
    type: String,
  })
  checkOutDistance!: string | null;

  @ApiProperty({ description: '签到时活动坐标是否完整有效并完成 geofence 计算' })
  geoVerified!: boolean;

  @ApiProperty({ description: '签到时未舍入距离是否严格大于配置半径' })
  outOfRange!: boolean;

  @ApiProperty({ description: '证据创建时间(ISO 8601)' })
  createdAt!: Date;

  @ApiProperty({ description: '证据最近更新时间(ISO 8601)' })
  updatedAt!: Date;
}
