import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AppActivityRegistrationCommandParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

/** Deliberately immutable and minimal: no answers, upload/session data or internal locator leaks. */
export class AppActivityRegistrationCommandReceiptDto {
  @ApiProperty()
  registrationId!: string;

  @ApiProperty()
  registrationRevisionId!: string;

  @ApiProperty({ minimum: 1 })
  revision!: number;

  @ApiProperty()
  submittedAt!: Date;
}
