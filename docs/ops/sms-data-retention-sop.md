# SMS 数据 Retention 手动清理 SOP(`sms_verification_codes` / `sms_send_logs`)

> **性质**:运维侧**手动 psql 作业**(维护者执行;系统侧零代码 / 零端点 / 零权限码 / **不引入 cron 清理**——`@nestjs/schedule` 解锁范围仅生日批,沿冻结评审稿 [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md`](../archive/reviews/queue-b-otp-birthday-infra-review.md) D-QB-3/R-5)。
> **风险档位**:物理删数据 = **D 档动作**;本 SOP 的 SQL 已于 2026-06-11 在 app_test 库实测后冻结(记录见 F3 PR);改 SQL 结构需重新实测,**改保留数值不需要**(§1 数值可改声明)。
> **背景**:两表 append-only 只增不减(P1-6 拍板本期不清理,挂 NEXT_TASKS P2-6;2026-06-11 B 队列 goal 拍板以本 SOP 收口)。

---

## 1. 保留策略(数值可改)

| 表 | 保留窗口 | 理由 |
|---|---|---|
| `sms_verification_codes` | **90 天** | 验证码 5 分钟即失效,行仅剩排障 / 安全审计价值;90 天远超排障窗口 |
| `sms_send_logs` | **1 年** | 发送流水 = 费用对账 + 触达留痕;1 年覆盖年度对账。生日祝福幂等防重发仅查**当日**流水,清理永不影响 |

> **数值可改**:维护者可按需调整窗口(如审计要求延长),直接改本文件数值并在 §5 记录;无需重新评审。**禁止**把窗口调到 < 7 天(保留最近排障窗口)。

## 2. 触发条件

满足任一即安排执行:

1. **例行**:每季度一次(建议季度首月;真实通道开通后首月加查一次)
2. **报警线**(任一命中立即执行;查询 SQL 见 §3 步骤 1):
   - `sms_verification_codes` > **50,000 行**
   - `sms_send_logs` > **500,000 行**
   - 两表合计体积 > **100 MB**

## 3. 执行步骤(强制顺序,不可跳步)

> 全程在生产库维护窗口执行;预计锁影响极小(行级 DELETE),但仍避开 09:00(生日批)±15 分钟。

**步骤 1 — 体量查询(报警线核对)**:

```sql
SELECT 'sms_verification_codes' AS t, count(*) FROM sms_verification_codes
UNION ALL
SELECT 'sms_send_logs', count(*) FROM sms_send_logs;

SELECT pg_size_pretty(
  pg_total_relation_size('sms_verification_codes') + pg_total_relation_size('sms_send_logs')
) AS total_size;
```

**步骤 2 — 表级备份(必做,删前最后一道后悔药)**:

```bash
pg_dump "$DATABASE_URL" -t sms_verification_codes -t sms_send_logs \
  -f sms-retention-backup-$(date +%Y%m%d).sql
```

**步骤 3 — 事务内预数 + 删除 + 复核(2026-06-11 app_test 实测冻结版)**:

```sql
BEGIN;

-- 3a. 预数(记入 §5 执行记录)
SELECT count(*) AS codes_to_delete
  FROM sms_verification_codes WHERE "createdAt" < now() - interval '90 days';
SELECT count(*) AS logs_to_delete
  FROM sms_send_logs WHERE "createdAt" < now() - interval '1 year';

-- 3b. 删除(返回行数必须与 3a 预数一致;不一致 → ROLLBACK 排查)
DELETE FROM sms_verification_codes WHERE "createdAt" < now() - interval '90 days';
DELETE FROM sms_send_logs WHERE "createdAt" < now() - interval '1 year';

COMMIT;
```

任何意外(行数不符 / 报错 / 误改 WHERE)→ `ROLLBACK;` 后停止并排查,**不得**带病重试。

**步骤 4 — 统计刷新**:

```sql
ANALYZE sms_verification_codes;
ANALYZE sms_send_logs;
```

**步骤 5 — 登记执行记录**(§5 表格加一行)。

## 4. 边界与禁止

- ❌ **不**清理其他任何表(本 SOP 仅限两张 SMS 表)
- ❌ **不**用 `TRUNCATE`(绕过窗口语义)/ **不**改 `WHERE` 列(`createdAt` 为唯一窗口锚)
- ❌ **不**把本 SOP 改造成 cron / 定时任务(需新 D 档评审解锁,沿评审稿 R-5)
- ❌ **不**在应用层加"自动清理开关"
- `sms_send_logs` 当日行参与生日祝福幂等判定(评审稿 E-B6),窗口 ≥7 天即永不冲突

## 5. 执行记录

| 日期 | 执行人 | codes 删除行数 | logs 删除行数 | 备份文件 | 备注 |
|---|---|---|---|---|---|
| (示例)2026-09-01 | 维护者 | 0 | 0 | sms-retention-backup-20260901.sql | 首次例行,未达窗口零删除 |
