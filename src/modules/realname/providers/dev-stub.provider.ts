import { Injectable, Logger } from '@nestjs/common';

import { realnameDevStubMatched } from '../realname.constants';
import type {
  RealnameProvider,
  RealnameVerifyInput,
  RealnameVerifyResult,
} from '../realname.types';

// 招新一期 · 实名核验通道 T2(2026-06-18):DevStub Provider(评审稿 E-R-6)
//
// 非生产联调通道:不调任何外部服务,按身份证号**校验位奇偶**返**确定性**结果——
// 校验位(第 18 位)偶(含 'X'=10)→ matched;奇 → mismatch。e2e / 本地联调可用不同尾号
// 造「核验通过 / 未通过」两条链(报名全链 → verified / rejected 均可测)。
//
// 与 wechat/sms DevStub 一致:debug 日志**不输出姓名 / 身份证号**(高敏感 PII,不入日志);
// 不做:不模拟通道错误 / 超时(真实通道错误映射由 tencent-realname.provider.spec mock 覆盖);
// production-like 下 DEV_STUB 写入与运行时双重被禁(镜像 wechat E-10),本 Provider 生产物理不可达。

@Injectable()
export class DevStubRealnameProvider implements RealnameProvider {
  private readonly logger = new Logger(DevStubRealnameProvider.name);

  verify(input: RealnameVerifyInput): Promise<RealnameVerifyResult> {
    this.logger.debug('[DEV_STUB] realname verify called');
    const matched = realnameDevStubMatched(input.idCardNumber);
    return Promise.resolve(
      matched
        ? { matched: true }
        : { matched: false, reason: 'dev-stub: id-card check digit is odd' },
    );
  }
}
