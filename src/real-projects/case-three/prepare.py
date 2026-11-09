"""Export the pinned BullMQ TypeScript/Redis implementation, using canonical Git blobs."""
from io import BytesIO
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
BENCH = HERE.parents[2]
WORK = BENCH / "work"
SHA = "b2aa09331e60ca92cefcf78cca7cf0b706dc7eb4"
URL = "https://github.com/taskforcesh/bullmq.git"
IMAGE = "recast-bench-bullmq:node24-redis725-v1"
KEYS = "src/classes/queue-keys.ts"
CHANGE = "src/commands/changePriority-7.lua"
COUNTS = "src/commands/getCountsPerPriority-2.lua"
KEY_SKELETON = """export type KeysMap = { [index in string]: string };

export class QueueKeys {
  constructor(public readonly prefix = 'bull') {}

  getKeys(name: string): KeysMap {
    throw new Error('TODO: build the BullMQ queue key map');
  }

  toKey(name: string, type: string): string {
    throw new Error('TODO: qualify a queue key');
  }

  getQueueQualifiedName(name: string): string {
    throw new Error('TODO: qualify a queue name');
  }
}
"""


def source():
    existing = BENCH / "corpora/enterprise-asset-upgrade/source-repositories/bullmq"
    cached = WORK / "bullmq-pinned"
    for candidate in (existing, cached):
        if (candidate / ".git").exists() and subprocess.run(
                ["git", "-C", candidate, "cat-file", "-e", SHA + "^{commit}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return candidate
    with TemporaryDirectory(dir=WORK) as temp:
        clone = Path(temp) / "source"
        subprocess.run(["git", "init", "--quiet", str(clone)], check=True)
        subprocess.run(["git", "-C", clone, "fetch", "--depth=1", URL, SHA], check=True)
        try:
            clone.rename(cached)
        except OSError:
            if not cached.is_dir():
                raise
    return cached


def prepare(root, variant):
    WORK.mkdir(exist_ok=True)
    repo = source()
    if subprocess.run(["docker", "image", "inspect", IMAGE], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode:
        subprocess.run(["docker", "build", "--platform", "linux/amd64", "-t", IMAGE, HERE], check=True)
    raw_paths = subprocess.check_output(["git", "-C", repo, "ls-tree", "-r", "--name-only", SHA, "src"])
    paths = [p for p in raw_paths.decode().splitlines() if p.endswith((".ts", ".lua")) and
             not p.startswith("src/postgres/")]
    paths.append("LICENSE")
    query = "".join(f"{SHA}:{p}\n" for p in paths).encode()
    objects = BytesIO(subprocess.check_output(["git", "-C", repo, "cat-file", "--batch"], input=query))
    for path in paths:
        _, kind, size = objects.readline().split()
        assert kind == b"blob", path
        data = objects.read(int(size))
        assert objects.read(1) == b"\n"
        if variant == "starter" and path == KEYS:
            data = KEY_SKELETON.encode()
        elif variant == "starter" and path in (CHANGE, COUNTS):
            # Preserve the upstream command ABI comment only. All executable
            # statements and include directives are left to the participant.
            header, end, _ = data.partition(b"]]")
            assert end and header.startswith(b"--[["), path
            data = header + end + b'\nerror("TODO: implement this Redis command")\n'
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    target = root / "bench-public" / "priority.mjs"
    target.parent.mkdir()
    target.write_bytes((HERE / "public.mjs").read_text("utf-8").encode())


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), sys.argv[2])
