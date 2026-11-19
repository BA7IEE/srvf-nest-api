-- psql -X -v target_db=... -v cluster_id=... -v operation=apply|withdraw -f reconcile.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '4s';
SELECT set_config('t29.target', :'target_db', true),
       set_config('t29.cluster', :'cluster_id', true),
       set_config('t29.operation', :'operation', true);
LOCK TABLE public.permissions, public.roles, public.role_permissions, public.role_bindings,
 public.organization_position_role_policies IN SHARE ROW EXCLUSIVE MODE;
DO $body$
DECLARE
  x record;
  permission_row public.permissions%ROWTYPE;
  role_row public.roles%ROWTYPE;
  mapping_id text;
  op text := current_setting('t29.operation');
  installed boolean;
BEGIN
  IF current_database() <> current_setting('t29.target')
     OR current_database() NOT IN ('app_test','srvf_staging')
     OR (SELECT system_identifier::text FROM pg_control_system()) <> current_setting('t29.cluster')
     OR op NOT IN ('apply','withdraw','preview') THEN RAISE EXCEPTION 'target or operation mismatch'; END IF;
  IF EXISTS (SELECT FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
     OR (SELECT md5(string_agg(migration_name||':'||checksum,',' ORDER BY migration_name COLLATE "C"))
         FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
         IS DISTINCT FROM '0b99b396f3c0fbd103498dba166816ca' THEN RAISE EXCEPTION 'migration manifest mismatch'; END IF;
  FOR x IN SELECT * FROM (VALUES
    ('activity.update.record','update','部分更新活动(cancelled 拒改)','activity-owner','活动负责人','由 ActivityResponsibilityGrantProjector 按活动责任自动投影；禁止通用角色接口人工维护。'),
    ('activity.publish.record','publish','发布活动(draft → published)','activity-publish-reviewer','活动发布审核员','经显式 RoleBinding 配置的活动发布审核角色；零默认持有人、零 PositionRolePolicy。'),
    ('activity.settlement-final-review.record','settlement-final-review','终审活动结算版本并准备账本批次','attendance-final-reviewer','考勤终审员','考勤终审中枢角色(冻结稿场景 4 / BD-2):经显式 RoleBinding(标准形态 POSITION_ASSIGNMENT 主体 + ORGANIZATION_TREE@root)持有,行使 attendance.final-approve.sheet / final-reject.sheet / reopen.sheet + final-return.sheet + read.sheet;不随职务自动推导(零 PositionRolePolicy 行),换届撤任职即失权。自审禁止(SUPER_ADMIN 亦拒)与一级同人默认禁止由 authz ActionConstraint 承载,不在角色码集内。seed 零持有;绑定经 role-bindings CRUD 显式建(PR11 公告导入后运营挂)。')
  ) AS required(code,action,description,role_code,label,role_description) LOOP
    SELECT * INTO permission_row FROM public.permissions WHERE code=x.code;
    SELECT * INTO role_row FROM public.roles WHERE code=x.role_code;
    IF permission_row.id IS NOT NULL AND
      (permission_row.module,permission_row.action,permission_row."resourceType",permission_row.description,
       permission_row."servicePrincipalAllowed",permission_row."delegatedAccessAllowed")
      IS DISTINCT FROM ('activity'::text,x.action,'record'::text,x.description,false,false)
      THEN RAISE EXCEPTION 'permission definition conflict %',x.code; END IF;
    IF role_row.id IS NOT NULL AND (role_row."deletedAt" IS NOT NULL OR role_row."displayName"<>x.label
       OR role_row.description IS DISTINCT FROM x.role_description)
      THEN RAISE EXCEPTION 'role definition conflict %',x.role_code; END IF;
    IF EXISTS(SELECT FROM public.role_permissions rp JOIN public.permissions pm ON pm.id=rp."permissionId"
       WHERE rp."roleId"=role_row.id AND NOT(pm.code=ANY(CASE x.role_code WHEN 'attendance-final-reviewer' THEN ARRAY['attendance.read.sheet','attendance.final-approve.sheet','attendance.final-reject.sheet','attendance.reopen.sheet','attendance.final-return.sheet','activity.settlement-final-review.record'] WHEN 'activity-publish-reviewer' THEN ARRAY['activity-review.read.request','activity.publish.record','activity-review.return.request'] WHEN 'activity-owner' THEN ARRAY['activity.update.record','activity.cancel.record','activity.complete.record','activity-registration.read.record','activity-registration.create.record','activity-registration.approve.record','activity-registration.reject.record','activity-registration.cancel.record','activity-registration.reopen.record','attendance.read.sheet','attendance.create.sheet','attendance.update.sheet','attendance.delete.sheet','activity.settlement-generate.record','activity.settlement-update-draft.record','activity.settlement-submit.record','activity.settlement-close.record'] END)))
       THEN RAISE EXCEPTION 'unexpected existing permission set %',x.role_code; END IF;
    SELECT id INTO mapping_id FROM public.role_permissions
      WHERE "roleId"=role_row.id AND "permissionId"=permission_row.id;
    IF op IN ('apply','preview') AND mapping_id IS NOT NULL THEN CONTINUE; END IF;
    IF op='withdraw' AND mapping_id IS NULL THEN CONTINUE; END IF;
    IF op='withdraw' THEN
      SELECT EXISTS(SELECT FROM public.audit_logs WHERE event='ops.activity-catalog.apply'
        AND "resourceId"=mapping_id AND context->>'roleId'=role_row.id
        AND context->>'permissionId'=permission_row.id) INTO installed;
      IF NOT installed THEN CONTINUE; END IF;
    END IF;
    IF EXISTS(SELECT FROM public.role_bindings WHERE "roleId"=role_row.id)
       OR EXISTS(SELECT FROM public.organization_position_role_policies WHERE "roleId"=role_row.id)
      THEN RAISE EXCEPTION 'role is referenced %',x.role_code; END IF;
    IF op IN ('apply','preview') THEN
      IF permission_row.id IS NULL THEN
        INSERT INTO public.permissions(id,code,module,action,"resourceType",description,"updatedAt")
          VALUES ('c'||substr(replace(gen_random_uuid()::text,'-',''),1,24),x.code,'activity',x.action,'record',x.description,now())
          RETURNING * INTO permission_row;
      END IF;
      IF role_row.id IS NULL THEN
        INSERT INTO public.roles(id,code,"displayName",description,"updatedAt")
          VALUES ('c'||substr(replace(gen_random_uuid()::text,'-',''),1,24),x.role_code,x.label,x.role_description,now())
          RETURNING * INTO role_row;
      END IF;
      INSERT INTO public.role_permissions(id,"roleId","permissionId") VALUES
        ('c'||substr(replace(gen_random_uuid()::text,'-',''),1,24),role_row.id,permission_row.id)
        RETURNING id INTO mapping_id;
    ELSE
      DELETE FROM public.role_permissions WHERE id=mapping_id;
    END IF;
    UPDATE public.roles SET "permissionRevision"="permissionRevision"+1,"updatedAt"=now() WHERE id=role_row.id;
    INSERT INTO public.audit_logs(id,event,"resourceType","resourceId",context)
      VALUES(gen_random_uuid()::text,'ops.activity-catalog.'||op,'role-permission',mapping_id,
        jsonb_build_object('roleId',role_row.id,'permissionId',permission_row.id,'source','108feebb'));
  END LOOP;
END $body$;
SELECT current_setting('t29.operation')='preview' AS preview_only \gset
\if :preview_only
ROLLBACK;
\else
COMMIT;
\endif
