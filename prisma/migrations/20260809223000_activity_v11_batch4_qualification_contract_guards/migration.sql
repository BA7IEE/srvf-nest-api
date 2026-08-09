-- 活动改造 v1.1 第 4 批⑪前置 D：资格规则精确编码、作用域与冻结版本闭环。
--
-- 本 migration 只收紧空存储：零业务 DML、零修数、零回填。任何既有资格行或
-- 岗位规则指针都会在 DDL 前 fail-closed；事务回滚后旧 FK / 索引保持原样。

BEGIN;

-- 四表按稳定顺序一次取最终锁级，阻断 preflight 到 DDL 间的并发写入窗口。
LOCK TABLE "ActivitySessionPosition" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityQualificationRuleSet" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityQualificationRule" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "QualificationEvaluationSnapshot" IN ACCESS EXCLUSIVE MODE;

-- 只计数、不取样、不输出 ID、不猜编码，也不对业务数据做任何修复。
DO $qualification_contract_storage_preflight$
DECLARE
  position_pointer_count bigint;
  rule_set_count bigint;
  rule_count bigint;
  snapshot_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO position_pointer_count
  FROM "ActivitySessionPosition"
  WHERE "qualificationRuleSetId" IS NOT NULL;

  SELECT COUNT(*) INTO rule_set_count FROM "ActivityQualificationRuleSet";
  SELECT COUNT(*) INTO rule_count FROM "ActivityQualificationRule";
  SELECT COUNT(*) INTO snapshot_count FROM "QualificationEvaluationSnapshot";

  IF position_pointer_count <> 0
     OR rule_set_count <> 0
     OR rule_count <> 0
     OR snapshot_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_qualification_contract_storage_preflight',
      MESSAGE = 'qualification contract migration storage preflight violation',
      DETAIL = format(
        'position_pointer_count=%s, rule_set_count=%s, rule_count=%s, snapshot_count=%s',
        position_pointer_count,
        rule_set_count,
        rule_count,
        snapshot_count
      );
  END IF;
END
$qualification_contract_storage_preflight$;

-- 空表前提已由上段锁定并验证。两列都不设默认值；warnScore 保持 nullable，
-- evaluationPhaseCode 是显式写入的必填冻结事实。
ALTER TABLE "ActivityQualificationRule"
  ADD COLUMN "warnScore" INTEGER;

ALTER TABLE "QualificationEvaluationSnapshot"
  ADD COLUMN "evaluationPhaseCode" TEXT NOT NULL;

-- 为新增完整复合 FK 准备被引用的唯一键；旧单列 FK 与既有索引一律不动。
ALTER TABLE "ActivitySessionPosition"
  ADD CONSTRAINT "activity_session_position_activity_session_id_key"
  UNIQUE ("activityId", "sessionId", "id");

ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_scope_pointer_key"
  UNIQUE ("activityId", "sessionId", "positionId", "id");

-- qualification-83:scope-check:begin
-- positionId 有值即为岗位级作用域，必须同时带 sessionId；活动级与场次级继续允许。
ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_scope_shape_check"
  CHECK ("positionId" IS NULL OR "sessionId" IS NOT NULL);
-- qualification-83:scope-check:end

ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_status_code_check"
  CHECK ("statusCode" IN ('draft', 'active', 'retired'));

-- qualification-83:ruleset-position-fk:begin
-- 正向：规则集的活动/场次/岗位三元组必须就是该岗位自身的三元组。
ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_activity_session_position_fkey"
  FOREIGN KEY ("activityId", "sessionId", "positionId")
  REFERENCES "ActivitySessionPosition" ("activityId", "sessionId", "id")
  MATCH SIMPLE
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- 反向：岗位指针只能指向本活动、本场次、且 positionId 就是自身的规则集。
ALTER TABLE "ActivitySessionPosition"
  ADD CONSTRAINT "activity_session_position_qualification_rule_set_scope_fkey"
  FOREIGN KEY ("activityId", "sessionId", "id", "qualificationRuleSetId")
  REFERENCES "ActivityQualificationRuleSet" ("activityId", "sessionId", "positionId", "id")
  MATCH SIMPLE
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
-- qualification-83:ruleset-position-fk:end

-- JSON CHECK 不允许子查询，故把确定性形状校验封在 immutable 辅助函数中。
CREATE FUNCTION activity_qualification_string_array_json_valid(input_value JSONB, array_key TEXT)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $activity_qualification_string_array_json_valid$
DECLARE
  item_value jsonb;
  item_text text;
  seen_values text[] := ARRAY[]::text[];
BEGIN
  IF input_value IS NULL
     OR jsonb_typeof(input_value) <> 'object'
     OR array_key IS NULL
     OR btrim(array_key) = '' THEN
    RETURN false;
  END IF;

  IF input_value <> jsonb_build_object(array_key, input_value -> array_key) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(input_value -> array_key) <> 'array'
     OR jsonb_array_length(input_value -> array_key) = 0 THEN
    RETURN false;
  END IF;

  FOR item_value IN SELECT value FROM jsonb_array_elements(input_value -> array_key)
  LOOP
    IF jsonb_typeof(item_value) <> 'string' THEN
      RETURN false;
    END IF;
    item_text := item_value #>> '{}';
    IF btrim(item_text) = '' OR item_text = ANY(seen_values) THEN
      RETURN false;
    END IF;
    seen_values := array_append(seen_values, item_text);
  END LOOP;

  RETURN true;
END;
$activity_qualification_string_array_json_valid$;

CREATE FUNCTION activity_qualification_age_range_json_valid(input_value JSONB)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $activity_qualification_age_range_json_valid$
DECLARE
  min_text text;
  max_text text;
  has_min boolean;
  has_max boolean;
BEGIN
  IF input_value IS NULL OR jsonb_typeof(input_value) <> 'object' THEN
    RETURN false;
  END IF;

  IF input_value <> jsonb_strip_nulls(
    jsonb_build_object('minYears', input_value -> 'minYears', 'maxYears', input_value -> 'maxYears')
  ) THEN
    RETURN false;
  END IF;

  has_min := input_value ? 'minYears';
  has_max := input_value ? 'maxYears';
  IF NOT has_min AND NOT has_max THEN
    RETURN false;
  END IF;

  IF has_min THEN
    IF jsonb_typeof(input_value -> 'minYears') <> 'number' THEN
      RETURN false;
    END IF;
    min_text := input_value ->> 'minYears';
    IF min_text !~ '^(0|[1-9][0-9]*)$' THEN
      RETURN false;
    END IF;
  END IF;

  IF has_max THEN
    IF jsonb_typeof(input_value -> 'maxYears') <> 'number' THEN
      RETURN false;
    END IF;
    max_text := input_value ->> 'maxYears';
    IF max_text !~ '^(0|[1-9][0-9]*)$' THEN
      RETURN false;
    END IF;
  END IF;

  -- 允许单边；双边时不人为追加年龄上限，只用位数和 C 排序比较任意精度非负整数。
  IF NOT (has_min AND has_max) THEN
    RETURN true;
  END IF;

  RETURN length(min_text) < length(max_text)
     OR (length(min_text) = length(max_text) AND min_text COLLATE "C" <= max_text COLLATE "C");
END;
$activity_qualification_age_range_json_valid$;

-- qualification-83:operator-value-check:begin
ALTER TABLE "ActivityQualificationRule"
  ADD CONSTRAINT "activity_qualification_rule_operator_value_json_check"
  CHECK (
    CASE
      WHEN "ruleTypeCode" IN ('grade', 'gender') THEN
        "operator" = 'in' AND activity_qualification_string_array_json_valid("valueJson", 'codes')
      WHEN "ruleTypeCode" = 'organization' THEN
        "operator" = 'in_subtree'
        AND activity_qualification_string_array_json_valid("valueJson", 'organizationIds')
      WHEN "ruleTypeCode" IN ('certificate', 'training') THEN
        "operator" = 'has_any'
        AND activity_qualification_string_array_json_valid("valueJson", 'standardIds')
      WHEN "ruleTypeCode" = 'age' THEN
        "operator" = 'between' AND activity_qualification_age_range_json_valid("valueJson")
      WHEN "ruleTypeCode" = 'insurance' THEN
        "operator" = 'covers_activity' AND "valueJson" IS NULL
      ELSE true
    END
  );
-- qualification-83:operator-value-check:end

ALTER TABLE "ActivityQualificationRule"
  ADD CONSTRAINT "activity_qualification_rule_warn_score_check"
  CHECK (
    CASE
      WHEN "enforcementCode" = 'block' THEN "warnScore" IS NULL
      WHEN "enforcementCode" = 'warn' THEN "warnScore" IS NOT NULL AND "warnScore" BETWEEN 0 AND 100
      ELSE true
    END
  );

ALTER TABLE "QualificationEvaluationSnapshot"
  ADD CONSTRAINT "qualification_evaluation_snapshot_phase_code_check"
  CHECK ("evaluationPhaseCode" IN ('display', 'submit', 'review'));

ALTER TABLE "QualificationEvaluationSnapshot"
  ADD CONSTRAINT "qualification_evaluation_snapshot_phase_anchor_check"
  CHECK (
    CASE
      WHEN "evaluationPhaseCode" = 'display' THEN
        "identityId" IS NULL AND "registrationRevisionId" IS NULL
      WHEN "evaluationPhaseCode" IN ('submit', 'review') THEN
        "registrationRevisionId" IS NOT NULL
      ELSE true
    END
  );

-- 同一三级作用域的版本与 active 规则集都必须唯一；可空 scope 列也参与去重。
CREATE UNIQUE INDEX "activity_qualification_rule_set_scope_version_unique"
ON "ActivityQualificationRuleSet" ("activityId", "sessionId", "positionId", "version")
NULLS NOT DISTINCT;

-- qualification-83:active-unique:begin
CREATE UNIQUE INDEX "activity_qualification_rule_set_scope_active_unique"
ON "ActivityQualificationRuleSet" ("activityId", "sessionId", "positionId")
NULLS NOT DISTINCT
WHERE "statusCode" = 'active';
-- qualification-83:active-unique:end

-- active 仅可退役，retired 永不再写；draft 保持可编辑以完成发布前编排。
CREATE FUNCTION activity_qualification_rule_set_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_qualification_rule_set_freeze_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."statusCode" IN ('active', 'retired') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_qualification_rule_set_frozen',
        MESSAGE = 'activity_qualification_rule_set_frozen: active or retired qualification rule set is frozen';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."statusCode" = 'retired' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_qualification_rule_set_frozen',
      MESSAGE = 'activity_qualification_rule_set_frozen: active or retired qualification rule set is frozen';
  END IF;

  IF OLD."statusCode" = 'active'
     AND (
       NEW."statusCode" IS DISTINCT FROM 'retired'
       OR NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."activityId" IS DISTINCT FROM OLD."activityId"
       OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
       OR NEW."positionId" IS DISTINCT FROM OLD."positionId"
       OR NEW."version" IS DISTINCT FROM OLD."version"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_qualification_rule_set_frozen',
      MESSAGE = 'activity_qualification_rule_set_frozen: active qualification rule set only permits retirement';
  END IF;

  RETURN NEW;
END;
$activity_qualification_rule_set_freeze_guard$;

-- 子规则先锁住所属规则集，防止一边冻结、一边写入时绕过冻结边界。
CREATE FUNCTION activity_qualification_rule_parent_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_qualification_rule_parent_freeze_guard$
DECLARE
  rule_set_ids text[];
  locked_rule_set record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    rule_set_ids := ARRAY[NEW."ruleSetId"];
  ELSIF TG_OP = 'DELETE' THEN
    rule_set_ids := ARRAY[OLD."ruleSetId"];
  ELSE
    rule_set_ids := ARRAY[OLD."ruleSetId", NEW."ruleSetId"];
  END IF;

  FOR locked_rule_set IN
    SELECT "id", "statusCode"
    FROM "ActivityQualificationRuleSet"
    WHERE "id" = ANY(rule_set_ids)
    ORDER BY "id"
    FOR UPDATE
  LOOP
    IF locked_rule_set."statusCode" IN ('active', 'retired') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_qualification_rule_parent_frozen',
        MESSAGE = 'activity_qualification_rule_parent_frozen: qualification rule belongs to a frozen rule set';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$activity_qualification_rule_parent_freeze_guard$;

-- qualification-83:immutability-triggers:begin
CREATE FUNCTION qualification_evaluation_snapshot_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $qualification_evaluation_snapshot_append_only_guard$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'qualification_evaluation_snapshot_append_only',
    MESSAGE = 'qualification_evaluation_snapshot_append_only: qualification evaluation snapshots are append-only';
END;
$qualification_evaluation_snapshot_append_only_guard$;

CREATE TRIGGER trg_activity_qualification_rule_set_10_freeze
BEFORE UPDATE OR DELETE ON "ActivityQualificationRuleSet"
FOR EACH ROW EXECUTE FUNCTION activity_qualification_rule_set_freeze_guard();

CREATE TRIGGER trg_activity_qualification_rule_10_parent_freeze
BEFORE INSERT OR UPDATE OR DELETE ON "ActivityQualificationRule"
FOR EACH ROW EXECUTE FUNCTION activity_qualification_rule_parent_freeze_guard();

CREATE TRIGGER trg_qualification_evaluation_snapshot_10_append_only
BEFORE UPDATE OR DELETE ON "QualificationEvaluationSnapshot"
FOR EACH ROW EXECUTE FUNCTION qualification_evaluation_snapshot_append_only_guard();
-- qualification-83:immutability-triggers:end

COMMIT;
