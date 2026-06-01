import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// V1.1 §11.2 / TASKS.md 15.5:健康检查响应载荷。
//
// 三端点共用此 DTO,经 ResponseInterceptor 包装后响应外层始终是
// `{ code: 0, message: 'ok', data: HealthResponseDto }`:
// - GET /api/system/v1/health        → data: { status: 'ok' }            (向后兼容,等同 /live)
// - GET /api/system/v1/health/live   → data: { status: 'ok' }            (K8s liveness)
// - GET /api/system/v1/health/ready  → data: { status: 'ok', db: 'up' }  (K8s readiness 成功路径)
//
// /ready 失败路径走 BizException(BizCode.INTERNAL_ERROR) → AllExceptionsFilter,
// 响应体由 filter 直出 `{ code: 50000, message, data: null }`,**不会**包装本 DTO,
// 因此 `db: 'down'` 在运行时不会作为 success data 出现;保留 'down' 字面量纯粹是
// 类型完备(若未来调整契约可直接复用,无需改 DTO)。
export class HealthResponseDto {
  @ApiProperty({
    description: '检查通过标识(三端点成功路径恒为 ok)',
    enum: ['ok'],
    example: 'ok',
  })
  status!: 'ok';

  @ApiPropertyOptional({
    description: '数据库连通状态(仅 /api/system/v1/health/ready 成功路径返回 up)',
    enum: ['up', 'down'],
    example: 'up',
  })
  db?: 'up' | 'down';
}
