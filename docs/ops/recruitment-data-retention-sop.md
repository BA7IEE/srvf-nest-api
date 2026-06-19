# 招新报名失败者数据 Retention 手动清理 SOP(`recruitment_applications`)

> **性质**:运维侧**手动 psql + storage 作业**(维护者执行;系统侧零代码 / 零端点 / 零权限码 / **不引入 cron 清理**——`@nestjs/schedule` 解锁范围仅生日批,沿冻结评审稿 [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md`](../archive/reviews/queue-b-otp-birthday-infra-review.md) R-5)。
> **风险档位**:物理清敏感字段 + 删 storage blob = **D 档动作**;改 SQL 结构需先在 app_test 实测,**改保留窗口数值不需要**(§1 数值可改声明)。
> **背景**:招新报名采集了高敏感 PII(姓名 / 身份证号 / 证件照 / 手机 / 紧急联系人 / 精确生日 / 详细住址),**失败者(淘汰 / 落选)无长期保留这些字段的必要**;冻结评审稿 [`recruitment-phase1-review.md`](../archive/reviews/recruitment-phase1-review.md) 拍板 = **脱敏行级留存**:清敏感字段、保留可统计的脱敏维度,行本身不删(招新漏斗分析价值)。
> **两层身份铁律提醒**:本表临时编号绑报名记录、**永不进 members**;清理本表**不**触碰 `members` / `users` / `member_profiles`。

---

## 1. 留存策略(脱敏行级;数值可改)

**触发后清空(置 NULL;证件照另删 blob)= 高敏感 PII**:

| 字段 | 说明 |
|---|---|
| `realName` | 真实姓名 |
| `idCardNumber` | 身份证号(高敏感) |
| `birthDate` | 精确生日 |
| `phone` | 手机(仅通知用途) |
| `detailedAddress` | 详细住址 |
| `emergencyContacts` | 紧急联系人(JSON 数组) |
| `profileExtra` | 其余报名字段(本期最小) |
| `idCardImageKey` | 证件照 storage key(**先删 blob 再置 NULL**,§3 步 3-4) |
| `openid` | 微信 openid(可再识别个人,无统计价值;一并清) |
| `reviewNote` | 人工核验备注(可能含 PII) |

**保留(脱敏统计维度,招新漏斗分析)**:`cycleId`(轮次)/ `ageGroup`(年龄段)/ `genderCode`(性别)/ `cityDistrict`(城市到区)/ `sourceChannel`(来源渠道)/ `eliminationStage`(淘汰环节)/ `isForeigner`(是否外籍)/ `documentTypeCode` / `statusCode` / `verifyOutcome` / `createdAt`。

**标记**:清理后置 `sensitivePurgedAt = now()`(幂等锚——已清行不再重复处理)。

| 触发 | 保留窗口 | 理由 |
|---|---|---|
| 报名 **rejected**(实名核验未通过 / 人工拒) | rejected **30 天**后 | 失败者无长期留高敏感 PII 必要;30 天覆盖申诉 / 复核窗口 |
| 轮次 **结束**(`recruitment_cycles.statusCode='closed'`)且申请**不在 phase-2 在途/已转正**(`statusCode NOT IN ('verified','pending_evaluation','publicity','promoted')`) | 轮次 `closedAt` **30 天**后 | 轮次结束 = 该批招新收口,未通过 / 未进 phase-2 者一并脱敏 |

> **数值可改**:维护者可按需调整 30 天窗口(如合规要求延长),直接改本文件数值并在 §5 记录;无需重新评审。**禁止** < 7 天。
> **不在清理范围(phase-2 落地后 2026-06-19 true-up)**:① **phase-2 在途行** `statusCode IN ('verified','pending_evaluation','publicity')`(门槛 / 待综合评定 / 公示中,正流转中,数据保留至 promote 消费或被淘汰转 rejected)——含**外籍 publicity 行**(一键发号 skip,待 admin 手动建档,详 [`recruitment-phase2-review.md §10`](../archive/reviews/recruitment-phase2-review.md));② **`promoted` 行**——promote 时 PII 已**即时清**(`sensitivePurgedAt` 已置 + 敏感字段已 NULL + 证件照 blob 归 member),本 SOP 的 `sensitivePurgedAt IS NULL` 自动跳过,**无需也不应再清**;转正后 PII 由 `member_profiles` / `emergency_contacts` 承载,归既有成员数据治理(C-8 议题)。

## 2. 触发条件

满足任一即安排执行:

1. **例行**:每招新轮次结束后 30 天 + 1 周内一次;无活跃招新时每季度核查一次
2. **报警线**(查询 SQL 见 §3 步骤 1):待清理(符合 §1 触发且 `sensitivePurgedAt IS NULL`)行数 > **1,000**,或 storage 证件照目录体积超出预期

## 3. 执行步骤(强制顺序,不可跳步)

> 全程在生产库维护窗口执行;避开公开报名高峰。**先删 blob 后清 DB**——次序反了会丢失 key 导致 blob 成孤儿。

**步骤 1 — 待清理量查询(报警线核对)**:

```sql
-- 符合 §1 两触发、尚未清理的行数
SELECT count(*) AS to_purge
FROM recruitment_applications a
JOIN recruitment_cycles c ON c.id = a."cycleId"
WHERE a."deletedAt" IS NULL
  AND a."sensitivePurgedAt" IS NULL
  AND (
    (a."statusCode" = 'rejected' AND a."createdAt" < now() - interval '30 days')
    OR (c."statusCode" = 'closed' AND c."closedAt" < now() - interval '30 days' AND a."statusCode" NOT IN ('verified', 'pending_evaluation', 'publicity', 'promoted'))
  );
```

**步骤 2 — 表级备份(必做,清前最后一道后悔药)**:

```bash
pg_dump "$DATABASE_URL" -t recruitment_applications -t recruitment_cycles \
  -f recruitment-retention-backup-$(date +%Y%m%d).sql
```

**步骤 3 — 导出待删证件照 key 清单(删 blob 用)**:

```sql
\copy (
  SELECT a."idCardImageKey"
  FROM recruitment_applications a
  JOIN recruitment_cycles c ON c.id = a."cycleId"
  WHERE a."deletedAt" IS NULL AND a."sensitivePurgedAt" IS NULL
    AND a."idCardImageKey" IS NOT NULL
    AND (
      (a."statusCode" = 'rejected' AND a."createdAt" < now() - interval '30 days')
      OR (c."statusCode" = 'closed' AND c."closedAt" < now() - interval '30 days' AND a."statusCode" NOT IN ('verified', 'pending_evaluation', 'publicity', 'promoted'))
    )
) TO 'recruitment-idcard-keys-to-delete.txt';
```

**步骤 4 — 删除 storage blob(按 §3 清单逐 key 删)**:

- **LOCAL provider**:key 映射到 `<STORAGE_LOCAL_ROOT>/<key>`(key 形如 `recruitment/id-card/<cycleId>/<uuid>.jpg`)。逐行 `rm -f -- "<STORAGE_LOCAL_ROOT>/<key>"`(用 §3 清单;确认 root 路径无误,避免误删)。
- **COS provider**:用腾讯云 COS 控制台 / `coscmd delete` / SDK 按 key 批量删除对应对象。
- 删完抽查若干 key 确认对象已不存在(GET 返 404 / 文件不存在)。

> 本步骤在 DB 之外,无法纳入 DB 事务;故**先删 blob**——若某 key 删除失败,记录该 key 暂缓、**不**在步骤 5 清该行的 DB 字段(留 key 供重试),保持 DB key 与 blob 一致。

**步骤 5 — 事务内清敏感字段 + 标记(blob 已删成功的行)**:

```sql
BEGIN;

-- 5a. 预数(应与步骤 1 一致;若步骤 4 有暂缓 key,需在 WHERE 排除那些行)
SELECT count(*) AS purging
FROM recruitment_applications a
JOIN recruitment_cycles c ON c.id = a."cycleId"
WHERE a."deletedAt" IS NULL AND a."sensitivePurgedAt" IS NULL
  AND (
    (a."statusCode" = 'rejected' AND a."createdAt" < now() - interval '30 days')
    OR (c."statusCode" = 'closed' AND c."closedAt" < now() - interval '30 days' AND a."statusCode" NOT IN ('verified', 'pending_evaluation', 'publicity', 'promoted'))
  );

-- 5b. 清敏感字段 + 标记 sensitivePurgedAt(更新行数必须与 5a 一致;不一致 → ROLLBACK)
UPDATE recruitment_applications a
SET "realName" = NULL,
    "idCardNumber" = NULL,
    "birthDate" = NULL,
    "phone" = NULL,
    "detailedAddress" = NULL,
    "emergencyContacts" = NULL,
    "profileExtra" = NULL,
    "idCardImageKey" = NULL,
    "openid" = NULL,
    "reviewNote" = NULL,
    "sensitivePurgedAt" = now()
FROM recruitment_cycles c
WHERE c.id = a."cycleId"
  AND a."deletedAt" IS NULL AND a."sensitivePurgedAt" IS NULL
  AND (
    (a."statusCode" = 'rejected' AND a."createdAt" < now() - interval '30 days')
    OR (c."statusCode" = 'closed' AND c."closedAt" < now() - interval '30 days' AND a."statusCode" NOT IN ('verified', 'pending_evaluation', 'publicity', 'promoted'))
  );

COMMIT;
```

任何意外(行数不符 / 报错 / 误改 WHERE)→ `ROLLBACK;` 后停止并排查,**不得**带病重试。

**步骤 6 — 复核**:

```sql
-- 已清行的敏感字段应全 NULL,脱敏维度仍在
SELECT "cycleId", "statusCode", "ageGroup", "genderCode", "cityDistrict",
       "sourceChannel", "eliminationStage", "isForeigner",
       "realName", "idCardNumber", "idCardImageKey", "sensitivePurgedAt"
FROM recruitment_applications
WHERE "sensitivePurgedAt" IS NOT NULL
ORDER BY "sensitivePurgedAt" DESC LIMIT 20;

ANALYZE recruitment_applications;
```

**步骤 7 — 登记执行记录**(§5 表格加一行)。

## 4. 边界与禁止

- ❌ **不**删行(`DELETE` / 软删):脱敏维度留作招新漏斗统计;只清敏感字段
- ❌ **不**清 phase-2 在途行 `statusCode IN ('verified','pending_evaluation','publicity')`(正流转中,含外籍待手动建档的 publicity 行;§1 注);`promoted` 行 promote 已即时清(`sensitivePurgedAt` 已置,WHERE 自动跳过,不重复清)
- ❌ **不**碰 `members` / `users` / `member_profiles` / 任何非招新表
- ❌ **不**先清 DB 后删 blob(次序反 = blob 孤儿);**不**用 `TRUNCATE`
- ❌ **不**改 §1 触发 `WHERE` 列(`statusCode` / `createdAt` / 轮次 `closedAt` 为窗口锚)
- ❌ **不**把本 SOP 改造成 cron / 定时任务 / 应用层"自动清理开关"(需新 D 档评审解锁)
- 已清行(`sensitivePurgedAt IS NOT NULL`)被 WHERE 自动跳过,重复执行幂等安全

## 5. 执行记录

| 日期 | 执行人 | 轮次 | 清理行数 | 删 blob 数 | 暂缓 key 数 | 备份文件 | 备注 |
|---|---|---|---|---|---|---|---|
| (示例)2026-09-01 | 维护者 | 2026 年度招新 | 0 | 0 | 0 | recruitment-retention-backup-20260901.sql | 首次例行,未达窗口零清理 |
