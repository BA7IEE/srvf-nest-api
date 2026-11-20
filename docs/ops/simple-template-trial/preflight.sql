BEGIN READ ONLY;
SELECT json_build_object('db',current_database(),'sms',EXISTS(SELECT FROM sms_settings WHERE enabled AND "credentialConfigured" AND "providerType"::text='TENCENT_SMS' AND nullif("templateIdNotification",'') IS NOT NULL),'wecom',EXISTS(SELECT FROM wecom_settings WHERE enabled AND "messageEnabled" AND "credentialConfigured" AND "providerType"='WECOM'),'wechat',EXISTS(SELECT FROM wechat_settings WHERE enabled AND "credentialConfigured" AND "providerType"::text='WECHAT') AND EXISTS(SELECT FROM wechat_subscribe_templates WHERE enabled AND nullif("templateId",'') IS NOT NULL));
SELECT count(*) AS active_v3_plus FROM public."ActivityTemplate" WHERE "statusCode"='active' AND "schemaVersion">=3 AND "familyId" IS NOT NULL;
SELECT count(*) AS creation_permission FROM public.permissions WHERE code='activity.create.record';
ROLLBACK;
