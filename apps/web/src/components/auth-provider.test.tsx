import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { identitySchema } from '@unkillable/shared';
import { AuthProvider, useAuth } from './auth-provider';
function Probe() {
  const { identity, loading } = useAuth();
  return (
    <span>
      {loading ? 'Checking session' : (identity?.user.name ?? 'Sign in')}
    </span>
  );
}
describe('initial session rendering', () => {
  it('renders a server-verified session without a checking placeholder', () => {
    const identity = identitySchema.parse({
      user: {
        id: 'local-user',
        name: 'Local tester',
        email: 'local@example.test',
      },
      role: 'admin',
      workspaceId: 'local',
    });
    expect(
      renderToString(
        <AuthProvider initialIdentity={identity}>
          <Probe />
        </AuthProvider>,
      ),
    ).toBe('<span>Local tester</span>');
  });
  it('renders verified anonymous access immediately', () => {
    expect(
      renderToString(
        <AuthProvider initialIdentity={null}>
          <Probe />
        </AuthProvider>,
      ),
    ).toBe('<span>Sign in</span>');
  });
  it('only checks on the client when server verification was unavailable', () => {
    expect(
      renderToString(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      ),
    ).toBe('<span>Checking session</span>');
  });
});
