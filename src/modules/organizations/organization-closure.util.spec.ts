import {
  buildCreateClosureEdges,
  buildReparentEdgesToInsert,
  isReparentCycle,
  type AncestorRef,
  type DescendantRef,
} from './organization-closure.util';

// 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.8/§8.3):closure 纯逻辑单测。
// 覆盖 create 继承边 / reparent 环判定 / reparent 插入边。service 事务读写另由 e2e 覆盖。

// 稳定排序,便于结构断言(纯函数不保证顺序无关时用于比对)。
const sortEdges = <T extends { ancestorId: string; descendantId: string; depth: number }>(
  rows: T[],
): T[] =>
  [...rows].sort((a, b) =>
    `${a.ancestorId}|${a.descendantId}`.localeCompare(`${b.ancestorId}|${b.descendantId}`),
  );

describe('organization-closure.util', () => {
  describe('buildCreateClosureEdges', () => {
    it('建根(无父祖先)→ 仅自身 depth-0 行', () => {
      expect(buildCreateClosureEdges('root', [])).toEqual([
        { ancestorId: 'root', descendantId: 'root', depth: 0 },
      ]);
    });

    it('挂在根下 → 自身 + 根@depth1', () => {
      // parentAncestors = closure 查 descendantId=root:仅 root 自身 depth-0
      const parentAncestors: AncestorRef[] = [{ ancestorId: 'root', depth: 0 }];
      expect(sortEdges(buildCreateClosureEdges('child', parentAncestors))).toEqual(
        sortEdges([
          { ancestorId: 'child', descendantId: 'child', depth: 0 },
          { ancestorId: 'root', descendantId: 'child', depth: 1 },
        ]),
      );
    });

    it('挂在深层节点下 → 继承父全部祖先各 +1(祖父/父/自身三代)', () => {
      // parentAncestors = closure 查 descendantId=parent:parent@0, root@1
      const parentAncestors: AncestorRef[] = [
        { ancestorId: 'parent', depth: 0 },
        { ancestorId: 'root', depth: 1 },
      ];
      expect(sortEdges(buildCreateClosureEdges('leaf', parentAncestors))).toEqual(
        sortEdges([
          { ancestorId: 'leaf', descendantId: 'leaf', depth: 0 },
          { ancestorId: 'parent', descendantId: 'leaf', depth: 1 },
          { ancestorId: 'root', descendantId: 'leaf', depth: 2 },
        ]),
      );
    });
  });

  describe('isReparentCycle', () => {
    it('目标父 = 自身 → 成环(自身在子树集内)', () => {
      expect(isReparentCycle('n', ['n', 'a', 'b'])).toBe(true);
    });

    it('目标父 = 自身后代 → 成环', () => {
      expect(isReparentCycle('child', ['n', 'child', 'grandchild'])).toBe(true);
    });

    it('目标父在子树外 → 不成环', () => {
      expect(isReparentCycle('outsider', ['n', 'child'])).toBe(false);
    });

    it('空子树(理论边界)→ 不成环', () => {
      expect(isReparentCycle('x', [])).toBe(false);
    });
  });

  describe('buildReparentEdgesToInsert', () => {
    it('移动叶子到新父下 → 新父祖先链 × 该叶子', () => {
      // 新父祖先 = closure 查 descendantId=newParent:newParent@0, grandparent@1
      const newParentAncestors: AncestorRef[] = [
        { ancestorId: 'newParent', depth: 0 },
        { ancestorId: 'grandparent', depth: 1 },
      ];
      // 子树 = closure 查 ancestorId=node:仅 node 自身 depth-0
      const subtree: DescendantRef[] = [{ descendantId: 'node', depth: 0 }];
      expect(sortEdges(buildReparentEdgesToInsert(newParentAncestors, subtree))).toEqual(
        sortEdges([
          { ancestorId: 'newParent', descendantId: 'node', depth: 1 }, // 0+0+1
          { ancestorId: 'grandparent', descendantId: 'node', depth: 2 }, // 1+0+1
        ]),
      );
    });

    it('移动带子的子树 → 新父祖先 × 子树全部后代(笛卡尔积,depth=sup+sub+1)', () => {
      const newParentAncestors: AncestorRef[] = [{ ancestorId: 'np', depth: 0 }];
      // 子树:node 自身@0 + 其子 kid@1
      const subtree: DescendantRef[] = [
        { descendantId: 'node', depth: 0 },
        { descendantId: 'kid', depth: 1 },
      ];
      expect(sortEdges(buildReparentEdgesToInsert(newParentAncestors, subtree))).toEqual(
        sortEdges([
          { ancestorId: 'np', descendantId: 'node', depth: 1 }, // 0+0+1
          { ancestorId: 'np', descendantId: 'kid', depth: 2 }, // 0+1+1
        ]),
      );
    });

    it('多级新父 × 多级子树 → 全组合 depth 正确', () => {
      const newParentAncestors: AncestorRef[] = [
        { ancestorId: 'np', depth: 0 },
        { ancestorId: 'root', depth: 1 },
      ];
      const subtree: DescendantRef[] = [
        { descendantId: 'node', depth: 0 },
        { descendantId: 'kid', depth: 1 },
      ];
      const edges = buildReparentEdgesToInsert(newParentAncestors, subtree);
      expect(edges).toHaveLength(4);
      expect(sortEdges(edges)).toEqual(
        sortEdges([
          { ancestorId: 'np', descendantId: 'node', depth: 1 },
          { ancestorId: 'np', descendantId: 'kid', depth: 2 },
          { ancestorId: 'root', descendantId: 'node', depth: 2 },
          { ancestorId: 'root', descendantId: 'kid', depth: 3 },
        ]),
      );
    });
  });
});
