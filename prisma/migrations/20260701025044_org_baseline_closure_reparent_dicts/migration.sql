-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "establishmentStatusCode" TEXT,
ADD COLUMN     "groupFunctionCode" TEXT;

-- CreateTable
CREATE TABLE "organization_closure" (
    "ancestorId" TEXT NOT NULL,
    "descendantId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "organization_closure_pkey" PRIMARY KEY ("ancestorId","descendantId")
);

-- CreateIndex
CREATE INDEX "organization_closure_descendantId_idx" ON "organization_closure"("descendantId");

-- CreateIndex
CREATE INDEX "organization_closure_ancestorId_depth_idx" ON "organization_closure"("ancestorId", "depth");

-- AddForeignKey
ALTER TABLE "organization_closure" ADD CONSTRAINT "organization_closure_ancestorId_fkey" FOREIGN KEY ("ancestorId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_closure" ADD CONSTRAINT "organization_closure_descendantId_fkey" FOREIGN KEY ("descendantId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill closure from existing adjacency tree (终态 scoped-authz PR1;冻结稿 §3.8/§8.3).
-- 一次性从现有 parentId 树回填全部 (ancestor,descendant,depth) 行(含每节点 depth-0 自身行)。
-- 已有库(生产/开发):节点先于本 migration 存在 → 此处一次回填全树;
-- 全新库:migration 先于 seed 跑、Organization 为空 → 此处插 0 行,内置 16 节点由 seed 幂等补齐 closure。
-- 新表本 migration 内建 + 填,无并发写入;INSERT 一次执行,无需 ON CONFLICT。
INSERT INTO "organization_closure" ("ancestorId", "descendantId", "depth")
WITH RECURSIVE "tree" AS (
    -- 基:每节点 depth-0 自身行
    SELECT "id" AS "ancestorId", "id" AS "descendantId", 0 AS "depth"
    FROM "Organization"
    UNION ALL
    -- 递推:沿 parentId 向下,祖先不变、后代为子、depth+1
    SELECT t."ancestorId", o."id" AS "descendantId", t."depth" + 1
    FROM "tree" t
    JOIN "Organization" o ON o."parentId" = t."descendantId"
)
SELECT "ancestorId", "descendantId", "depth" FROM "tree";
