"""Compile every skeleton without executing its unimplemented business methods."""
import argparse
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
RUNTIME = Path.home() / '.local/share/recast/toolchains'


def executable(name, pattern=None):
    command = shutil.which(name)
    if command:
        return command
    matches = sorted(RUNTIME.glob(pattern or f'*/bin/{name}'))
    if matches:
        return str(matches[-1])
    raise RuntimeError(f'Missing {name} compiler in PATH or platform runtime')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--language', choices=['Python', 'C#', 'TypeScript', 'Go', 'Java'], required=True)
    args = parser.parse_args()
    cases = [c for c in json.loads((ROOT / 'queries.json').read_text())['cases'] if c['language'] == args.language]
    results = []
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix='recast-skeleton-compile-') as temp:
        for case in cases:
            target = ROOT / case['targetPath']
            if args.language == 'Python':
                sys.path.insert(0, str(target / 'src'))
                try:
                    for source in case['writeFiles']:
                        if not source.endswith('__init__.py'):
                            importlib.import_module('parallel_module.' + Path(source).stem)
                    result = {'caseId': case['caseId'], 'success': True, 'check': 'import'}
                finally:
                    sys.path.pop(0)
                    for module in list(sys.modules):
                        if module == 'parallel_module' or module.startswith('parallel_module.'):
                            del sys.modules[module]
            else:
                if args.language == 'C#':
                    command = [executable('dotnet'), 'build', 'ParallelModule.csproj', '--nologo', '--verbosity', 'quiet']
                elif args.language == 'TypeScript':
                    command = [executable('node'), str(REPO / 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']
                elif args.language == 'Java':
                    command = [executable('javac'), '-encoding', 'UTF-8', '--release', '17', '-d', str(Path(temp) / case['caseId'])] + case['writeFiles']
                else:
                    command = [executable('go', 'go*/go/bin/go'), 'test', './...']
                response = subprocess.run(command, cwd=target, capture_output=True, text=True, timeout=120)
                result = {'caseId': case['caseId'], 'success': response.returncode == 0,
                          'command': command, 'output': response.stdout + response.stderr}
            results.append(result)
            print(case['caseId'], args.language, 'PASS' if result['success'] else result.get('output', 'FAIL'), flush=True)
    report_dir = ROOT / 'toolchain-reports'
    report_dir.mkdir(exist_ok=True)
    (report_dir / (args.language.replace('#', 'sharp').lower() + '.json')).write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    assert len(results) == 10 and all(result['success'] for result in results)


if __name__ == '__main__':
    main()
