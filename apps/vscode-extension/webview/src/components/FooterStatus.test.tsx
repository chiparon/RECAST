import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { FooterStatus } from './FooterStatus';

it('shows database waiting as preparation and exposes a startup failure reason', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FooterStatus repositoryStatuses={[]} codeIntelligence={null} workspaceRoot=""
      serviceStatus={{ moduleSearch: 'starting', adaptation: 'starting', executionMode: 'real', message: '数据库升级中，翻译服务等待索引就绪。' }} />));
    expect(container.textContent).toContain('翻译 准备中');
    expect(container.querySelectorAll('.is-starting')).toHaveLength(2);
    expect(container.querySelector('.is-error')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('数据库升级中');
    await act(async () => root.render(<FooterStatus repositoryStatuses={[]} codeIntelligence={null} workspaceRoot=""
      serviceStatus={{ moduleSearch: 'error', adaptation: 'error', executionMode: 'real', message: '索引数据库初始化失败（数据库错误码 1142）：access denied' }} />));
    expect(container.textContent).toContain('翻译 异常');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1142');
  } finally { await act(async () => root.unmount()); }
});
