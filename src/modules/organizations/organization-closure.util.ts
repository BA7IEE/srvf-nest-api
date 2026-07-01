// 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.8 / §8.3):组织闭包表纯逻辑。
//
// 本文件只做**纯计算**(无 IO / 无 Prisma / 无副作用),把 closure 边的增量维护算法从 service 的
// 事务读写里抽出来,便于独立单测(create 继承边 / reparent 环判定 / reparent 插入边)。
// service 负责用事务读出所需 closure 行,喂给这里的纯函数算出要写的边,再落库。
//
// **本刀 closure 只建 + 维护,绝不被任何模块读作授权**(AuthzService 是 PR8);这里的函数也只算结构边,
// 不含任何权限语义。

/** 一条 closure 边(祖先 → 后代,距离 depth;depth=0 即自身行)。 */
export interface ClosureEdge {
  ancestorId: string;
  descendantId: string;
  depth: number;
}

/** 某后代的一条祖先记录 = closure 查 `descendantId = X` 的结果形状(含 X 自身 depth-0)。 */
export interface AncestorRef {
  ancestorId: string;
  depth: number;
}

/** 某祖先的一条后代记录 = closure 查 `ancestorId = X` 的结果形状(含 X 自身 depth-0)。 */
export interface DescendantRef {
  descendantId: string;
  depth: number;
}

/**
 * create 维护:新节点 `nodeId` 挂到某父下时应插入的 closure 边。
 * `parentAncestors` = closure 查 `descendantId = parentId` 的全部行(含父自身 depth-0);
 * 返回 = 自身 depth-0 行 + 继承父每条祖先各 +1。建根(`parentAncestors` 为空)→ 仅自身行。
 */
export function buildCreateClosureEdges(
  nodeId: string,
  parentAncestors: readonly AncestorRef[],
): ClosureEdge[] {
  const edges: ClosureEdge[] = [{ ancestorId: nodeId, descendantId: nodeId, depth: 0 }];
  for (const a of parentAncestors) {
    edges.push({ ancestorId: a.ancestorId, descendantId: nodeId, depth: a.depth + 1 });
  }
  return edges;
}

/**
 * reparent 环判定:目标父 `newParentId` 是否 = 被移动节点自身或其后代。
 * `subtreeDescendantIds` = closure 查 `ancestorId = nodeId` 的 descendantId 集(含自身)。
 * 命中即成环 → reparent 必须拒(ORGANIZATION_PARENT_CYCLE)。
 */
export function isReparentCycle(
  newParentId: string,
  subtreeDescendantIds: Iterable<string>,
): boolean {
  for (const id of subtreeDescendantIds) {
    if (id === newParentId) return true;
  }
  return false;
}

/**
 * reparent 维护:移动后应插入的 closure 边 = 新父全部祖先(`newParentAncestors`,含新父自身 depth-0)
 * × 被移动子树全部后代(`subtree`,含被移动节点自身 depth-0)的笛卡尔积;
 * depth = 新祖先→新父距离 + 被移动节点→后代距离 + 1(+1 = 新父→被移动节点这条新边)。
 * (旧祖先→子树的边由 service 用 deleteMany 双 `in` 直接删,无需纯函数枚举。)
 */
export function buildReparentEdgesToInsert(
  newParentAncestors: readonly AncestorRef[],
  subtree: readonly DescendantRef[],
): ClosureEdge[] {
  const edges: ClosureEdge[] = [];
  for (const sup of newParentAncestors) {
    for (const sub of subtree) {
      edges.push({
        ancestorId: sup.ancestorId,
        descendantId: sub.descendantId,
        depth: sup.depth + sub.depth + 1,
      });
    }
  }
  return edges;
}
