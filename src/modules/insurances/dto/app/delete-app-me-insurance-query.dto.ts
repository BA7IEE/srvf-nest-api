import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

// PR2 兼容窗:App DELETE 的 CAS 版本仍可省略；PR3 将改为必填。
export class DeleteAppMeInsuranceQueryDto {
  @ApiPropertyOptional({
    description: '客户端最后读取到的版本号(PR2 可选,PR3 起必填)',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
