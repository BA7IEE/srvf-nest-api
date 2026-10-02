import type { Prisma } from '@prisma/client';
import { ContributionShadowDispositionRegistrationService } from './contribution-shadow-disposition-registration.service';
import type { ContributionShadowWindowRegistrationService } from './contribution-shadow-window-registration.service';

describe('D3 disposition registration', () => {
  it('uses the dedicated sign operation on the same caller transaction', async () => {
    const execution = { executeInTx: jest.fn().mockResolvedValue({ receiptId: 'fixture' }) };
    const service = new ContributionShadowDispositionRegistrationService(
      execution as unknown as ContributionShadowWindowRegistrationService,
    );
    const tx = {} as Prisma.TransactionClient;
    const manifest = { operation: 'sign_disposition' };
    await expect(
      service.registerInTx(tx, 'fixture-token', manifest, 'fixture-hash'),
    ).resolves.toEqual({ receiptId: 'fixture' });
    expect(execution.executeInTx).toHaveBeenCalledWith(
      tx,
      'fixture-token',
      manifest,
      'fixture-hash',
      'sign_disposition',
    );
  });
});
