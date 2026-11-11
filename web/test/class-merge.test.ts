import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/utils.js';

describe('cn', () => {
  it('knows the panel text sizes: a size and a colour both stay', () => {
    expect(cn('text-dense', 'text-muted-foreground')).toBe('text-dense text-muted-foreground');
    expect(cn('text-2xs font-medium', 'text-danger')).toBe('text-2xs font-medium text-danger');
  });
  it('lets a later size win over an earlier one', () => {
    expect(cn('text-xs', 'text-dense')).toBe('text-dense');
    expect(cn('text-dense', 'text-sm')).toBe('text-sm');
  });
});
