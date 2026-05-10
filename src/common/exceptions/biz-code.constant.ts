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

  // member_departments 模块业务级(170xx + 171xx)。详见 docs/v2-api-contract.md §5.4。
  // 子段(对齐 baseline §1.3):
  // - 17001:NOT_FOUND(member 当前无 active 归属)
  // - 17002:唯一约束冲突(并发兜底,partial unique index 撞)
  // - 17030-17099:资源状态非法(member INACTIVE / organization INACTIVE)
  //
  // 复用现有错误码:MEMBER_NOT_FOUND(15001) / ORGANIZATION_NOT_FOUND(11001);
  // 不登记 FORBIDDEN_MANAGE_MEMBER_DEPARTMENT(沿用 dict/org/members 决策)。
  MEMBER_DEPARTMENT_NOT_FOUND: {
    code: 17001,
    message: '队员当前无部门归属',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_DEPARTMENT_ALREADY_EXISTS: {
    code: 17002,
    message: '队员已有活跃部门归属',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_INACTIVE: {
    code: 17030,
    message: '队员状态非活跃,不能挂部门',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_INACTIVE: {
    code: 17031,
    message: '组织节点状态非活跃,不能挂队员',
    httpStatus: HttpStatus.CONFLICT,
  },

  // member_profiles 模块业务级(160xx + 161xx)。批次 1 引入。
  // 子段(对齐 baseline §1.3):
  // - 16001:NOT_FOUND
  // - 16002-16009:唯一约束冲突(memberId 1:1)
  // - 16010-16029:业务级输入校验(各字典字段 invalid)
  //
  // 字典字段无效不收敛为单一码:沿用 members 模块每字典字段一码模式(详见 batch-1
  // API 前评审 §9.5)。保留 161xx 给后续 USER 自助路由 / 二次校验等权限边界码。
  MEMBER_PROFILE_NOT_FOUND: {
    code: 16001,
    message: '队员档案不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_PROFILE_ALREADY_EXISTS: {
    code: 16002,
    message: '队员档案已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_PROFILE_GENDER_CODE_INVALID: {
    code: 16010,
    message: '性别字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID: {
    code: 16011,
    message: '证件类型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID: {
    code: 16012,
    message: '政治面貌字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID: {
    code: 16013,
    message: '血型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_WORK_NATURE_CODE_INVALID: {
    code: 16014,
    message: '工作性质字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // emergency_contacts 模块业务级(190xx + 191xx)。批次 1 引入。
  // baseline §1.1 原预留 events / event_participants;批次 1 启动时 emergency_contacts
  // 单独成模块,占用 190xx;baseline 同步追加一行(member_profiles 仍占 baseline 预留 160xx)。
  // 子段:
  // - 19001:NOT_FOUND
  // - 19010-19029:业务级输入校验(relation_code_invalid)
  // - 19101:权限边界(NOT_BELONGS_TO_MEMBER)
  EMERGENCY_CONTACT_NOT_FOUND: {
    code: 19001,
    message: '紧急联系人不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  EMERGENCY_CONTACT_RELATION_CODE_INVALID: {
    code: 19010,
    message: '紧急联系人关系字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER: {
    code: 19101,
    message: '紧急联系人不属于该队员',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // members 模块业务级(150xx + 151xx)。详见 docs/v2-api-contract.md §4.7。
  // 子段(对齐 baseline §1.3):
  // - 15001:NOT_FOUND
  // - 15002-15009:唯一约束冲突(memberNo)
  // - 15010-15029:业务级输入校验(grade_code_invalid)
  // - 15030-15099:资源状态非法 / 引用约束(has_active_department / has_linked_user)
  //
  // 注:登录账号枚举相关失败场景(memberNo 路径未命中 / 命中但未绑 user 等)
  // 统一抛 v1 LOGIN_FAILED = 10004,**禁止**在 150xx 段为 memberNo 路径自创业务码。
  MEMBER_NOT_FOUND: {
    code: 15001,
    message: '队员不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_NO_ALREADY_EXISTS: {
    code: 15002,
    message: '队员编号已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_GRADE_CODE_INVALID: {
    code: 15010,
    message: '队员等级字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_HAS_ACTIVE_DEPARTMENT: {
    code: 15030,
    message: '队员仍有部门归属,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_HAS_LINKED_USER: {
    code: 15031,
    message: '队员已被 user 绑定,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },

  // organizations 模块业务级(110xx + 111xx)。详见 docs/v2-api-contract.md §3.5。
  // 子段(对齐 baseline §1.3):
  // - 11001:NOT_FOUND
  // - 11010-11029:业务级输入校验(parent_not_found / node_type_invalid /
  //   parent_cycle / parent_change_forbidden)
  // - 11030-11099:资源状态非法 / 引用约束(has_children / has_members /
  //   root_already_exists)
  // - 11103:系统约束保护(last_root_protected)
  ORGANIZATION_NOT_FOUND: {
    code: 11001,
    message: '组织节点不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ORGANIZATION_PARENT_NOT_FOUND: {
    code: 11010,
    message: '父级组织节点不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ORGANIZATION_NODE_TYPE_INVALID: {
    code: 11011,
    message: '节点类别字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_PARENT_CYCLE: {
    code: 11012,
    message: '组织节点父级形成环',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_PARENT_CHANGE_FORBIDDEN: {
    code: 11013,
    message: '不允许修改组织节点父级',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_HAS_CHILDREN: {
    code: 11030,
    message: '组织节点存在子节点,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_HAS_MEMBERS: {
    code: 11031,
    message: '组织节点存在成员归属,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_ROOT_ALREADY_EXISTS: {
    code: 11032,
    message: '系统已存在活跃根节点',
    httpStatus: HttpStatus.CONFLICT,
  },
  LAST_ROOT_ORGANIZATION_PROTECTED: {
    code: 11103,
    message: '系统必须保留至少一个活跃根节点',
    httpStatus: HttpStatus.CONFLICT,
  },

  // dictionaries 模块业务级(120xx + 121xx;dict_type 用 12001-12009 / 12030-12039,
  // dict_item 用 12010-12019 / 12031-12049)。详见 docs/v2-api-contract.md §2.5。
  DICT_TYPE_NOT_FOUND: {
    code: 12001,
    message: '字典类型不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  DICT_TYPE_CODE_ALREADY_EXISTS: {
    code: 12002,
    message: '字典类型 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_NOT_FOUND: {
    code: 12010,
    message: '字典项不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  DICT_ITEM_CODE_ALREADY_EXISTS: {
    code: 12011,
    message: '同类型下字典项 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_PARENT_TYPE_MISMATCH: {
    code: 12012,
    message: '字典项父级跨类型',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  DICT_ITEM_PARENT_CYCLE: {
    code: 12013,
    message: '字典项父级形成环',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  DICT_ITEM_PARENT_IMMUTABLE: {
    code: 12014,
    message: '字典项父级不允许修改',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  DICT_TYPE_IN_USE: {
    code: 12030,
    message: '字典类型仍有项目引用,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_IN_USE: {
    code: 12031,
    message: '字典项仍被业务表引用,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
} as const;

export type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];
