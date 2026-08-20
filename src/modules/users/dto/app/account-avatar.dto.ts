import { ApiProperty } from '@nestjs/swagger';

/**
 * issue #1055 T3 §7.2 —— App 账号头像的受控摘要。
 *
 * ⚠️ **不返回 raw storage key**。这是本 DTO 存在的全部理由:
 * 旧契约直接把 `User.avatarKey`(一个裸 storage key)吐给客户端,于是任何拿到它的人
 * 都掌握了一个**永不过期、与鉴权无关**的对象引用。现在给的是短 TTL 签名 URL,
 * 到期即失效;客户端要长期引用就存 `attachmentId`,每次显示时重新取。
 *
 * `accessUrl` / `expiresAt` **可空**:附件已被 durable delete、或 Provider 暂时签不出 URL 时
 * 都会是 `null`。客户端一视同仁按「暂时没有可用头像」处理即可,不必区分 ——
 * 区分了也做不了别的事。
 */
export class AccountAvatarDto {
  @ApiProperty({ description: '头像附件 ID(长期引用用它,不要存 accessUrl)' })
  attachmentId!: string;

  @ApiProperty({
    description: '短 TTL 签名下载 URL;签不出来时为 null',
    nullable: true,
    type: String,
  })
  accessUrl!: string | null;

  @ApiProperty({
    description: 'accessUrl 的失效时刻;accessUrl 为 null 时同为 null',
    nullable: true,
    type: Date,
  })
  expiresAt!: Date | null;
}
