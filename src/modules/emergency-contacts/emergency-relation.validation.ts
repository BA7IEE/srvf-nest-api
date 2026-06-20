import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// canonical:`emergency_relation` 字典 code 校验,单一事实来源。
//
// 由 `emergency-contacts.service`(create / update)与 `recruitment-promotion.service`
// (一键发号:直连 prisma 把报名 JSON 展开为 emergency_contacts 行)**共用**。
// 抽出独立纯函数(非 service)是为:promote 铁律「直连 prisma、不复用 service(防环)」下
// 仍能复用 canonical 校验,杜绝 promote 绕过字典校验持久化非法 relationCode(#399 F3)。
//
// `client` 取 `Prisma.TransactionClient`(事务 tx);`PrismaService` 亦结构兼容,可直接传裸 client。
export const EMERGENCY_RELATION_DICT_CODE = 'emergency_relation';

export async function assertEmergencyRelationCodeValid(
  client: Prisma.TransactionClient,
  relationCode: string,
): Promise<void> {
  const item = await client.dictItem.findFirst({
    where: {
      code: relationCode,
      status: DictItemStatus.ACTIVE,
      deletedAt: null,
      type: {
        code: EMERGENCY_RELATION_DICT_CODE,
        status: DictTypeStatus.ACTIVE,
        deletedAt: null,
      },
    },
    select: { id: true },
  });
  if (!item) throw new BizException(BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
}
