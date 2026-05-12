// V2 第一阶段批次 6 audit_logs 敏感字段打码工具(D6 v1.1 §7.1 / D-C 拍板)。
//
// 调用纪律(D6 v1.1 §7.2):
// - 纯 in/out,无依赖,可单元测试
// - 由 service 调用方在构造 before / after JSON 前调用
// - AuditLogsService.log() 不二次打码
// - 边界 null / undefined / 空字符串统一短路返回 null
//   (与 V2 baseline §2.3 / v1 §11 "空字符串按未填写处理"一致)
//
// 打码矩阵(D6 v1.1 §7.3 第一批):
// - emergency_contact.contactName  → maskName
// - emergency_contact.phonePrimary → maskPhone
// - emergency_contact.phoneBackup  → maskPhone
// - emergency_contact.address      → maskAddress
// - maskIdCard 第一批无调用方,预备能力,V2 第二阶段 member_profiles 复活时使用
//
// 本工具不做"业务字段是否敏感"的判断,只负责按规则打码;
// 是否调用打码由 service 层根据 D6 v1.1 §7.3 矩阵决策。

// "张三"   → "张*"
// "王五六" → "王**"
// "a"      → "*"   (单字符特殊:不暴露原值)
// null / undefined / "" → null
export function maskName(name: string | null | undefined): string | null {
  if (name === null || name === undefined || name === '') return null;
  if (name.length === 1) return '*';
  return name[0] + '*'.repeat(name.length - 1);
}

// "13800001111" → "138****1111"
// 长度 ≠ 11      → "****"        (D6 v1.1 §7.1 非常规手机号统一掩去)
// null / undefined / "" → null
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined || phone === '') return null;
  if (phone.length !== 11) return '****';
  return phone.substring(0, 3) + '****' + phone.substring(7);
}

// 保留前 6 字符,其余固定填 6 个 "*"(D6 v1.1 §7.1 / D-C 拍板)。
// "广东省深圳市福田区莲花街道..." → "广东省深圳市******"
// "广东省深圳市" (恰 6 字符)     → "广东省深圳市******"
// "深圳"        (< 6 字符)       → "深圳******"  (字面执行:前 6 字符 = 全部 + 6 个 *)
// null / undefined / "" → null
export function maskAddress(addr: string | null | undefined): string | null {
  if (addr === null || addr === undefined || addr === '') return null;
  return addr.substring(0, 6) + '******';
}

// "110101199001011234" (18 位) → "110101********1234"
// "110101900101123"    (15 位) → "110101*****1234"
// 长度 ≠ 15/18                  → "****"
// null / undefined / ""        → null
//
// 注:第一批无实际调用方;预备能力,V2 第二阶段 member_profiles 复活后用于
// MemberProfile.documentNumber 字段打码。
export function maskIdCard(idCard: string | null | undefined): string | null {
  if (idCard === null || idCard === undefined || idCard === '') return null;
  if (idCard.length === 18) return idCard.substring(0, 6) + '********' + idCard.substring(14);
  if (idCard.length === 15) return idCard.substring(0, 6) + '*****' + idCard.substring(11);
  return '****';
}
