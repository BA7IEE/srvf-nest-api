import { type ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter(true);
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['oversized body', { type: 'entity.too.large', status: 413 }, 413],
    ['malformed JSON', { type: 'entity.parse.failed', status: 400 }, 400],
    ['unsupported encoding', { type: 'encoding.unsupported', status: 415 }, 415],
    ['statusCode', { type: 'entity.too.large', statusCode: 413 }, 413],
  ])('normalizes %s parser failures', (_description, error, status) => {
    const errorLog = jest.spyOn(Logger.prototype, 'error');
    filter.catch(error, host);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({
      code: BizCode.BAD_REQUEST.code,
      message: BizCode.BAD_REQUEST.message,
      data: null,
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([
    ['error with status but no type', Object.assign(new Error('failure'), { status: 413 })],
    ['object with unsupported status', { type: 'other', status: 500 }],
  ])('keeps %s as an internal error', (_description, error) => {
    filter.catch(error, host);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      code: BizCode.INTERNAL_ERROR.code,
      message: BizCode.INTERNAL_ERROR.message,
      data: null,
    });
  });

  it('preserves the business exception path', () => {
    filter.catch(new BizException(BizCode.NOT_FOUND), host);
    expect(response.status).toHaveBeenCalledWith(BizCode.NOT_FOUND.httpStatus);
    expect(response.json).toHaveBeenCalledWith({
      code: BizCode.NOT_FOUND.code,
      message: BizCode.NOT_FOUND.message,
      data: null,
    });
  });

  it('preserves the HTTP exception path', () => {
    filter.catch(new HttpException('private details', HttpStatus.NOT_FOUND), host);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(response.json).toHaveBeenCalledWith({
      code: BizCode.NOT_FOUND.code,
      message: BizCode.NOT_FOUND.message,
      data: null,
    });
  });
});
