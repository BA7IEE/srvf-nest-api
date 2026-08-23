import { maskIdentifier } from '../../common/audit/mask-pii.util';
import {
  MEMBER_INSURANCE_ADMIN_SELECT,
  MEMBER_INSURANCE_SAFE_SELECT,
  MEMBER_INSURANCE_SENSITIVE_FIELDS,
  MEMBER_INSURANCE_SENSITIVE_SELECT,
  MEMBER_INSURANCE_WORKBENCH_SELECT,
  presentMemberInsuranceWorkbenchItem,
  type MemberInsuranceWorkbenchRow,
} from './member-insurance-projection';

// ⭐ 本刀的核心判据(goal §3 / DoD 3):单人面与跨队员工作台**共用同一份字段分级**。
//
// 为什么这条判据值得单独存在:两个面各写一份「哪些列该掩」时,漂移**没有症状** ——
// 不会有测试变红,不会有检查报警,只在有人真去比对两个响应那天才暴露。
// 所以这里断言的不是「两个面各自的行为对不对」,而是「它们是不是同一个来源」。
//
// 变异对拍(必红):
//   1. 工作台绕开 presenter,自己拼一份含明文 policyNumber 的出参 → 「不含敏感列原名/原值」两条红
//   2. 单人面 select 改回手抄字面量并少一列 → 「单人面 select == 安全列 ∪ 敏感列」红
//   3. 敏感分级里删掉 policyNumber → 「保单号被分级为敏感」红,且工作台泄漏原值那条同时红

const RAW_POLICY_NUMBER = 'PICC-WORKBENCH-RAW-SECRET-0001';

function buildRow(
  overrides: Partial<MemberInsuranceWorkbenchRow> = {},
): MemberInsuranceWorkbenchRow {
  return {
    id: 'insurance-1',
    memberId: 'member-1',
    insurerName: '中国人保',
    policyNumber: RAW_POLICY_NUMBER,
    coverageStart: new Date('2026-01-01T00:00:00.000Z'),
    coverageEnd: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    reviewStatusCode: 'pending',
    version: 0,
    reviewedAt: null,
    member: {
      id: 'member-1',
      memberNo: 'SRVF-0007',
      realName: '张三',
      nickname: '老三',
    },
    ...overrides,
  };
}

describe('MemberInsurance admin 投影:两个面共用一份字段分级', () => {
  describe('分级本身', () => {
    it('保单号被分级为敏感列', () => {
      expect(MEMBER_INSURANCE_SENSITIVE_FIELDS).toContain('policyNumber');
    });

    it('敏感列名清单由敏感 select 机械派生(不是另抄的一份数组)', () => {
      expect([...MEMBER_INSURANCE_SENSITIVE_FIELDS].sort()).toEqual(
        Object.keys(MEMBER_INSURANCE_SENSITIVE_SELECT).sort(),
      );
    });

    it('安全列与敏感列不相交 —— 一列不能同时是两种分级', () => {
      const safe = Object.keys(MEMBER_INSURANCE_SAFE_SELECT);
      const sensitive = Object.keys(MEMBER_INSURANCE_SENSITIVE_SELECT);
      expect(safe.filter((f) => sensitive.includes(f))).toEqual([]);
    });
  });

  describe('单人面走的是共享分级', () => {
    it('单人面 select == 安全列 ∪ 敏感列', () => {
      expect(Object.keys(MEMBER_INSURANCE_ADMIN_SELECT).sort()).toEqual(
        [
          ...Object.keys(MEMBER_INSURANCE_SAFE_SELECT),
          ...Object.keys(MEMBER_INSURANCE_SENSITIVE_SELECT),
        ].sort(),
      );
    });

    it('单人面口径未被本刀改动:仍取明文保单号(goal §6「不改单人端点」)', () => {
      expect(MEMBER_INSURANCE_ADMIN_SELECT).toHaveProperty('policyNumber', true);
    });
  });

  describe('工作台走的是同一份分级', () => {
    it('工作台 select 的标量列 == 单人面 select(同一份投影源,不是另写的一份)', () => {
      const workbenchScalar = Object.keys(MEMBER_INSURANCE_WORKBENCH_SELECT).filter(
        (k) => k !== 'member',
      );
      expect(workbenchScalar.sort()).toEqual(Object.keys(MEMBER_INSURANCE_ADMIN_SELECT).sort());
    });

    it('工作台出参不含任何敏感列的原名', () => {
      const item = presentMemberInsuranceWorkbenchItem(buildRow());
      for (const field of MEMBER_INSURANCE_SENSITIVE_FIELDS) {
        expect(item).not.toHaveProperty(field);
      }
    });

    it('工作台出参**任何角落**都不含敏感列原值', () => {
      const item = presentMemberInsuranceWorkbenchItem(buildRow());
      expect(JSON.stringify(item)).not.toContain(RAW_POLICY_NUMBER);
    });

    it('掩码走的是全仓共用的 maskIdentifier,不是自己写的一份', () => {
      const item = presentMemberInsuranceWorkbenchItem(buildRow());
      expect(item.policyNumberMasked).toBe(maskIdentifier(RAW_POLICY_NUMBER));
    });

    it('安全列在两个面逐字同名同值 —— 「口径一致」的真实落点', () => {
      const row = buildRow();
      const item = presentMemberInsuranceWorkbenchItem(row);
      for (const field of Object.keys(MEMBER_INSURANCE_SAFE_SELECT)) {
        // memberId 在工作台改由 member.id 承载,不给契约留两种表示。
        if (field === 'memberId') {
          expect(item.member.id).toBe(row.memberId);
          continue;
        }
        expect(item[field as keyof typeof item]).toEqual(row[field as keyof typeof row]);
      }
    });
  });

  describe('掩码边界', () => {
    it('保单号为空串时掩码为 null(不渲染成 "****" 之类的假值)', () => {
      const item = presentMemberInsuranceWorkbenchItem(buildRow({ policyNumber: '' }));
      expect(item.policyNumberMasked).toBeNull();
    });

    it('短保单号(≤4 位)整体打码,不泄漏首尾', () => {
      const item = presentMemberInsuranceWorkbenchItem(buildRow({ policyNumber: 'AB12' }));
      expect(item.policyNumberMasked).toBe('****');
    });
  });

  describe('队员标识', () => {
    it('label 走全仓统一拼装,外号为空时不渲染空括号', () => {
      const item = presentMemberInsuranceWorkbenchItem(
        buildRow({
          member: { id: 'member-1', memberNo: 'SRVF-0007', realName: '张三', nickname: '   ' },
        }),
      );
      expect(item.member.label).toBe('SRVF-0007 · 张三');
      expect(item.member.nickname).toBe('   ');
    });
  });
});
