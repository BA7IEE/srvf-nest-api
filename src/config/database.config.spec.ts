import databaseConfig from './database.config';

describe('independent contribution shadow database configuration', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    // Synthetic inputs only: no credentials, clients, service startup or connections.
    process.env = { DATABASE_URL: 'postgresql://primary.invalid/primary' };
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it.each([undefined, ''])('leaves absent or empty input %j unconfigured', (raw) => {
    if (raw !== undefined) process.env.CONTRIBUTION_SHADOW_DATABASE_URL = raw;
    expect(databaseConfig()).toEqual({
      url: 'postgresql://primary.invalid/primary',
      contributionShadowUrl: undefined,
    });
  });

  it('preserves the explicitly supplied independent input without changing the primary URL', () => {
    process.env.CONTRIBUTION_SHADOW_DATABASE_URL = 'postgresql://runtime.invalid/shadow';
    expect(databaseConfig()).toEqual({
      url: 'postgresql://primary.invalid/primary',
      contributionShadowUrl: 'postgresql://runtime.invalid/shadow',
    });
  });

  it.each(['off', 'shadow'])('does not infer a connection from mode %s', (mode) => {
    process.env.ACTIVITY_E3_CONTRIBUTION_SHADOW_MODE = mode;
    expect(databaseConfig().contributionShadowUrl).toBeUndefined();
  });

  it('does not fill a missing primary URL from the independent input', () => {
    delete process.env.DATABASE_URL;
    process.env.CONTRIBUTION_SHADOW_DATABASE_URL = 'postgresql://runtime.invalid/shadow';
    expect(databaseConfig().url).toBeUndefined();
    expect(databaseConfig().contributionShadowUrl).toBe('postgresql://runtime.invalid/shadow');
  });
});
