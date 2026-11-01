import appConfig from './app.config';
import { R5_CI_NONSECRET_APP_ENV } from '../../test/setup/r5-ci-instance-scope';

describe('isolated Human CI supplies a complete legal nonsecret app configuration', () => {
  const original = process.env;
  beforeEach(() => {
    // Pure configuration test only; no process or database is started.
    process.env = { ...R5_CI_NONSECRET_APP_ENV };
  });
  afterEach(() => {
    process.env = original;
  });
  it('runs the real complete app parser without a database URL or secret environment value', () => {
    const config = appConfig();
    expect(config.env).toBe('test');
    expect(config.port).toBe(3001);
    expect(config.corsOrigin).toEqual(['http://localhost:5173']);
    expect(config.swaggerEnabled).toBe(true);
    expect(config.loginThrottle.limit).toBe(50);
    expect(config.humanCorrectionBackground.mode).toBe('off');
    expect(Object.keys(R5_CI_NONSECRET_APP_ENV).sort()).toEqual([
      'APP_CORS_ORIGIN',
      'APP_ENV',
      'APP_PORT',
      'ENABLE_SWAGGER',
      'LOGIN_THROTTLE_LIMIT',
    ]);
  });
  it('retains production rejection for a missing port and out-of-contract throttle', () => {
    delete process.env.APP_PORT;
    expect(() => appConfig()).toThrow('APP_PORT');
    process.env.APP_PORT = '3001';
    process.env.LOGIN_THROTTLE_LIMIT = '1000';
    expect(() => appConfig()).toThrow('LOGIN_THROTTLE_LIMIT');
  });
});
