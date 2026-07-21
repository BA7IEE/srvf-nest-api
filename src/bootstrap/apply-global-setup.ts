import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { BizCode } from '../common/exceptions/biz-code.constant';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { isProductionLike, type AppConfig } from '../config/app.config';
import { genReqId } from './request-id';

const IPV4_MAPPED_CANONICAL_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const CLIENT_IDENTITY_REJECTED_EVENT = 'client_identity_rejected';
const clientIdentityLogger = new Logger('ClientIdentityBoundary');

type TrustProxyFunction = (address: string, index: number) => boolean;

// Express/proxy-addr 负责按 trust proxy 从右向左选出 client token；这里仅收紧该最终
// identity 的语法与表示，不自行解析 XFF。应用先显式拒绝 zone，Node isIP 再拒绝
// port/bracket/空白等非 IP token；WHATWG URL 给合法 IPv6 稳定 lowercase + 压缩表示。
export function canonicalizeClientIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const version = isIP(value);
  if (version === 4) {
    return value
      .split('.')
      .map((octet) => String(Number.parseInt(octet, 10)))
      .join('.');
  }
  if (version !== 6) return null;

  let hostname: string;
  try {
    hostname = new URL(`http://[${value}]/`).hostname;
  } catch {
    return null;
  }
  const canonicalIpv6 = hostname.slice(1, -1);
  const mapped = IPV4_MAPPED_CANONICAL_PATTERN.exec(canonicalIpv6);
  if (!mapped) return canonicalIpv6;

  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function replaceRequestClientIdentity(
  req: Request,
  trustProxy: TrustProxyFunction | null,
): boolean {
  try {
    const rawIp: unknown = req.ip;
    const canonicalIp = canonicalizeClientIp(rawIp);
    const rawIps: unknown = req.ips;
    if (canonicalIp === null || !Array.isArray(rawIps)) return false;
    const canonicalIps = rawIps.map(canonicalizeClientIp);
    if (canonicalIps.some((ip) => ip === null)) return false;
    if (trustProxy && typeof rawIp === 'string' && trustProxy(rawIp, 0)) return false;

    Object.defineProperties(req, {
      ip: { configurable: true, enumerable: true, value: canonicalIp },
      ips: { configurable: true, enumerable: true, value: canonicalIps },
    });
    return true;
  } catch {
    // proxy-addr may throw while walking an unparseable intermediate token; malformed identity
    // is always a client input failure, never an uncaught 500 / Express default error page.
    return false;
  }
}

function applyInvalidResponseCors(req: Request, res: Response, allowedOrigins: string[]): void {
  res.vary('Origin');
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

function sendInvalidClientIdentity(req: Request, res: Response, appCfg: AppConfig): void {
  const reqId = (req as Request & { id: string }).id;
  clientIdentityLogger.warn({ event: CLIENT_IDENTITY_REJECTED_EVENT, reqId });
  applyInvalidResponseCors(req, res, appCfg.corsOrigin);
  res.status(BizCode.BAD_REQUEST.httpStatus).json({
    code: BizCode.BAD_REQUEST.code,
    message: BizCode.BAD_REQUEST.message,
    data: null,
  });
}

// 应用全局启动配置(helmet 安全头 / 全局前缀 / CORS / ValidationPipe / 全局异常过滤器 / 全局响应拦截器)。
// main.ts 与 test 套件 (createTestApp) 共用此函数,保证测试与运行时行为 1:1 一致;
// 任何 main.ts 里的全局设定调整都必须改在这里,而不是在 main.ts 里手写一份新的。
//
// 不在此函数内做的事:
// - NestFactory.create:由调用方负责,便于测试替换 AppModule overrides
// - app.listen:测试不监听端口,直接用 supertest 走 app.getHttpServer()
// - Swagger 注册:仅 main.ts 在生产/开发链路注册,测试不需要
// - 配置强校验:由 ConfigService 加载 app.config.ts 时触发,无需在此重复
export function applyGlobalSetup(app: INestApplication, appCfg: AppConfig): void {
  // Trusted proxy 必须在注册任何 middleware / pipe / filter 前完成；后续所有 req.ip 消费者
  // 只读取 Express 原生右向左、首个不可信地址截断后的结果。空列表显式关闭信任，禁止
  // boolean true / hop number 等拓扑相关配置。
  const expressApp = app.getHttpAdapter().getInstance() as {
    set(name: string, value: false | string[]): void;
    get(name: string): unknown;
  };
  expressApp.set(
    'trust proxy',
    appCfg.trustedProxyCidrs.length === 0 ? false : appCfg.trustedProxyCidrs,
  );
  const compiledTrustProxy = expressApp.get('trust proxy fn');
  if (appCfg.trustedProxyCidrs.length > 0 && typeof compiledTrustProxy !== 'function') {
    throw new Error('Express trust proxy function was not compiled');
  }
  const trustProxy =
    appCfg.trustedProxyCidrs.length > 0 ? (compiledTrustProxy as TrustProxyFunction) : null;

  // 在 pino-http 注册前建立唯一 request id；pino-http 直接复用 truthy req.id，
  // 响应头、边界拒绝日志与正常 access log 不会漂移。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = genReqId(req, res);
    Object.defineProperty(req, 'id', {
      configurable: true,
      enumerable: true,
      value: reqId,
      writable: true,
    });
    next();
  });

  // V1.1 §11.2 / TASKS.md 15.6:HTTP 基线安全头(X-Content-Type-Options / X-Frame-Options /
  // Strict-Transport-Security / Referrer-Policy / X-DNS-Prefetch-Control 等),用 helmet 默认配置。
  //
  // /api/docs 路径局部禁 CSP:Swagger UI HTML 内含 inline `<script>`,helmet 默认 CSP
  // (`script-src 'self'`)会阻止其执行,导致页面白屏。仅对 docs 路径关闭 CSP,**禁止**全局关闭。
  // 其余安全头(包括 X-Frame-Options 等)在 docs 路径仍然生效,只 CSP 这一项放行。
  //
  // 中间件分发模式:预先创建两个 helmet 实例,按 req.path 选择,避免重复 helmet 调用导致
  // 后注册的 helmet({csp:false}) 无法清除前一个 helmet() 写入的 Content-Security-Policy 头
  // (helmet `csp:false` 只是不写,不会主动 removeHeader)。
  const helmetDefault = helmet();
  const helmetForSwagger = helmet({ contentSecurityPolicy: false });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/docs')) {
      return helmetForSwagger(req, res, next);
    }
    return helmetDefault(req, res, next);
  });

  // Helmet 不消费 client identity；紧随其后的 canonicalizer 仍早于 CORS preflight、
  // pino/throttler/controller/audit 等身份 consumer。非法 preflight 也必须 400，故不把
  // enableCors 前置；拒绝分支只为 allowlist 命中的 Origin 精确补 CORS 响应头。
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (replaceRequestClientIdentity(req, trustProxy)) {
      next();
      return;
    }
    sendInvalidClientIdentity(req, res, appCfg);
  });

  app.setGlobalPrefix('/api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // production-like(production / smoke)隐藏异常 message;sanitize 沿 production 行为
  app.useGlobalFilters(new AllExceptionsFilter(isProductionLike(appCfg.env)));
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.enableCors({ origin: appCfg.corsOrigin });
}
