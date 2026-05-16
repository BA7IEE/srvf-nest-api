import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';
import { isProductionLike, type AppConfig } from '../config/app.config';
import { buildHttpLogProps, genReqId } from './request-id';

// nestjs-pino 默认 forRoutes 是 `[{ path: '*', method: RequestMethod.ALL }]`,与
// `app.setGlobalPrefix('/api')` 拼接后变成 `/api/*`,触发 NestJS 11 / path-to-regexp v8
// 的 LegacyRouteConverter 启动期 WARN(LoggerModule 注册两个 middleware,WARN 打两次)。
// 显式声明命名 wildcard `*path` 跳过该 legacy 转换路径,与 LegacyRouteConverter
// 错误信息推荐写法一致(`/users/*path` → 本仓库形态 `/api/*path`)。语义不变,仍匹配
// 全部以 `/api` 开头的请求。
const LOGGER_FOR_ROUTES: NonNullable<Params['forRoutes']> = [
  { path: '*path', method: RequestMethod.ALL },
];

// V1.1 §11.2 / §11.4 / TASKS.md 15.2:
// 敏感字段 redact 清单。命中字段日志输出 `[REDACTED]`,不能仅做长度截断。
// `*.<name>` 通配匹配任意嵌套对象的同名字段(纵深防御:即使将来日志格式变了也兜底)。
//
// V2 baseline §8.2 / §8.4(自 commit 16876fe):字段不存在时无害,字段一旦
// 落表自动生效;后续新增敏感字段须按 baseline §8.4 同 commit 维护本清单。
//
// 关于 baseline §8.2 的"通配规则"(任何字段名包含 secret / credential /
// private / pwd 子串):pino `redact.paths` **不**支持子串通配,只支持路径
// 表达式与 `*.<name>` 通配。本清单仅枚举具体字段名;子串约定继续作为团队
// 规范由 code review 守护,不在 logger 代码内强制实现。
const LOG_REDACT_PATHS: readonly string[] = [
  // HTTP 头
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // 请求 body 中的敏感字段(若将来配置打 body,这里兜底屏蔽)
  'req.body.password',
  'req.body.newPassword',
  'req.body.token',
  'req.body.accessToken',
  'req.body.refreshToken',
  // v1 通配:任意嵌套层级出现的同名字段(响应日志 / 自定义日志)
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',

  // V2 baseline §8.2 — 个人身份证类
  '*.idCard',
  '*.idCardNumber',
  '*.idNumber',
  '*.nationalId',

  // V2 baseline §8.2 — 联系方式类
  '*.phone',
  '*.phoneNumber',
  '*.mobile',
  '*.mobileNumber',
  '*.tel',
  '*.emergencyContact',
  '*.emergencyContactName',
  '*.emergencyContactPhone',
  '*.emergencyContactRelation',

  // V2 baseline §8.2 — 医疗健康类
  '*.medicalInfo',
  '*.medicalHistory',
  '*.medicalNotes',
  '*.allergies',
  '*.chronicDiseases',
  '*.bloodType',
  '*.remarksSensitive',

  // V2 baseline §8.2 — 财务类(v1 / V2 都不存,防御性预扩展)
  '*.bankAccount',
  '*.bankCard',
  '*.bankCardNumber',
  '*.cardNumber',
  '*.creditCard',
  '*.cvv',

  // V2 baseline §8.2 — 地址类
  '*.homeAddress',
  '*.address',
  '*.residenceAddress',

  // V2 baseline §8.2 — 出生 / 身份信息类
  '*.dateOfBirth',
  '*.dob',
  '*.birthDate',

  // V2 baseline §8.2 — 第三方账号 / 凭证标识类
  '*.wechat',
  '*.wechatId',
  '*.openId',
  '*.unionId',
  '*.certificateNo',
  '*.licenseNo',
  '*.policyNo',
];

// V1.1 §17.5 / TASKS.md 15.2:HTTP 自动日志只打 method / url / status / responseTime
// + reqId(pino 内置)+ userId(若已登录)。禁止默认打印请求体。
export function buildLoggerModuleParams(appCfg: AppConfig): Params {
  // test 环境强制 silent:e2e 跑 162 用例,任何日志都会污染 jest 输出。
  const isTest = appCfg.env === 'test';
  // production-like(production / smoke):JSON 输出 + 不开 pino-pretty(沿生产环境行为)
  const isProd = isProductionLike(appCfg.env);
  const level = isTest ? 'silent' : appCfg.logLevel;

  return {
    forRoutes: LOGGER_FOR_ROUTES,
    pinoHttp: {
      level,
      genReqId,
      // 非 production 且非 test 才开 pino-pretty(开发时才需要美化输出)。
      transport:
        !isProd && !isTest
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: false,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: '[REDACTED]',
        remove: false,
      },
      customProps: buildHttpLogProps,
    },
  };
}
