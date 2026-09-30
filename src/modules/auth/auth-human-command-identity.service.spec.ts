import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthHumanCommandIdentityService } from './auth-human-command-identity.service';
import { JwtStrategy } from './strategies/jwt.strategy';

describe('AuthHumanCommandIdentityService', () => {
  const fixtureKey = 'isolated-command-identity-unit-fixture';
  const user = {
    id: 'fixture-user',
    username: 'fixture-user',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  let jwt: JwtService;
  let validate: jest.Mock;
  let service: AuthHumanCommandIdentityService;
  beforeEach(() => {
    jwt = new JwtService({ secret: fixtureKey });
    validate = jest.fn().mockResolvedValue(user);
    service = new AuthHumanCommandIdentityService(jwt, { validate } as unknown as JwtStrategy);
  });
  const payload = { sub: 'fixture-user', username: 'fixture-user' };

  it('verifies a real signature then reuses current user validation on every call', async () => {
    const token = jwt.sign(payload, { expiresIn: 60 });
    await expect(service.authenticate(token)).resolves.toEqual(user);
    await expect(service.authenticate(token)).resolves.toEqual(user);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith(payload);
  });

  it.each([
    'malformed',
    'wrong-signature',
    'expired',
    'missing-expiry',
    'wrong-algorithm',
    'missing-sub',
  ])('%s never reaches user lookup', async (kind) => {
    let token: string;
    switch (kind) {
      case 'wrong-signature':
        token = new JwtService({ secret: 'other-unit-fixture' }).sign(payload, { expiresIn: 60 });
        break;
      case 'expired':
        token = jwt.sign(payload, { expiresIn: -1 });
        break;
      case 'missing-expiry':
        token = jwt.sign(payload);
        break;
      case 'wrong-algorithm':
        token = jwt.sign(payload, { expiresIn: 60, algorithm: 'HS384' });
        break;
      case 'missing-sub':
        token = jwt.sign({ username: 'fixture-user' }, { expiresIn: 60 });
        break;
      default:
        token = 'not.a.valid-credential';
    }
    await expect(service.authenticate(token)).rejects.toEqual(
      new BizException(BizCode.UNAUTHORIZED),
    );
    expect(validate).not.toHaveBeenCalled();
  });

  it('a newly inactive user is rejected with the same sanitized error', async () => {
    const token = jwt.sign(payload, { expiresIn: 60 });
    await expect(service.authenticate(token)).resolves.toEqual(user);
    validate.mockRejectedValueOnce(new Error('private underlying detail'));
    await expect(service.authenticate(token)).rejects.toEqual(
      new BizException(BizCode.UNAUTHORIZED),
    );
    expect(validate).toHaveBeenCalledTimes(2);
  });
});
