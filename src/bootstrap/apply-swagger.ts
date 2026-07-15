import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '../config/app.config';

// 应用 Swagger 文档注册。main.ts 与 test/setup/test-app.ts 共用此函数,
// 与 applyGlobalSetup 同原则:避免 main.ts 与测试两边复制 Swagger 注册代码导致漂移
// (改了 main.ts 路径或选项,test 不跟,swagger spec 失效)。
//
// 内部判断 appCfg.swaggerEnabled,关闭则 no-op。
//
// 路径锚定:文档(ARCHITECTURE.md §6 / CLAUDE.md §4)固定 /api/docs。
// SwaggerModule 11 默认 setup() 不跟全局前缀,必须显式 useGlobalPrefix: true,
// 让其在 setGlobalPrefix('/api') 下注册到 /api/docs(及 /api/docs-json、/api/docs-yaml)。
export function applySwagger(app: INestApplication, appCfg: AppConfig): void {
  if (!appCfg.swaggerEnabled) return;

  // Phase 1A(2026-05-19):tag 顺序按 Auth / Public / Mobile / Admin / Ops 分组锁定。
  // DocumentBuilder.addTag(...) 仅决定 OpenAPI doc 顶层 tags[] 的顺序与描述,
  // **不**影响任何 operation 的 path / response / Guard;沿 docs/api-client-boundary-phase-1-review.md §2.2。
  const swaggerConfig = new DocumentBuilder()
    .setTitle('U Nest API Starter')
    .setDescription('AI-friendly TypeScript API base — NestJS + Prisma + PostgreSQL')
    .setVersion('0.51.0')
    .addBearerAuth()
    // ===== Auth / Public(全部客户端共用)=====
    .addTag('Auth', '身份认证与会话管理(login / refresh / logout / logout-all)')
    .addTag('Public', '公开能力(健康检查;无需鉴权)')
    // ===== Mobile(队员端 / 小程序 / App;当前登录人视角)=====
    // 注:'Mobile - Activities' 留到 Phase 2 新增 /api/app/v1/activities* 时再加入,
    //   Phase 1A 内**不**预声明无 endpoint 引用的空 tag(避免 Swagger UI 出现空分组)。
    .addTag('Mobile - Me', '队员端:当前登录人身份与基础资料')
    .addTag('Mobile - Registrations', '队员端:本人活动报名')
    .addTag('Mobile - Attendance', '队员端:本人考勤记录')
    .addTag('Mobile - Attachments', '队员端:本人上传的附件')
    .addTag(
      'Mobile - Capabilities',
      '队员端:当前登录人 capabilities(Phase 2 后 capability vs raw permission 拆分)',
    )
    // ===== Admin(PC 管理后台;资源管理视角)=====
    .addTag(
      'Admin - Users',
      '后台:账号管理(/:id 段;含创建 / 改资料 / 改角色 / 改状态 / 重置密码 / 软删)',
    )
    .addTag('Admin - Members', '后台:队员档案管理')
    .addTag('Admin - Member Profiles', '后台:队员详细资料(含敏感字段)')
    .addTag('Admin - Emergency Contacts', '后台:队员紧急联系人')
    .addTag('Admin - Certificates', '后台:队员证书 / 资质审核')
    .addTag('Admin - Organizations', '后台:组织节点树')
    .addTag('Admin - Member Departments', '后台:队员部门分配')
    .addTag('Admin - Activities', '后台:活动 CRUD + 发布 / 取消')
    .addTag('Admin - Registrations', '后台:活动报名审核 / 名单导出')
    .addTag('Admin - Attendances', '后台:考勤表管理 / 两级审批')
    .addTag('Admin - Attachments', '后台:附件管理(含 upload-url / confirm-upload 通用链路)')
    // ===== Ops(系统治理;默认仅 SUPER_ADMIN 或显式权限点)=====
    .addTag('Ops - Dictionaries', '运营:字典类型 / 字典项 CRUD')
    .addTag('Ops - Permissions', '运营:RBAC permission code 配置')
    .addTag('Ops - Roles', '运营:RBAC role 配置')
    .addTag('Ops - Role Permissions', '运营:role-permission 绑定')
    .addTag('Ops - User Roles', '运营:user-role 绑定')
    .addTag('Ops - RBAC', '运营:RBAC 运行时(reload 缓存)')
    .addTag('Ops - Audit Logs', '运营:审计日志查询(只读)')
    .addTag('Ops - Storage Settings', '运营:对象存储配置(AES-256-GCM 加密;不返明文凭据)')
    .addTag('Ops - Attachment Configs', '运营:附件 mime / size / type 配置')
    .addTag('Ops - Contribution Rules', '运营:贡献值规则')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: true,
  });
}
