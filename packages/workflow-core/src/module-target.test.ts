import { describe, expect, it } from 'vitest';
import type { ModuleNode } from '@forexplore/contracts';
import { toModuleTarget } from './module-target';

const method: ModuleNode = {
  id: 'quote', name: 'quote', kind: 'function', path: 'src/price.ts',
  language: 'TypeScript', signature: 'quote(): number', line: 12,
  documentation: 'Quoted unit price', implementationStatus: 'unimplemented',
};

describe('target selection from an indexed node', () => {
  it('preserves source location and implementation status for a selectable symbol', () => {
    expect(toModuleTarget(method)).toEqual(method);
  });

  it.each<Partial<ModuleNode>>([
    { kind: 'folder' }, { language: undefined }, { signature: '' },
  ])('rejects a nonselectable or incomplete symbol (%j)', (missing) => {
    expect(toModuleTarget({ ...method, ...missing })).toBeNull();
  });
});
