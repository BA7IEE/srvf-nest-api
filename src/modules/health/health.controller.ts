import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { HealthResponseDto } from './health.dto';

// V1.1 §11.2 / TASKS.md 15.5:健康检查分层
//
// 三个端点全部 @Public(),全部走 ResponseInterceptor 包装,响应外层始终是
//   { code: 0, message: 'ok', data: { status: 'ok', ... } }
// 详见 ARCHITECTURE.md §6 + §11.4。
//
// 设计选择(15.5 与用户决策):
// 1) /api/health 保留 v1 契约,实现等同 /live,不破坏 health.e2e-spec.ts
// 2) /api/health/live 进程存活探针(K8s liveness),不查任何外部依赖
// 3) /api/health/ready 就绪探针(K8s readiness),通过 @nestjs/terminus 的
//    PrismaHealthIndicator 探测 DB 连通(SELECT 1 等价)
//    - 成功:返回 { status: 'ok', db: 'up' }
//    - 失败:抛 BizException(BizCode.INTERNAL_ERROR) → AllExceptionsFilter
//      响应 HTTP 500 + { code: 50000, message, data: null }
//
// 关于 503 的取舍(用户决策方案 A,详见 PR 说明):
//   ARCHITECTURE.md §11.4 规定 "HTTP status 由 BizCode 的 httpStatus 决定",
//   而 BizCode.INTERNAL_ERROR.httpStatus = 500。CLAUDE.md/AGENTS.md/TASKS.md
//   §17.5 / 15.5 描述的 "503" 与上述铁律存在文档矛盾,以最高优先级的
//   ARCHITECTURE.md §11.4 为准 → 走 HTTP 500。后续若需要标准 503,应单独
//   新增 BizCode.SERVICE_UNAVAILABLE,不在 15.5 内处理。
//
// 关于 terminus 原生输出 vs 项目契约:
//   HealthCheckService.check() 失败会抛 ServiceUnavailableException(503,
//   被 CLAUDE.md §17.5 明令禁止);成功则返回 { status, info, error, details }。
//   两者都不符合本项目接口契约,因此本 controller 把 terminus 仅用作"探测引擎",
//   把成功结果重写成简洁的 HealthResponseDto,把失败统一转成 BizException,
//   既保住 ResponseInterceptor 包装,也保住统一错误处理。
@ApiTags('Public')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: '服务健康检查(向后兼容,实现等同 /api/health/live)',
  })
  @ApiWrappedOkResponse(HealthResponseDto)
  check(): HealthResponseDto {
    return { status: 'ok' };
  }

  @Public()
  @Get('live')
  @ApiOperation({
    summary: '存活探针(K8s liveness)— 仅证明进程在跑,不查外部依赖',
  })
  @ApiWrappedOkResponse(HealthResponseDto)
  live(): HealthResponseDto {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: '就绪探针(K8s readiness)— 含数据库连通检查;DB 不可用时 HTTP 500 + code 50000',
  })
  @ApiWrappedOkResponse(HealthResponseDto)
  @ApiBizErrorResponse(BizCode.INTERNAL_ERROR)
  async ready(): Promise<HealthResponseDto> {
    try {
      // PrismaHealthIndicator 内部:先试 $runCommandRaw(MongoDB 命令),
      // 在 SQL provider 上会被 fallback 到 $queryRawUnsafe('SELECT 1');
      // indicator 自身把异常吞成 'down' 状态,HealthCheckService 检测到
      // 'down' 后抛 ServiceUnavailableException 让我们的 try/catch 接住。
      await this.health.check([() => this.prismaIndicator.pingCheck('db', this.prisma)]);
    } catch {
      // 任何探测失败一律转 BizException,统一走 AllExceptionsFilter。
      // 不区分超时 / 连接失败 / 查询失败,K8s readiness 只关心 ready ∈ {true, false}。
      // 不在响应 message 中暴露内部错误细节(避免泄露 DB 连接串、表名等)。
      throw new BizException(BizCode.INTERNAL_ERROR);
    }
    return { status: 'ok', db: 'up' };
  }
}
