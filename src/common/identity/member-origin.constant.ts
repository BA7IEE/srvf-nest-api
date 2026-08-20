// `Member.memberOriginCode` 的字典码常量(issue #1048 T1)。
//
// 为什么单独一个文件:这几个码同时被**三个运行时**消费 ——
//   ① `prisma/seed.ts`(建字典项)
//   ② `recruitment-promotion.service.ts`(招新转入写路径)
//   ③ `members.service.ts` 的调用方 / 导入脚本(管理员与历史录入)
// 字面串各写一遍,就会出现「seed 里是 `import`、写路径里是 `imported`」这种
// 只有跑到线上才发现的错位;而字典是**自由串候选字典、无 FK**,DB 不会替你拦。
//
// ⚠️ 维护者 2026-08-20 拍板:**code 已按长期契约锁定,label 待与队里确认后定稿**
// (见字典定稿单)。改 label 不影响本文件,也不阻塞任何一刀;改 code 才是契约变更。

/** 字典 type code。`MemberProfile.joinSourceCode` 时代沿用至今,不改名。 */
export const MEMBER_ORIGIN_DICT_TYPE = 'join_source';

/** 招新转入 —— `recruitment-promotion.service.ts` 的 promote 事务直写。 */
export const MEMBER_ORIGIN_RECRUITMENT = 'recruitment';

/** 管理员在后台手工建档。 */
export const MEMBER_ORIGIN_MANUAL = 'manual';

/** 历史队员一次性录入(维护者拍板的存量迁移路径:走 API 脚本,不走 DB migration)。 */
export const MEMBER_ORIGIN_IMPORT = 'import';

/**
 * 本仓**已知**的来源码全集。
 *
 * ⚠️ 刻意不拿它做入参校验:`join_source` 是自由串候选字典(MP-28 起就是),
 * 运营可以在后台自行增码。把它当闭集校验会让「后台加了个码却建不了队员」——
 * 那是把一份供参考的清单误当成合同。真要收窄成闭集,得先改字典本身的语义。
 */
export const KNOWN_MEMBER_ORIGIN_CODES = [
  MEMBER_ORIGIN_RECRUITMENT,
  MEMBER_ORIGIN_MANUAL,
  MEMBER_ORIGIN_IMPORT,
] as const;
