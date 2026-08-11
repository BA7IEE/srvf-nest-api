import { ApiProperty } from '@nestjs/swagger';

export class AppActivityQualificationUnmetRuleDto {
  @ApiProperty({ description: '冻结资格规则主键' })
  ruleId!: string;

  @ApiProperty({ enum: ['block', 'warn'], description: '规则不满足时的执行级别' })
  enforcementCode!: 'block' | 'warn';

  @ApiProperty({ enum: ['warn', 'fail'], description: '该未满足规则的结果' })
  resultCode!: 'warn' | 'fail';

  @ApiProperty({ type: String, nullable: true, description: '规则配置的安全提示文案' })
  message!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'warn 规则的提示分值' })
  warnScore!: number | null;
}

export class AppActivityQualificationDto {
  @ApiProperty({ enum: ['pass', 'warn', 'fail'], description: '当前调用者的资格结论' })
  resultCode!: 'pass' | 'warn' | 'fail';

  @ApiProperty({
    type: () => [AppActivityQualificationUnmetRuleDto],
    description: '未满足规则的安全摘要；不返回任何个人事实或 valueJson',
  })
  unmetRules!: AppActivityQualificationUnmetRuleDto[];
}
