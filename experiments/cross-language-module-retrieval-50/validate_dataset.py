"""Check sample identities, language changes, stub-only source and absence of gold leakage."""
import ast
import collections
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent

def main():
    answers = json.loads((ROOT / 'oracle/answers.json').read_text())
    queries = json.loads((ROOT / 'queries.json').read_text())['cases']
    catalog = json.loads((ROOT / 'oracle/catalog-snapshot.json').read_text())['modules']
    known = {(x['repositoryId'], x['revision'], x['projectId'], x['module']['id']) for x in catalog}
    assert collections.Counter(q['language'] for q in queries) == {'Python': 10, 'C#': 10, 'TypeScript': 10, 'Go': 10, 'Java': 10}
    seen = set()
    errors = []
    assert len(answers['cases']) == len(queries) == 50
    for answer, query in zip(answers['cases'], queries):
        gold = answer['gold']
        key = tuple(gold[k] for k in ['repositoryId', 'revision', 'projectId', 'moduleId'])
        assert key in known and key not in seen
        seen.add(key)
        assert gold['sourceLanguage'].lower().replace('csharp', 'c#') != answer['language'].lower().replace('csharp', 'c#')
        assert answer['caseId'] == query['caseId']
        assert not any(k in query for k in ['gold', 'sourceFiles', 'equivalentAnswers', 'productionSourceHashes'])
        target = ROOT / query['targetPath']
        for path in target.rglob('*'):
            if not path.is_file() or any(p in {'bin', 'obj', '__pycache__'} for p in path.parts):
                continue
            text = path.read_text()
            for forbidden in [gold['moduleId'], gold['repositoryId'], gold['revision'], 'oracle/', gold['artifactId']]:
                if forbidden in text:
                    errors.append(f'{path}: leaked {forbidden}')
            if path.suffix == '.py':
                tree = ast.parse(text, filename=str(path))
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        body = node.body
                        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                            body = body[1:]
                        is_stub = len(body) == 1 and (
                            isinstance(body[0], ast.Raise) and isinstance(body[0].exc, ast.Call)
                            and isinstance(body[0].exc.func, ast.Name) and body[0].exc.func.id == 'NotImplementedError'
                            or isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and body[0].value.value is Ellipsis)
                        if not is_stub:
                            errors.append(f'{path}: non-skeleton method {node.name}')
            if path.suffix == '.cs' and path.name == 'Service.cs':
                methods = [line for line in text.splitlines() if line.strip().startswith('public ') and '(' in line]
                if not methods or not all('=> throw new NotImplementedException(' in line for line in methods):
                    errors.append(f'{path}: non-skeleton C# service')
            if path.suffix == '.ts' and path.name == 'service.ts':
                declarations = [line for line in text.splitlines() if '): ' in line and '{' in line]
                if not declarations or not all('{ throw new Error("Business implementation pending"); }' in line for line in declarations):
                    errors.append(f'{path}: non-skeleton TypeScript service')
            if path.suffix == '.java' and path.name not in {'Models.java', 'Views.java'} and 'Contract' not in path.name:
                declarations = [line for line in text.splitlines() if '@Override public' in line]
                if not declarations or not all('{ throw new UnsupportedOperationException("Business implementation pending"); }' in line for line in declarations):
                    errors.append(f'{path}: non-skeleton Java service')
            if path.suffix == '.go' and path.name == 'service.go':
                bodies = re.findall(r'func [^\n]+ \{([^}]+)\}', text)
                if not bodies or not all(body.strip() == 'panic("Business implementation pending")' for body in bodies):
                    errors.append(f'{path}: non-skeleton Go service')
        actual_sources = {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file() and p.suffix in {'.py', '.cs', '.ts', '.java', '.go'} and not any(part in {'bin', 'obj', '__pycache__'} for part in p.parts)}
        assert actual_sources == set(query['writeFiles']), f'{query["caseId"]}: unlisted or stale source files'
        for relative in query['writeFiles']:
            assert (target / relative).is_file()
        source_root = ROOT.parent / 'enterprise-asset-upgrade/reference-sources' / gold['repository']
        for source in answer['productionSourceHashes']:
            if hashlib.sha256((source_root / source['path']).read_bytes()).hexdigest() != source['sha256']:
                errors.append(f'{answer["caseId"]}: historical source drift {source["path"]}')
    assert not errors, '\n'.join(errors)
    result = {'cases': len(queries), 'uniqueGoldModules': len(seen), 'populationNodes': len(catalog),
        'repositoryDistribution': dict(collections.Counter(a['gold']['repository'] for a in answers['cases'])),
        'languageDistribution': dict(collections.Counter(q['language'] for q in queries)),
        'sourceFiles': sum(len(q['writeFiles']) for q in queries),
        'syntaxStubAndLeakageChecks': 'passed', 'historicalSourceHashChecks': 'passed',
        'retrievalExecuted': False, 'behavioralEquivalenceVerified': False}
    (ROOT / 'validation-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
