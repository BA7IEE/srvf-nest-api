import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { resolveMemberReadScope } from './member-read-scope';
import { MembersQueryService } from './members-query.service';
import { normalizeMemberNo } from './members.policy';

// MemberReferenceResolver —— 「给机器确认人」(issue #1048 §5.2 / T3)。
//
// ⚠️ 命名是 issue 点名要求的:必须与既有 `RecruitmentIdentityService` 区分开。
// 两者关心的**不是**同一件事:
//   - `RecruitmentIdentityService` = 招新**申请人**的身份核验(短信验证码 / 微信绑定 / 实名 OCR),
//     处理的是「这个还不是队员的人,是不是他本人」;
//   - 本类 = 把一段**队员引用**(编号 / 姓名 / 外号)解析成一个确定的 `memberId`,
//     处理的是「这条数据说的是队里哪一个人」。
//
// ── 本类的立场:宁可不认,也不猜 ────────────────────────────────────────────
// 四态 `MATCHED / NOT_FOUND / AMBIGUOUS / CONFLICT` 里,只有 `MATCHED` 才带 `memberId`。
// 任何一点不确定都必须落到另外三态之一,交给人去定 —— 机器不替人做身份判断。
// 故**没有**「宽松模式」:issue §5.2 只定义了严格模式,加一个宽松模式等于把
// 「猜」重新引进来,而那正是本类存在的理由所要消灭的东西。

/** 四态。只有 `MATCHED` 携带 `memberId`。 */
export type MemberReferenceResolution =
  | { readonly state: 'MATCHED'; readonly memberId: string }
  | { readonly state: 'NOT_FOUND' }
  | { readonly state: 'AMBIGUOUS' }
  | { readonly state: 'CONFLICT'; readonly reason: 'member-no-and-real-name-mismatch' };

/**
 * 引用输入。三项都可省略;都不给 → `NOT_FOUND`(没有可解析的东西,而不是"随便挑一个")。
 *
 * ⚠️ `nickname` **只在**「既没给 memberNo、也没给 realName」时参与,且**永远**不会促成
 * `MATCHED`(规则 4)。它不参与确认、也不用来在重名里二选一 —— 用外号在两个同名的人之间
 * 挑一个,正是 issue §5.2 明令禁止的「用外号自动确认身份」。
 */
export interface MemberReferenceQuery {
  readonly memberNo?: string;
  readonly realName?: string;
  readonly nickname?: string;
}

const NOT_FOUND: MemberReferenceResolution = { state: 'NOT_FOUND' };
const AMBIGUOUS: MemberReferenceResolution = { state: 'AMBIGUOUS' };

@Injectable()
export class MemberReferenceResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly query: MembersQueryService,
  ) {}

  /**
   * 严格解析。六条规则(issue §5.2)在下面逐条标注了落点。
   *
   * 🔴 规则 5 是**结构性**保证,不是约定:`currentUser` 是必填形参,方法体第一件事就是
   * 解析可见组织范围并把它 AND 进每一条查询。调用方**无法**在不提供身份的情况下调用它,
   * 也没有第二个"免范围"的重载。
   */
  async resolve(
    currentUser: CurrentUserPayload,
    reference: MemberReferenceQuery,
  ): Promise<MemberReferenceResolution> {
    // 规则 5:范围先行。无 member.read.record → 直接 30100(不是"解析不到")。
    const authScope = await resolveMemberReadScope(this.authz, currentUser);
    const scopeFilter = await this.query.buildOrganizationScopeFilter(
      authScope,
      undefined,
      undefined,
    );

    const memberNo = trimToUndefined(reference.memberNo, normalizeMemberNo);
    const realName = trimToUndefined(reference.realName);
    const nickname = trimToUndefined(reference.nickname);

    // ── 规则 1:给了 memberNo,就必须由它精确定位到恰好一名 ──────────────────
    if (memberNo !== undefined) {
      const hit = await this.findOne({ memberNo }, scopeFilter);
      // 编号查无此人 → NOT_FOUND。注意这也覆盖「编号真实存在、但在调用者可见范围外」:
      // 范围腿已经 AND 进去了,范围外的人对本次解析**根本不存在**(规则 5 的防跨范围枚举)。
      if (hit === null) return NOT_FOUND;

      // ── 规则 2:同时给了 realName 且规范化后不一致 → CONFLICT ──────────────
      // 不是 NOT_FOUND:两个信号互相打架,是**数据有问题**,必须让人看见,
      // 而不是悄悄按编号认下来(那会把一条错数据固化成一次正式关联)。
      if (realName !== undefined && !sameName(hit.realName, realName)) {
        return { state: 'CONFLICT', reason: 'member-no-and-real-name-mismatch' };
      }
      return { state: 'MATCHED', memberId: hit.id };
    }

    // ── 规则 3:只有姓名 —— 重名必须 AMBIGUOUS,不能挑一个 ────────────────────
    if (realName !== undefined) {
      const hits = await this.findUpToTwo({ realName: { equals: realName } }, scopeFilter);
      if (hits.length === 0) return NOT_FOUND;
      if (hits.length > 1) return AMBIGUOUS;
      return { state: 'MATCHED', memberId: hits[0].id };
    }

    // ── 规则 4:只剩外号 —— **永远**不返回 MATCHED,哪怕全队只有一个人叫这个外号 ──
    // 命中了就是 AMBIGUOUS(有候选、但必须由人确认),没命中才是 NOT_FOUND。
    // 这条是**否定式合同**:它的正确性不体现为"能返回什么",而体现为"永远不返回什么",
    // 故 spec 里专门有一条「唯一命中的外号仍不得 MATCHED」的反面样本钉住它。
    if (nickname !== undefined) {
      const hits = await this.findUpToTwo({ nickname: { equals: nickname } }, scopeFilter);
      return hits.length === 0 ? NOT_FOUND : AMBIGUOUS;
    }

    // 三项都没给:没有可解析的引用。
    return NOT_FOUND;
  }

  // ── 私有查询:范围腿在这里被 AND 进去,上面三个分支都绕不开 ────────────────
  private scopedWhere(
    predicate: Prisma.MemberWhereInput,
    scopeFilter: Prisma.MemberWhereInput | undefined,
  ): Prisma.MemberWhereInput {
    return notDeletedWhere(
      scopeFilter === undefined ? predicate : { AND: [predicate, scopeFilter] },
    );
  }

  private async findOne(
    predicate: Prisma.MemberWhereInput,
    scopeFilter: Prisma.MemberWhereInput | undefined,
  ): Promise<{ id: string; realName: string } | null> {
    return this.prisma.member.findFirst({
      where: this.scopedWhere(predicate, scopeFilter),
      select: { id: true, realName: true },
    });
  }

  /**
   * 只取两条 —— 判「是否唯一」不需要知道到底有几个。
   * 顺带避免把"候选人数"变成一个跨范围枚举的信号面。
   */
  private async findUpToTwo(
    predicate: Prisma.MemberWhereInput,
    scopeFilter: Prisma.MemberWhereInput | undefined,
  ): Promise<Array<{ id: string }>> {
    return this.prisma.member.findMany({
      where: this.scopedWhere(predicate, scopeFilter),
      select: { id: true },
      take: 2,
    });
  }
}

function trimToUndefined(
  raw: string | undefined,
  normalize: (value: string) => string = (value) => value.trim(),
): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = normalize(raw);
  return normalized === '' ? undefined : normalized;
}

/** 姓名比对口径:两端 trim 后逐字相等。刻意**不**做大小写折叠 / 全半角归一 / 拼音 —— 见类头注。 */
function sameName(left: string, right: string): boolean {
  return left.trim() === right.trim();
}
