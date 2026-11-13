import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { memoryAdapter, type MemoryDB } from '@better-auth/memory-adapter';
import {
  membershipSchema,
  workspaceId,
  hasPermission,
  type Membership,
  type Role,
} from '@unkillable/shared';
import { createAuth } from './auth';
import { createApp } from './app';
import { AuthService } from './services/auth';
import type { MembershipRepository } from './repositories/documents';
const origin = 'http://localhost:3000';
const secret = 'test-only-secret-that-is-long-enough-123456789';
class MemoryMemberships implements MembershipRepository {
  readonly documents = new Map<string, Membership>();
  async get(id: string) {
    return this.documents.get(id) ?? null;
  }
  async ensureViewer(userId: string) {
    if (!this.documents.has(userId))
      this.documents.set(
        userId,
        membershipSchema.parse({
          id: randomUUID(),
          userId,
          workspaceId,
          role: 'viewer',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
  }
  async setRole(userId: string, role: Role) {
    const doc = this.documents.get(userId);
    if (!doc) throw new Error('No membership');
    this.documents.set(userId, membershipSchema.parse({ ...doc, role }));
  }
}
function setup() {
  const store: MemoryDB = {
    users: [],
    sessions: [],
    accounts: [],
    verifications: [],
  };
  const memberships = new MemoryMemberships();
  const auth = createAuth(memoryAdapter(store), memberships, {
    secret,
    baseURL: 'http://localhost:4000',
    trustedOrigins: [origin],
    test: true,
  });
  const app = createApp(
    { mongo: async () => true, redis: async () => true },
    [origin],
    'silent',
    new AuthService(auth, memberships, 'http://localhost:4000'),
  );
  return { app, memberships, store };
}
const credentials = {
  name: 'Test User',
  email: 'viewer@example.test',
  password: 'a-strong-local-password',
};
function cookieFrom(response: { headers: Record<string, unknown> }) {
  return (response.headers['set-cookie'] as string[])
    .map((value) => value.split(';')[0])
    .join('; ');
}
describe('authentication HTTP flow', () => {
  it('registers a viewer, stores a hash, reads the session, logs out, and rejects replay', async () => {
    const { app, store } = setup();
    const anonymous = await request(app).get('/auth/me');
    expect(anonymous.status).toBe(401);
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send(credentials);
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    expect(signed.body.role).toBe('viewer');
    expect(signed.body.token).toBeUndefined();
    expect(String(signed.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(signed.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    expect(store.accounts[0].password).not.toBe(credentials.password);
    let cookie = cookieFrom(signed);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookie)).body.user
        .email,
    ).toBe(credentials.email);
    expect(
      (
        await request(app)
          .post('/auth/logout')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookie)).status,
    ).toBe(401);
    const login = await request(app)
      .post('/auth/login')
      .set('Origin', origin)
      .send({
        email: credentials.email.toUpperCase(),
        password: credentials.password,
      });
    expect(login.status).toBe(200);
    cookie = cookieFrom(login);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookie)).status,
    ).toBe(200);
  });
  it('rejects weak passwords, role injection, duplicate signup, and incorrect credentials', async () => {
    const { app } = setup();
    expect(
      (
        await request(app)
          .post('/auth/register')
          .set('Origin', origin)
          .send({ ...credentials, password: 'weak' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/auth/register')
          .set('Origin', origin)
          .send({ ...credentials, role: 'admin' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/auth/register')
          .set('Origin', origin)
          .send(credentials)
      ).status,
    ).toBe(201);
    const duplicate = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send(credentials);
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await request(app)
          .post('/auth/login')
          .set('Origin', origin)
          .send({ email: credentials.email, password: 'wrong-password' })
      ).status,
    ).toBe(401);
  });
  it('rejects missing or untrusted origins without creating users', async () => {
    const { app, store } = setup();
    expect(
      (await request(app).post('/auth/register').send(credentials)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/auth/register')
          .set('Origin', 'https://untrusted.example')
          .send(credentials)
      ).status,
    ).toBe(403);
    expect(store.users).toHaveLength(0);
  });
  it('enforces live role changes and fails closed without a membership', async () => {
    const { app, memberships } = setup();
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send(credentials);
    expect(signed.status).toBe(201);
    const cookie = cookieFrom(signed);
    const userId = signed.body.user.id as string;
    expect(
      (await request(app).get('/auth/access/runs').set('Cookie', cookie))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get('/auth/access/approvals').set('Cookie', cookie))
        .status,
    ).toBe(403);
    await memberships.setRole(userId, 'approver');
    expect(
      (await request(app).get('/auth/access/approvals').set('Cookie', cookie))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get('/auth/access/chaos').set('Cookie', cookie))
        .status,
    ).toBe(403);
    await memberships.setRole(userId, 'admin');
    expect(
      (await request(app).get('/auth/access/chaos').set('Cookie', cookie))
        .status,
    ).toBe(200);
    await memberships.setRole(userId, 'viewer');
    expect(
      (await request(app).get('/auth/access/chaos').set('Cookie', cookie))
        .status,
    ).toBe(403);
    memberships.documents.delete(userId);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookie)).status,
    ).toBe(403);
  });
  it('rejects expired sessions even before database TTL cleanup', async () => {
    const { app, store } = setup();
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send(credentials);
    expect(signed.status).toBe(201);
    store.sessions[0].expiresAt = new Date(Date.now() - 1000);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookieFrom(signed)))
        .status,
    ).toBe(401);
  });
});
describe('RBAC permission matrix', () => {
  it.each([
    ['viewer', 'runs:read', true],
    ['viewer', 'approvals:resolve', false],
    ['viewer', 'chaos:manage', false],
    ['approver', 'approvals:resolve', true],
    ['approver', 'chaos:manage', false],
    ['approver', 'analytics:read', false],
    ['admin', 'approvals:resolve', true],
    ['admin', 'chaos:manage', true],
    ['admin', 'analytics:read', true],
  ] as const)('%s / %s = %s', (role, permission, allowed) => {
    expect(hasPermission(role, permission)).toBe(allowed);
  });
});
