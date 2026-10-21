/**
 * Repository rows store one `local_path` string, but the same checkout has two
 * spellings depending on which platform wrote the row: a WSL process writes
 * `/mnt/e/cs/devsys/...` while a Windows process writes `E:\CS\devsys\...`.
 * A shared database can therefore hold a path that the current process cannot open.
 *
 * Translating at read time keeps both environments working and is a no-op for a
 * path that already matches the current platform, so single-platform use is unchanged.
 * The stored value is never rewritten, which is what makes this safe for concurrent
 * sessions on the other platform.
 */
export function platformLocalPath(stored: string): string {
  if (process.platform === 'win32') {
    const mount = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(stored);
    return mount ? `${mount[1]!.toUpperCase()}:\\${mount[2]!.replace(/\//g, '\\')}` : stored;
  }
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(stored);
  return windows ? `/mnt/${windows[1]!.toLowerCase()}/${windows[2]!.replace(/\\/g, '/')}` : stored;
}

/** One identity for a drive checkout, including its mounted WSL spelling. */
export function repositoryPathIdentity(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(normalized);
  const drive = mounted ? `${mounted[1]}:/${mounted[2] ?? ''}` : normalized;
  return /^[a-z]:\//i.test(drive) ? drive.toLowerCase() : drive || '/';
}
