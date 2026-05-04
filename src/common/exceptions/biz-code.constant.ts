import { HttpStatus } from '@nestjs/common';

// 完整 12 个 BizCode,1:1 对齐 ARCHITECTURE.md §7.3。
// 段位规则:4xxxx/5xxxx 通用 HTTP 级,100xx users 业务,101xx users 权限/边界,
// 后续模块按 110xx+ 平铺(见文档表)。
//
// 注:BizCode 是公共常量,不绑定具体业务模块,这一阶段一次性落地是合理的;
// 各业务码的实际 throw 点仍按"每次只实现一个阶段"在第 7/8 阶段补上。
export const BizCode = {
  // 通用 HTTP 级
  BAD_REQUEST: { code: 40000, message: '请求参数错误', httpStatus: HttpStatus.BAD_REQUEST },
  UNAUTHORIZED: { code: 40100, message: '未登录或登录已失效', httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN: { code: 40300, message: '无权限访问', httpStatus: HttpStatus.FORBIDDEN },
  NOT_FOUND: { code: 40400, message: '资源不存在', httpStatus: HttpStatus.NOT_FOUND },
  // V1.1 §11.4 / TASKS.md 15.7:登录接口限流命中。落 4xxxx 通用 HTTP 段(429),
  // 不占用业务模块 100xx / 110xx 段。message 故意不暴露阈值数字、剩余配额、
  // 重置时间(防止攻击者反推限流参数)。
  TOO_MANY_REQUESTS: {
    code: 42900,
    message: '请求过于频繁，请稍后再试',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },
  INTERNAL_ERROR: {
    code: 50000,
    message: '服务器内部错误',
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
  },

  // users 模块业务级(100xx)—— 实际 throw 点在第 7/8 阶段落地
  USER_NOT_FOUND: { code: 10001, message: '用户不存在', httpStatus: HttpStatus.NOT_FOUND },
  USERNAME_ALREADY_EXISTS: {
    code: 10002,
    message: 'username 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  EMAIL_ALREADY_EXISTS: {
    code: 10003,
    message: 'email 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  LOGIN_FAILED: {
    code: 10004,
    message: '账号或密码错误',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },

  // users 模块权限/操作边界(101xx)
  FORBIDDEN_ROLE_OPERATION: {
    code: 10101,
    message: '无权对该用户执行此操作',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  CANNOT_OPERATE_SELF: {
    code: 10102,
    message: '不能对自己执行此操作',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  LAST_SUPER_ADMIN_PROTECTED: {
    code: 10103,
    message: '系统必须保留至少一个活跃超级管理员',
    httpStatus: HttpStatus.CONFLICT,
  },
} as const;

export type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];
