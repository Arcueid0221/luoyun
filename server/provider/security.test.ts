import assert from 'node:assert/strict';
import test from 'node:test';
import { isBearerTokenValid } from './security.ts';

test('accepts the exact bearer token', () => {
  assert.equal(isBearerTokenValid('Bearer provider-secret', 'provider-secret'), true);
});

test('rejects missing, malformed, or different bearer tokens', () => {
  assert.equal(isBearerTokenValid(undefined, 'provider-secret'), false);
  assert.equal(isBearerTokenValid('provider-secret', 'provider-secret'), false);
  assert.equal(isBearerTokenValid('Bearer other-secret', 'provider-secret'), false);
  assert.equal(isBearerTokenValid(['Bearer provider-secret'], 'provider-secret'), false);
});
