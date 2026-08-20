import { Prisma } from '@prisma/client';
import { normalizeMemberNo } from './members.policy';

// MemberDirectory 的「给人找人」相关性排序(issue #1048 §5.1 / T2 DoD 2)。
//
// ── 为什么是「按级切分」而不是一条带 CASE 的裸 SQL ──────────────────────────
// 五级排序是相关性排序,Prisma 的 `orderBy` 表达不了(它排不了计算列)。
// 直觉做法是改 `$queryRaw` 写一条 `ORDER BY CASE …`。**本仓刻意不那么做**:
// 队员列表的 where 里带着 scoped authz 的组织范围腿
// (`buildOrganizationScopeFilter` → `MemberOrganizationMembership` 的在册谓词)。
// 一旦改裸 SQL,那条谓词就得在 SQL 里**重写一遍** —— 于是授权判定有了第二份真相,
// 两份各自演化,而漂移的表现是「多返了本不该看见的人」,不会有任何东西报错。
//
// 现在的做法:每一级都只是一个 `Prisma.MemberWhereInput`,与调用方算好的 base where
// 用 `AND` 合并。授权腿**原封不动地被复用**,不存在可漂移的第二份实现;
// 排序与分页仍然全部落在 SQL(count + skip/take),没有内存 filter/sort。
//
// 代价:每次搜索多 5 条 count 查询。管理面目录检索可以承受,换的是
// 「排序实现结构上不可能绕过授权」。
//
// ── 刻意不做(issue §5.1 第一版边界)──────────────────────────────────────
// 拼音猜测 / 错别字纠正 / 相似度绑定一律不做;重名、重外号**正常返回多条**,
// 由人去挑。自动"猜"是 §5.2 明令禁止的方向(外号永远不能自动确认身份)。

/** 五级相关性,**数组顺序即优先级**。仅用于文档与测试对齐,不参与运行时判定。 */
export const MEMBER_DIRECTORY_RANK_ORDER = [
  'memberNo-exact',
  'realName-exact',
  'memberNo-prefix',
  'realName-partial',
  'nickname-partial',
] as const;

export type MemberDirectoryRankName = (typeof MEMBER_DIRECTORY_RANK_ORDER)[number];

/**
 * 级内排序键。相关性只定到"级",级内还需要一个**确定**的次序,
 * 否则同一级里翻页会重复/漏行(PG 不保证无 ORDER BY 时的行序)。
 * `memberNo` 全局唯一,单它就够定序;补 `id` 只是防御性兜底。
 */
export const MEMBER_DIRECTORY_TIE_BREAK: Prisma.MemberOrderByWithRelationInput[] = [
  { memberNo: 'asc' },
  { id: 'asc' },
];

/**
 * 把搜索词拆成五级**互斥**谓词,顺序 = 优先级。
 *
 * 互斥是必须的:同一个人可能既是 memberNo 前缀命中、又是 realName 部分命中。
 * 不排除前序级,他会在两级里各被数一次 —— 分页 total 虚高,翻页出现重复行。
 * 故第 i 级显式排除前 i 级的并集。
 *
 * trim 统一在这里做(DTO 层没有 Transform);memberNo 侧复用 `normalizeMemberNo`,
 * 与写路径的归一口径保持同源,不另写一份 trim。
 */
export function buildMemberDirectoryRankLevels(rawQuery: string): Prisma.MemberWhereInput[] {
  const text = rawQuery.trim();
  const memberNo = normalizeMemberNo(rawQuery);
  const mode = 'insensitive' as const;

  const levels: Prisma.MemberWhereInput[] = [
    { memberNo: { equals: memberNo, mode } },
    { realName: { equals: text, mode } },
    { memberNo: { startsWith: memberNo, mode } },
    { realName: { contains: text, mode } },
    { nickname: { contains: text, mode } },
  ];

  return levels.map((level, index) =>
    index === 0 ? level : { AND: [level, { NOT: { OR: levels.slice(0, index) } }] },
  );
}
