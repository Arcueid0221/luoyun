import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthExpiredError, isLoginRequiredCode } from './errors.ts';

describe('AuthExpiredError', () => {
  it('是 Error 的子类，能被 instanceof 分出来', () => {
    const error = new AuthExpiredError();
    assert.ok(error instanceof Error);
    assert.ok(error instanceof AuthExpiredError);
    assert.equal(error.name, 'AuthExpiredError');
    assert.match(error.message, /MUSIC_U/);
  });

  it('普通 Error 不会被误认成登录失效', () => {
    assert.equal(new Error('请求失败') instanceof AuthExpiredError, false);
  });
});

describe('isLoginRequiredCode', () => {
  it('只有 301 是"需要登录"', () => {
    assert.equal(isLoginRequiredCode(301), true);
  });

  it('别的业务码都是真的失败，不能当成登录失效', () => {
    // 误判的代价是让管理员去重新登录一个其实还活着的账号
    assert.equal(isLoginRequiredCode(200), false);
    assert.equal(isLoginRequiredCode(undefined), false);
    assert.equal(isLoginRequiredCode(-462), false);
    assert.equal(isLoginRequiredCode(400), false);
  });
});
