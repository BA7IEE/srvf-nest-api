import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CurrentUserPayload } from '../common/decorators/current-user.decorator';

// V1.1 §11.2 / TASKS.md 15.3:请求 ID 贯通(x-request-id)
// 客户端可在请求头传 `x-request-id` 透传调用链 ID;缺失或非法时由后端生成。
// 生成结果同时写回响应头与 pino 日志的 reqId 字段,前端报错时凭此对齐后端日志。
export const REQUEST_ID_HEADER = 'x-request-id';

// 客户端透传的 x-request-id 必须做基本格式校验,挡住注入与超长字符串污染日志。
// 允许字符集刻意收窄为 `[A-Za-z0-9_\-.]`(避开冒号、引号、空格等可能破坏日志/响应头解析的字符);
// 长度 1-128:覆盖常见 UUID / cuid / 自定义 trace id 形态,又防止滥用。
// 校验失败 → 忽略客户端值,生成新 ID(等同未传场景)。
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_\-.]{1,128}$/;

// cuid-like 风格:`c` 前缀 + 时间戳 base36 + 12 字节 crypto 随机 hex(24 字符)。
function generateRequestId(): string {
  return `c${Date.now().toString(36)}${randomBytes(12).toString('hex')}`;
}

// 全局 early middleware 在 pino-http 前调用并 own-set req.id；pino-http 直接复用该值。
// 若其他边界显式重复调用，本函数也优先复用已建立的安全 ID 并回写同一响应头。
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const establishedId = (req as IncomingMessage & { id?: unknown }).id;
  const headerValue = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const id =
    typeof establishedId === 'string' && REQUEST_ID_PATTERN.test(establishedId)
      ? establishedId
      : candidate && REQUEST_ID_PATTERN.test(candidate)
        ? candidate
        : generateRequestId();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

// V1.1 TASKS.md 15.3:HTTP 请求日志 customProps 工厂。
// pino-http 在响应阶段调用此函数,把返回字段合并到当前请求日志条目顶层。
//   - reqId:与响应头 x-request-id 完全一致(同一字符串引用,均来自 genReqId → req.id)。
//   - userId:已登录请求由 JwtStrategy.validate() 后 passport 挂在 Express Request 上;
//     未登录请求省略字段,避免无意义噪声。
export function buildHttpLogProps(req: IncomingMessage): Record<string, unknown> {
  const r = req as IncomingMessage & { id?: string; user?: CurrentUserPayload };
  const props: Record<string, unknown> = {};
  if (r.id) props.reqId = r.id;
  if (r.user) props.userId = r.user.id;
  return props;
}
