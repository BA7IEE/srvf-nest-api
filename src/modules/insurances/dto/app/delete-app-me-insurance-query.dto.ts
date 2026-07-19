import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

// PR3 客户端契约必填；运行时 required 与其余 enforcement 行为由 single gate 原子切换。
export class DeleteAppMeInsuranceQueryDto {
  @ApiProperty({
    description:
      '客户端最后读取到的版本号(PR3 客户端契约必填；运行时由 single cutover gate 原子启用)',
    minimum: 0,
  })
  @Transform(({ value }: { value: unknown }) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
      if (value.trim() === '') return undefined;
      return Number(value);
    }
    return value;
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
