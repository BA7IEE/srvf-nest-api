import { ApiProperty } from '@nestjs/swagger';
import type { ActivityControlPlaneMode } from '../../../../config/app.config';

export class AppActivityControlPlaneStatusDto {
  @ApiProperty({ enum: ['off', 'shadow', 'active'], description: 'B6 新创建控制面模式' })
  mode!: ActivityControlPlaneMode;

  @ApiProperty({
    enum: ['unavailable', 'pilot', 'enabled'],
    description: '前端入口展示状态，不是当前用户的创建权限或正式发布资格',
  })
  creationAvailability!: 'unavailable' | 'pilot' | 'enabled';
}
