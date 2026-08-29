import { timingSafeEqual } from 'node:crypto';

/**
 * Provider 只接受 Spring Boot 持有的 Bearer token。
 * 长度不同直接拒绝；长度相同时用 timingSafeEqual 避免普通字符串比较泄漏时序信息。
 */
export function isBearerTokenValid(
  authorization: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;

  const actual = Buffer.from(authorization.slice('Bearer '.length), 'utf-8');
  const expected = Buffer.from(expectedToken, 'utf-8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
