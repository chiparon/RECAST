import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import { initialWorkflowState } from '@forexplore/workflow-core';
import { CandidatesStage } from './CandidatesStage';

const target: ModuleTarget = {
  id: 'function:pay',
  name: 'Pay',
  kind: 'function',
  path: 'src/Payments/PaymentService.cs',
  language: 'C#',
  signature: 'public void Pay(Payment request)',
};

function candidate(id: string, title: string, path: string): SearchCandidate {
  return {
    id,
    title,
    repository: 'fixture/payments',
    license: 'MIT',
    language: 'Java',
    kind: 'function',
    path,
    signature: `void ${title}()`,
    summary: `${title} summary`,
    score: { overall: 0.92, semantic: 0.9, symbol: 0.88, contract: 0.86 },
    preview: `void ${title}() {}`,
    dependencies: [],
    compatibility: ['接口可映射'],
    risks: [],
  };
}

function moduleCandidate(id: string, title: string, moduleId: string, moduleName: string): SearchCandidate {
  return {
    ...candidate(id, title, `src/shared/${title}.java`),
    sourceModule: {
      repositoryId: 'history-one',
      analysisRevision: 'revision-one',
      projectId: 'project-one',
      moduleId,
      name: moduleName,
      projectPath: 'services/orders',
    },
  };
}

const candidates = [
  candidate('pay', 'submitPayment', 'src/payments/PaymentService.java'),
  candidate('refund', 'refundPayment', 'src/payments/RefundService.java'),
  candidate('order', 'createOrder', 'src/orders/OrderService.java'),
];

const state = {
  ...initialWorkflowState,
  stage: 'candidates' as const,
  target,
  candidates,
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CandidatesStage', () => {
  it('groups concrete candidates by repository module path', () => {
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={state}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('02 · 检索结果');
    expect(markup).toContain('<strong>2</strong> 模块');
    expect(markup).toContain('src/payments');
    expect(markup).toContain('src/orders');
    expect(markup).toContain('2 个实现');
    expect(markup).toContain('任意候选语言 → C#');
    expect(markup).toContain('请选择一个具体实现');
  });

  it('selects a concrete implementation inside a module group', () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectCandidate = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <CandidatesStage
          state={state}
          dispatch={vi.fn()}
          adaptationProvider="DeepSeek"
          onSelectCandidate={onSelectCandidate}
          onAdapt={vi.fn()}
        />,
      );
    });

    const item = [...container.querySelectorAll<HTMLButtonElement>('.candidate-item')]
      .find((button) => button.textContent?.includes('refundPayment'));
    act(() => item?.click());
    expect(onSelectCandidate).toHaveBeenCalledWith('refund');

    act(() => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('groups candidates by the reviewed module identity instead of their directory', () => {
    const moduleCandidates = [
      moduleCandidate('create', 'createOrder', 'orders', '订单模块'),
      moduleCandidate('cancel', 'cancelOrder', 'orders', '订单模块'),
      moduleCandidate('refund', 'refundOrder', 'refunds', '退款模块'),
    ];
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={{ ...state, candidates: moduleCandidates }}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('订单模块');
    expect(markup).toContain('退款模块');
    expect(markup).toContain('<strong>2</strong> 模块');
  });

  it('shows an actionable empty state', () => {
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={{ ...state, target: { ...target, kind: 'module' }, requirement: 'implement', candidates: [] }}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('没有找到可复用实现');
    expect(markup).toContain('可以按当前需求直接生成目标模块代码');
    expect(markup).toContain('按需求直接生成模块');
  });

  it('shows complete module files and enables the module translation handoff', () => {
    const module: SearchCandidate = { ...moduleCandidate('module', 'Payments', 'payments', 'Payments'), kind: 'module',
      sourceModule: { ...moduleCandidate('module', 'Payments', 'payments', 'Payments').sourceModule!, sourceFiles: ['Payment.java', 'Receipt.java'] },
      moduleMatch: { requiredApis: ['pay', 'refund'], matchedApis: ['pay'], missingApis: ['refund'], verification: 'interface-only', previewFiles: ['Payment.java'], previewTruncated: true } };
    const markup = renderToStaticMarkup(<CandidatesStage state={{ ...state, target: { ...target, kind: 'module' },
      candidates: [module], selectedCandidateId: module.id }} dispatch={vi.fn()} adaptationProvider="DeepSeek" onSelectCandidate={vi.fn()} onAdapt={vi.fn()} />);
    expect(markup).toContain('Receipt.java');
    expect(markup).toContain('refund');
    expect(markup).toContain('行为待验证');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('准备模块翻译与回填');
  });

  it('keeps three selected modules removable and disables the remaining Top4 candidate', () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const moduleCandidates = [1, 2, 3, 4, 5].map(index => ({
      ...moduleCandidate(`candidate-${index}`, `Module${index}`, `module-${index}`, `Module ${index}`),
      kind: 'module' as const,
    }));
    const onSelectCandidate = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<CandidatesStage
        state={{ ...state, target: { ...target, kind: 'module' }, candidates: moduleCandidates,
          selectedCandidateId: 'candidate-1', selectedCandidateIds: ['candidate-1', 'candidate-2', 'candidate-3'] }}
        dispatch={vi.fn()} adaptationProvider="DeepSeek" onSelectCandidate={onSelectCandidate} onAdapt={vi.fn()}
      />));
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('.candidate-item')];
      expect(buttons).toHaveLength(4);
      expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'false']);
      expect(buttons[3]!.disabled).toBe(true);
      act(() => buttons[3]!.click());
      expect(onSelectCandidate).not.toHaveBeenCalled();
      act(() => buttons[1]!.click());
      expect(onSelectCandidate).toHaveBeenCalledWith('candidate-2');
      expect(container.textContent).toContain('已选择 3/3 个参考模块');
    } finally {
      act(() => root.unmount());
      reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
