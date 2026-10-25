### Fixed

- 将既有生产依赖 override 提升到 body-parser 2.4、multer 2.5 和 fast-uri 3.1.9 的安全版本线，修复压缩请求、异步上传过滤及 URI 解析的已知漏洞；不升级 Nest、Express 或 COS SDK。
- 保留正式审计的 high/critical 阻断及原三项 moderate 的已登记边界，不新增 ignore，不将本地候选验证写成 main 或生产已验收。
