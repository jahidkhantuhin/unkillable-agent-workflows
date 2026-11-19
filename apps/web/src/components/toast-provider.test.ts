import { describe, it, expect } from 'vitest';
import { errorMessage } from './toast-provider';
import { demoForkEditsSchema } from '@unkillable/shared';
describe('action error messages', () => {
  it('keeps useful API messages and uses a fallback for unknown errors', () => {
    expect(errorMessage(new Error('Session expired'))).toBe('Session expired');
    expect(errorMessage('Action refused')).toBe('Action refused');
    expect(errorMessage(null, 'Unable to upload')).toBe('Unable to upload');
  });
  it('explains invalid JSON and protected state edits in readable text', () => {
    expect(errorMessage(new SyntaxError('Unexpected token'))).toBe(
      'Invalid JSON. Check the syntax and try again.',
    );
    const parsed = demoForkEditsSchema.safeParse({ approvalAction: 'approve' });
    if (parsed.success) throw new Error('Protected edit was accepted');
    expect(errorMessage(parsed.error)).toContain('approvalAction');
    expect(errorMessage(parsed.error)).not.toContain('"code"');
  });
});
