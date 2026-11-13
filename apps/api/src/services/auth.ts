import {
  identitySchema,
  publicUserSchema,
  workspaceId,
  type Identity,
} from '@unkillable/shared';
import type { Auth } from '../auth';
import type { MembershipRepository } from '../repositories/documents';
import { HttpError } from '../errors';

export class AuthService {
  constructor(
    private readonly auth: Auth,
    private readonly memberships: MembershipRepository,
    private readonly baseURL: string,
  ) {}
  private async identity(user: unknown): Promise<Identity> {
    const parsed = publicUserSchema.parse(user);
    const membership = await this.memberships.get(parsed.id);
    if (!membership)
      throw new HttpError(
        403,
        'MEMBERSHIP_REQUIRED',
        'Workspace membership is required',
      );
    return identitySchema.parse({
      user: parsed,
      role: membership.role,
      workspaceId,
    });
  }
  async me(headers: Headers): Promise<Identity> {
    const session = await this.auth.api.getSession({ headers });
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
    return this.identity(session.user);
  }
  async authenticate(
    action: 'register' | 'login' | 'logout',
    headers: Headers,
    body: unknown,
  ) {
    const paths = {
      register: 'sign-up/email',
      login: 'sign-in/email',
      logout: 'sign-out',
    };
    const forwarded = new Headers(headers);
    forwarded.set('content-type', 'application/json');
    const response = await this.auth.handler(
      new Request(`${this.baseURL}/auth/${paths[action]}`, {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify(body),
      }),
    );
    const data = (await response.json()) as {
      user?: unknown;
      code?: string;
      message?: string;
    };
    if (!response.ok)
      throw new HttpError(
        response.status,
        response.status >= 500
          ? 'AUTH_UNAVAILABLE'
          : (data.code ?? 'AUTH_FAILED'),
        response.status >= 500
          ? 'Authentication is temporarily unavailable'
          : (data.message ?? 'Authentication failed'),
      );
    const identity =
      action === 'logout' ? undefined : await this.identity(data.user);
    return { identity, cookies: response.headers.getSetCookie() };
  }
}
