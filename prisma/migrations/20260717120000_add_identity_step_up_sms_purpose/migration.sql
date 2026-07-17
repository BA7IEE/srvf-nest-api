-- Identity Session P0 PR1:仅新增当前手机号 step-up 验证码 purpose。
-- PostgreSQL enum ADD VALUE 不做 down migration；无表/列/索引/回填/seed。
ALTER TYPE "SmsPurpose" ADD VALUE 'IDENTITY_STEP_UP';
