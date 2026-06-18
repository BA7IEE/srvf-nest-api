import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { BizCode, type BizCodeEntry } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

const HTTP_STATUS_TO_BIZ: Record<number, BizCodeEntry> = {
  [HttpStatus.BAD_REQUEST]: BizCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: BizCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: BizCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: BizCode.NOT_FOUND,
  // multipart 上传超大小限(NestJS FileInterceptor 把 multer LIMIT_FILE_SIZE 转 413 PayloadTooLarge)
  // → 归一为客户端参数错误 40000(与 service 层 image.size 超限同码),而非裸 50000(招新证件照上传 F-1)。
  [HttpStatus.PAYLOAD_TOO_LARGE]: BizCode.BAD_REQUEST,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  // 由 main.ts 在 new 时显式传入,避免 filter 在 catch 路径上再读 ConfigService。
  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof BizException) {
      response.status(exception.biz.httpStatus).json({
        code: exception.biz.code,
        message: exception.biz.message,
        data: null,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const biz = HTTP_STATUS_TO_BIZ[status] ?? BizCode.INTERNAL_ERROR;
      response.status(status).json({
        code: biz.code,
        message: this.resolveHttpExceptionMessage(exception, status, biz.message),
        data: null,
      });
      return;
    }

    // 未知异常 → 500 + INTERNAL_ERROR
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(BizCode.INTERNAL_ERROR.httpStatus).json({
      code: BizCode.INTERNAL_ERROR.code,
      message: this.isProduction
        ? BizCode.INTERNAL_ERROR.message
        : exception instanceof Error
          ? exception.message
          : String(exception),
      data: null,
    });
  }

  // 仅 BadRequest(400)且来自 ValidationPipe(message 是 string[])时透传字段校验细节;
  // 401 / 403 / 404 / 其他 HttpException 一律使用 BizCode 通用 message,
  // 避免暴露 NestJS 默认 message(如 "Cannot GET /api/xxx" 这类路径信息)。
  private resolveHttpExceptionMessage(
    exception: HttpException,
    status: number,
    fallback: string,
  ): string {
    const httpBadRequest: number = HttpStatus.BAD_REQUEST;
    if (status !== httpBadRequest) return fallback;

    const res = exception.getResponse();
    if (typeof res === 'object' && res !== null && 'message' in res) {
      const m: unknown = res.message;
      if (Array.isArray(m) && m.length > 0) {
        return m.map((item) => String(item)).join('; ');
      }
    }
    return fallback;
  }
}
