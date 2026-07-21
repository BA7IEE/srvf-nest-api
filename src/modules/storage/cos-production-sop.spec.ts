import { ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { UpdateStorageSettingsDto } from './storage-settings.dto';
import { CredentialStatus } from './storage-settings.types';

describe('COS production SOP executable contract', () => {
  const fixturePath = join(process.cwd(), 'docs/ops/fixtures/cos-production-storage-settings.json');
  const sopPath = join(process.cwd(), 'docs/ops/cos-production-rollout-checklist.md');

  it('settings fixture passes the real global ValidationPipe contract', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    const dto: unknown = await pipe.transform(fixture, {
      type: 'body',
      metatype: UpdateStorageSettingsDto,
    });

    expect(dto).toMatchObject({
      providerType: 'COS',
      enabled: true,
      envPrefix: 'prod',
      allowedMimePolicyMode: 'INHERIT',
    });
    expect(Object.keys(dto as object)).toEqual(Object.keys(fixture));
  });

  it('SOP status and authorization anchors match current runtime constants', () => {
    const sop = readFileSync(sopPath, 'utf8');

    expect(Object.values(CredentialStatus)).toEqual(['configured', 'missing', 'invalid']);
    expect(BizCode.RBAC_FORBIDDEN.code).toBe(30100);
    expect(sop).toContain('"credentialStatus": "configured"');
    expect(sop).toContain('`30100`');
    expect(sop).toContain('SUPER_ADMIN-only');

    for (const staleAnchor of [
      '"keyPrefix"',
      '"mimePolicyMode"',
      '"credentialStatus": "MISSING"',
      '"credentialStatus": "CONFIGURED"',
      '`40300`',
      'StorageCryptoService initialized (algorithm=aes-256-gcm)',
    ]) {
      expect(sop).not.toContain(staleAnchor);
    }
  });
});
