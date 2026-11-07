import { indexModuleHierarchy, type ProjectModule } from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';

function moduleNode(id: string, parentId?: string, sourceFiles: string[] = []): ProjectModule {
  return { id, parentId, name: id, kind: 'feature', description: id, sourceFiles,
    symbolKeys: [], dependsOn: [], evidenceIds: [] };
}

describe('module file scope', () => {
  it('keeps flat legacy proposals selectable and excludes sibling files', () => {
    const tree = indexModuleHierarchy([
      moduleNode('orders', undefined, ['orders.ts']),
      moduleNode('quotes', undefined, ['quotes.ts']),
    ]);
    expect(tree.roots.map(node => node.id)).toEqual(['orders', 'quotes']);
    expect(tree.sourceFiles('quotes')).toEqual({ files: ['quotes.ts'], truncated: false });
  });

  it('counts distinct files toward the limit and reports truncation only for omitted files', () => {
    const tree = indexModuleHierarchy([
      moduleNode('orders'),
      moduleNode('model', 'orders', ['shared.ts', 'order.ts']),
      moduleNode('api', 'orders', ['shared.ts', 'route.ts']),
    ]);
    expect(tree.sourceFiles('orders', 2)).toEqual({ files: ['shared.ts', 'order.ts'], truncated: true });
    expect(tree.sourceFiles('orders', 3)).toEqual({ files: ['shared.ts', 'order.ts', 'route.ts'], truncated: false });
    expect(() => tree.sourceFiles('missing')).toThrow(/does not exist/);
    expect(() => tree.sourceFiles('orders', 0)).toThrow(/limit/);
  });

  it.each([
    { nodes: [moduleNode('a'), moduleNode('a')], error: /duplicate/ },
    { nodes: [moduleNode('a', 'missing')], error: /invalid parent/ },
    { nodes: [moduleNode('root'), moduleNode('a', 'b'), moduleNode('b', 'a')], error: /cycle/ },
    { nodes: [moduleNode('root', undefined, ['owned.ts']), moduleNode('child', 'root')], error: /directly own/ },
  ])('rejects a malformed ownership tree ($error)', ({ nodes, error }) => {
    expect(() => indexModuleHierarchy(nodes)).toThrow(error);
  });
});
