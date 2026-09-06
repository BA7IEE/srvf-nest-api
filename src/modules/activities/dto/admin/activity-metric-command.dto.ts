import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class AdminActivityMetricVersionCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDefinitionHash!: string;
}

export class AdminActivityMetricCommandResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ enum: ['draft', 'active', 'retired'] }) statusCode!:
    | 'draft'
    | 'active'
    | 'retired';
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
}
