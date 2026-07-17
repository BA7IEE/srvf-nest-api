# ContributionRule ACTIVE pair migration preflight

> 适用 migration:`20260718160000_contribution_rule_active_pair_unique`。
> 本 SOP 只提供只读冲突检查与部署失败处置；不提供自动选赢家、批量停用、软删、物理删除、回填或历史 `AttendanceRecord` 重算。

## 1. 部署前只读检查

在目标环境执行以下只读 SQL：

```sql
SELECT
  "activityTypeCode",
  "attendanceRoleCode",
  count(*) AS "activeCount",
  array_agg("id" ORDER BY "createdAt", "id") AS "ruleIds"
FROM "ContributionRule"
WHERE "deletedAt" IS NULL
  AND "status" = 'ACTIVE'
GROUP BY "activityTypeCode", "attendanceRoleCode"
HAVING count(*) > 1
ORDER BY "activityTypeCode", "attendanceRoleCode";
```

结果必须为 0 行才可执行已审查 migration：

```bash
pnpm prisma migrate deploy
```

禁止使用 `prisma migrate dev`、`prisma migrate reset` 或 `prisma db push`。

## 2. 冲突时的预期行为

migration 自带显式 `BEGIN` / `COMMIT`，并在扫描前取得 `ContributionRule` 的 PostgreSQL `SHARE` 表锁。该锁与 `INSERT` / `UPDATE` / `DELETE` 的 `ROW EXCLUSIVE` 锁冲突，并一直持有到旧索引删除、新 pair 索引创建完成，因而并发写不能滑入扫描与索引替换之间。随后 migration 在任何 `DROP INDEX` / `CREATE INDEX` 前扫描未软删 ACTIVE pair。存在冲突时会以 SQLSTATE `23505` 失败并回滚整个事务，错误消息列出冲突 pair 数和最多 20 个样例，并明确声明 migration 未做数据清理。

此时：

1. 停止部署，不要直接重试，也不要绕过 migration 直接建索引。
2. 保存错误输出与上节只读查询结果，由业务负责人逐 pair 决定唯一保留的 ACTIVE 规则。
3. 每条冲突的处理方式必须由负责人显式批准；系统不会按 `createdAt`、threshold 或分值自动选赢家。
4. 人工处置完成后运行 `pnpm prisma migrate status`，确认失败项精确为 `20260718160000_contribution_rule_active_pair_unique`。
5. 显式登记本次已由事务完整回滚，使 Prisma 允许重新应用该 migration：

   ```bash
   pnpm prisma migrate resolve --rolled-back 20260718160000_contribution_rule_active_pair_unique
   ```

6. 重跑上节只读冲突查询，确认仍为 0 行；再运行 `pnpm prisma migrate status` 确认该 migration 待应用，最后执行 `pnpm prisma migrate deploy`。

`migrate resolve --rolled-back` 只修复 Prisma 的 migration history 状态，不代替业务负责人逐 pair 处置存量冲突，也不得用 `--applied` 跳过本 migration。

历史 `AttendanceRecord.contributionPoints` 不因本 migration 回填或重算；`ContributionRule.dailyCap` 也不在本次范围内。

## 3. 部署后只读复核

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'contribution_rules_activity_role_threshold_active_unique',
    'contribution_rules_activity_role_active_unique'
  )
ORDER BY indexname;
```

预期仅有 `contribution_rules_activity_role_active_unique`，键列精确为 `("activityTypeCode", "attendanceRoleCode")`，谓词仍为 `"deletedAt" IS NULL AND "status" = 'ACTIVE'`。
