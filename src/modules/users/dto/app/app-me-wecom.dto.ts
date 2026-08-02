import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

// 企业微信接入 T3(2026-08-02):App 企业微信绑定 DTO 集合
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §6.3;
// 镜像 app-me-wechat.dto 范式)。
//
// App DTO 隔离铁律(AGENTS §2 D-6):独立定义,**禁止**从 Admin DTO
// extends / Pick / Omit / IntersectionType 派生;严格字段白名单(forbidNonWhitelisted 兜底)。
//
// ⚠️ 命名铁律(冻结稿开头):本文件是**企业微信**(WeCom),与 app-me-wechat.dto.ts
// (微信**小程序**)是两个外部主体、两套身份键、两组错误码 —— 不合并、不互相 import。
//
// 出参纪律(§5.5 数据分级):wecomUserId 是 L2 稳定身份标识,
// 落库明文(发消息要用)但**响应一律掩码**;本人视角也不例外
// (对用户没有输入 / 校对价值,掩码足以识别"绑的是哪个企业微信号")。
// 响应永不含 OAuth code / state / binding ticket / corpId。

export class BindMyWecomDto {
  @ApiProperty({
    description:
      '企业微信回跳带回的一次性 code(前端须随即 history.replaceState 清理地址栏;' +
      '禁止进入埋点 / 错误上报 / 浏览器持久存储)',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({
    description:
      'POST auth/v1/wecom-bind/authorize 签发的 purpose=bind_self state(一次性;' +
      'subjectUserId 必须等于当前登录用户)',
  })
  @IsString()
  @IsNotEmpty()
  state!: string;

  @ApiProperty({
    description: 'Auth surface 签发、action=WECOM_BIND 的 5 分钟 step-up proof',
  })
  @IsString()
  @IsNotEmpty()
  stepUpToken!: string;
}

export class AppMeWecomDto {
  @ApiProperty({ description: '当前账号是否已绑定企业微信身份' })
  bound!: boolean;

  @ApiPropertyOptional({
    description: '已绑定的企业微信 UserId(**一律掩码** 前 4 后 4;未绑定为 null)',
    nullable: true,
    example: 'zhan****0001',
  })
  wecomUserIdMasked!: string | null;

  @ApiPropertyOptional({
    description: '当前绑定生效时刻(未绑定为 null)',
    nullable: true,
    format: 'date-time',
  })
  boundAt!: Date | null;
}
