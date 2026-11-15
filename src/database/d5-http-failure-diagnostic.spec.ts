import { Logger, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import {
  createD5HttpFailureDiagnostic,
  type D5HttpFailureRecord,
} from '../../test/helpers/d5-http-failure-diagnostic';

describe('D5 test-only HTTP failure diagnostics', () => {
  const context = { phase: 'prepare', population: 2000 } as const;

  it('preserves a successful response without emitting captured server errors', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    const response = { status: 200, body: { code: 0, data: { unchanged: true } } };
    const result = await diagnostic.capture(context, () => {
      diagnostic.logger.error('Unhandled exception', 'Error: hidden\n');
      return Promise.resolve(response);
    });
    expect(result).toBe(response);
    expect(emit).not.toHaveBeenCalled();
  });

  it('captures the real filter error path without printing raw errors', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    const filter = new AllExceptionsFilter(false);
    const privateError = new Error('Transaction already closed; PRIVATE_REQUEST_CANARY');
    privateError.stack = [
      'PrismaClientKnownRequestError: PRIVATE_SQL_CANARY P2028',
      '  at prepare (/runner/src/modules/activities/activity-time-settlement.service.ts:401:9)',
      '  at secret (/private/PRIVATE_PATH_CANARY.ts:1:1)',
    ].join('\n');
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(diagnostic.logger.error.bind(diagnostic.logger));
    const response = {
      status: 0,
      body: {} as unknown,
      json: (body: unknown) => {
        response.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (status: number) => {
            response.status = status;
            return response;
          },
        }),
      }),
    } as unknown as ArgumentsHost;
    try {
      const result = await diagnostic.capture(context, () => {
        filter.catch(privateError, host);
        return Promise.resolve(response);
      });
      expect(result).toBe(response);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({
        ...context,
        status: 500,
        code: 50000,
        elapsedMs: expect.any(Number) as unknown,
        errorType: 'PrismaClientKnownRequestError',
        databaseCodes: ['P2028'],
        hints: ['transaction_closed'],
        repositoryLocations: ['src/modules/activities/activity-time-settlement.service.ts:401:9'],
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_');
    } finally {
      logger.mockRestore();
    }
  });

  it('omits payload, credentials, arbitrary codes and unknown error names', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    const canary = 'PRIVATE_PAYLOAD_CANARY';
    const response = {
      status: 500,
      body: { code: 50000, message: canary, data: { password: canary } },
    };
    await diagnostic.capture(context, () => {
      diagnostic.logger.error('Unhandled exception', `${canary}: CUSTOM_CODE\n${canary}`);
      return Promise.resolve(response);
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(canary);
    expect(emit.mock.calls[0][0]).toMatchObject({
      errorType: 'UnknownError',
      databaseCodes: [],
      hints: [],
      repositoryLocations: [],
    });
  });

  it('ignores server errors outside the active request and does not reuse old signals', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    diagnostic.logger.error('Unhandled exception', 'Error: P2028\n');
    await diagnostic.capture(context, () =>
      Promise.resolve({
        status: 500,
        body: { code: 50000, message: 'opaque' },
      }),
    );
    expect(emit.mock.calls[0][0].databaseCodes).toEqual([]);
  });

  it('does not invoke response getters or proxy traps', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    const getter = jest.fn(() => {
      throw new Error('must not read');
    });
    const body = Object.defineProperty({}, 'message', { get: getter });
    await diagnostic.capture(context, () => Promise.resolve({ status: 500, body }));
    const trap = jest.fn(() => {
      throw new Error('must not inspect');
    });
    await diagnostic.capture(context, () =>
      Promise.resolve({
        status: 500,
        body: new Proxy({}, { getOwnPropertyDescriptor: trap }),
      }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('propagates transport rejection by identity and resets capture state', async () => {
    const emit = jest.fn<void, [D5HttpFailureRecord]>();
    const diagnostic = createD5HttpFailureDiagnostic(emit);
    const failure = new Error('PRIVATE_TRANSPORT_CANARY');
    await expect(
      diagnostic.capture(context, () => {
        diagnostic.logger.error('Unhandled exception', 'Error: P2028\n');
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    await diagnostic.capture(context, () =>
      Promise.resolve({
        status: 500,
        body: { code: 50000 },
      }),
    );
    expect(emit.mock.calls[0][0].databaseCodes).toEqual([]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_');
  });

  it('does not replace an HTTP failure when the diagnostic sink throws', async () => {
    const diagnostic = createD5HttpFailureDiagnostic(() => {
      throw new Error('sink');
    });
    const response = { status: 500, body: { code: 50000 } };
    await expect(diagnostic.capture(context, () => Promise.resolve(response))).resolves.toBe(
      response,
    );
  });
});
