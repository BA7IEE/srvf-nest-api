-- AlterEnum
-- 招新四期 S4a(H5 手机身份链;评审稿 §3.2 E-P4-3):SmsPurpose 加值 RECRUITMENT_BIND。
-- **不可逆**:PostgreSQL ALTER TYPE ... ADD VALUE 不可删(沿 add_sms_purpose_login / _password_reset 范式,
-- 独立成 migration 隔离不可逆动作并回避「同事务不能使用新枚举值」陷阱)。本 migration 不使用该值。
ALTER TYPE "SmsPurpose" ADD VALUE 'RECRUITMENT_BIND';
