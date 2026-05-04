import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

// 主键当前用 cuid() 字符串(ARCHITECTURE.md §5)。路径参数 :id 仅做长度校验,
// 不写死 cuid 正则,避免与具体 ID 生成算法过度绑定。绝不能写成 int。
export class IdParamDto {
  @ApiProperty({
    description: '资源主键(cuid 字符串)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'id 必须是 8-64 位字符串' })
  id!: string;
}
