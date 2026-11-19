import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { signedDecisionSchema, type SignedDecision } from '@unkillable/shared';
export class InvalidApprovalLink extends Error {
  constructor() {
    super(
      'This approval link is invalid or expired. Open the Approval Inbox for current decisions.',
    );
  }
}
export function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export class ApprovalSigner {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32)
      throw new Error('Approval signing requires a private secret');
  }
  sign(payload: SignedDecision) {
    const encoded = Buffer.from(
      JSON.stringify(signedDecisionSchema.parse(payload)),
    ).toString('base64url');
    return `${encoded}.${this.mac(encoded)}`;
  }
  private mac(encoded: string) {
    return createHmac('sha256', this.secret)
      .update(`unkillable:approval:v1:${encoded}`)
      .digest('base64url');
  }
  verify(token: string) {
    if (token.length > 2000) throw new InvalidApprovalLink();
    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    )
      throw new InvalidApprovalLink();
    if (
      !timingSafeEqual(Buffer.from(this.mac(parts[0])), Buffer.from(parts[1]))
    )
      throw new InvalidApprovalLink();
    try {
      const value = signedDecisionSchema.parse(
        JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      );
      if (value.exp <= Math.floor(this.now() / 1000))
        throw new InvalidApprovalLink();
      return value;
    } catch {
      throw new InvalidApprovalLink();
    }
  }
}
