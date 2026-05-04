import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { LoginThrottle } from '../../common/decorators/login-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuthService } from './auth.service';
import { LoginDto, LoginResponseDto } from './auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/auth/login(@Public 跳过 JwtAuthGuard)。
  // 默认 POST 返回 201,登录场景没有创建资源,显式 200。
  // V1.1 §11.4 / TASKS.md 15.7:加 @LoginThrottle() 启用 IP 维度限流(参数走 app.config),
  // 命中后 ThrottlerBizGuard 抛 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429 +
  // 统一错误体,不暴露阈值/剩余配额/重置时间(无 X-RateLimit-* / Retry-After 头)。
  @Public()
  @LoginThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用户名 + 密码登录,返回 JWT' })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.LOGIN_FAILED, BizCode.TOO_MANY_REQUESTS)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }
}
