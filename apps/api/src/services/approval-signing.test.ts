import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApprovalSigner, InvalidApprovalLink } from './approval-signing';
const secret = 'local-signing-test-secret-at-least-32-chars';
const payload = {
  v: 1 as const,
  jti: randomUUID(),
  actorId: 'reviewer',
  approvalId: randomUUID(),
  version: 0,
  action: 'approve' as const,
  exp: 2000,
};
it('signs and verifies every bound decision field', () => {
  const signer = new ApprovalSigner(secret, () => 1000000);
  expect(signer.verify(signer.sign(payload))).toEqual(payload);
});
it('rejects changed payloads, signatures, wrong keys and malformed links', () => {
  const signer = new ApprovalSigner(secret, () => 1000000),
    token = signer.sign(payload);
  const [body, signature] = token.split('.');
  for (const field of [
    { action: 'reject' },
    { actorId: 'someone-else' },
    { approvalId: randomUUID() },
    { version: 1 },
    { exp: 999999 },
  ]) {
    const changed = Buffer.from(
      JSON.stringify({ ...payload, ...field }),
    ).toString('base64url');
    expect(() => signer.verify(`${changed}.${signature}`)).toThrow(
      InvalidApprovalLink,
    );
  }
  for (const value of [
    '',
    `${body}.`,
    `${token}.extra`,
    `${body}.${signature.slice(0, -1)}!`,
    'x'.repeat(2001),
  ])
    expect(() => signer.verify(value)).toThrow(InvalidApprovalLink);
  expect(() =>
    new ApprovalSigner(
      'another-private-signing-secret-at-least-32',
      () => 1000000,
    ).verify(token),
  ).toThrow(InvalidApprovalLink);
});
it('rejects expiration at the exact expiry boundary', () => {
  const signer = new ApprovalSigner(secret, () => 2000000);
  expect(() => signer.verify(signer.sign(payload))).toThrow(
    InvalidApprovalLink,
  );
});
