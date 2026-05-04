import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';

// 跳过路径(详见 ARCHITECTURE.md §7.3 表):
// - /api/docs:Swagger UI(HTML)+ /api/docs-json / /api/docs-yaml(OpenAPI spec)
// - /favicon.ico:浏览器自动请求,非业务响应
// - /metrics:Prometheus 文本格式
// 文件下载流响应通过 StreamableFile instanceof 判断额外跳过。
const SKIP_PREFIXES = ['/api/docs', '/favicon.ico', '/metrics'] as const;

interface WrappedResponse<T> {
  code: 0;
  message: 'ok';
  data: T;
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const url = context.switchToHttp().getRequest<Request>().url ?? '';
    if (SKIP_PREFIXES.some((p) => url.startsWith(p))) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown): unknown => {
        if (data instanceof StreamableFile) return data;
        const wrapped: WrappedResponse<unknown> = { code: 0, message: 'ok', data };
        return wrapped;
      }),
    );
  }
}
