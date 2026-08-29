---
"feat(auth)": Integration Foundation v1 PR3 —— 机器认证:Service Token + 独立信任域 + Feature Gate + 第 12 throttler(P1-30)

- 新模块 integration-auth:`POST auth/v1/service-token`(Client Credentials;规格书 §12.3 冻结接口)
- 独立信任域(§11.2):INTEGRATION_JWT_SECRET(≠JWT_SECRET;production ≥48 字符)/ issuer srvf-dp /
  audience srvf-integration / Service Token ≤30min 默认 10min / 零 refresh
- 失败归一(§12.4):不存在 / Secret 错 / SUSPENDED / 已撤销 / 已过期五场景统一 37010,不暴露原因;
  clientId 不存在时 dummy hash 同代价比较(§12.1 防 timing)
- Feature Gate(§48):INTEGRATION_API_ENABLED=false 时 token 签发 37030 fail-closed(控制面不受影响)
- 第 12 throttler `service-token`(默认 10/60;§51 成对落地:注册+Guard 分派+装饰器)
- logger redact +6(§26 逐条枚举:clientSecret/secretHash/rawSecret/serviceToken/delegatedToken/credentialSecret)
- Claims 禁入清单(§13):e2e 断言 payload 恰 8 个标准字段,零权限/角色/组织/Secret
- BizCode 37xxx 段位重排(37010/37011 归认证归一码,PR2 控制面 NOT_FOUND→37014、LIMIT→37015)
- e2e 4 用例:正向换 Token+verify / 五场景归一 / Claims 禁入 / 错签名 37011

BREAKING: 无(Gate 默认关;端点净新增;37xxx 无既有消费者)
