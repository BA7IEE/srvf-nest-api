import { SetMetadata } from '@nestjs/common';

// CMS 内容发布模块(第 28 模块)T3(2026-06-21):open/v1 内容读取面限流装饰器(第 10 个独立 throttler 实例)。
// 镜像 recruitment-throttle 范式(纯 metadata;limit/ttl 从 app.config 注入,物理隔离不影响其它九实例)。
// 评审稿 §7:open/v1 公开读取面(列表 + 详情)挂 @ContentPublicThrottle(),按 IP 限流(默认 60/60s,
// 读取适配——比写入/付费端点宽松,仍挡爆破/高频扫库)。
export const CONTENT_PUBLIC_THROTTLE_KEY = 'content-public-throttle:enabled';
export const CONTENT_PUBLIC_THROTTLER_NAME = 'content-public';

export const ContentPublicThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CONTENT_PUBLIC_THROTTLE_KEY, true);
