import { expect, it } from 'vitest';
import { platformLocalPath, repositoryPathIdentity } from './platform-path';

it('keeps one identity for Windows and WSL aliases without folding Linux paths', () => {
  const key = repositoryPathIdentity('E:\\CS\\DevSys\\history\\');
  expect(repositoryPathIdentity('/mnt/e/cs/devsys/history')).toBe(key);
  expect(repositoryPathIdentity('e:/cs/devsys/history')).toBe(key);
  expect(repositoryPathIdentity('/mnt/E/CS/DevSys/history/')).toBe(key);
  expect(repositoryPathIdentity('/home/team/History')).not.toBe(repositoryPathIdentity('/home/team/history'));
  expect(repositoryPathIdentity('/home/team/history/')).toBe('/home/team/history');
});

it('translates persisted roots before scanning while preserving native paths', () => {
  expect(platformLocalPath('E:\\CS\\history')).toBe(process.platform === 'win32' ? 'E:\\CS\\history' : '/mnt/e/CS/history');
  expect(platformLocalPath('/mnt/e/CS/history')).toBe(process.platform === 'win32' ? 'E:\\CS\\history' : '/mnt/e/CS/history');
  expect(platformLocalPath('/home/team/history')).toBe('/home/team/history');
});
