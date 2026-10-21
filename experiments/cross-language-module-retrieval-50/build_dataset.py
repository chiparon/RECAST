"""Reproduce the local 50-case skeleton dataset from the frozen history catalog."""
import collections
import hashlib
import json
from pathlib import Path
import random
import re
from multilang import emit

ROOT = Path(__file__).resolve().parent
SEED = 20261010
QUOTAS = {'apache-camel': 12, 'apscheduler': 5, 'bullmq': 7,
          'commons-fileupload': 3, 'flowable-engine': 2, 'keycloak': 6, 'nopcommerce': 15}
SOURCE_ROOT = ROOT.parent / 'enterprise-asset-upgrade' / 'reference-sources'


def production_files(module):
    return [f for f in module['sourceFiles']
            if Path(f).suffix.lower() in {'.java', '.cs', '.ts', '.py', '.js'}
            and not any(p.lower() in {'test', 'tests', '__tests__', 'generated', 'generated-sources'} for p in Path(f).parts)
            and not Path(f).name.endswith(('.test.ts', '.spec.ts', '.d.ts'))]


def select(catalog):
    parents = collections.defaultdict(set)
    for entry in catalog:
        parents[entry['artifactId']].add(entry['module'].get('parentId'))
    pools = collections.defaultdict(list)
    for entry in catalog:
        module = entry['module']
        if (module['id'] not in parents[entry['artifactId']] and production_files(module)
                and module.get('language')
                and not any(word in module['name'] for word in ['测试', '构建', '文档', '迁移 4', '迁移 5'])):
            pools[entry['repository']].append(entry)
    rng = random.Random(SEED)
    selected = []
    for repo, quota in QUOTAS.items():
        selected.extend(rng.sample(sorted(pools[repo], key=lambda x: x['module']['id']), quota))
    # flowable-engine was removed from the benchmark after its historical revision drifted.
    # Replace its two reserved slots with stable, previously unselected nopcommerce leaves;
    # preserve all other sampled identities and the 50-case language/design positions.
    flowable_slots = [i for i, entry in enumerate(selected) if entry['repository'] == 'flowable-engine']
    selected = [entry for entry in selected if entry['repository'] != 'flowable-engine']
    used = {entry['module']['id'] for entry in selected}
    replacements = [entry for entry in sorted(pools['nopcommerce'], key=lambda x: x['module']['id']) if entry['module']['id'] not in used]
    assert len(replacements) >= len(flowable_slots)
    for slot, entry in zip(flowable_slots, replacements):
        selected.insert(slot, entry)
    return selected, {repo: len(pool) for repo, pool in pools.items()}


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def fields(design):
    return [part.split(':', 1) for part in design['fields'].split(';')]


def python_project(path, design):
    title, need, methods = design['title'], design['need'], design['methods']
    src = path / 'src' / 'parallel_module'
    src.mkdir(parents=True, exist_ok=True)
    (src / '__init__.py').write_text('"""Cross-language module contracts; implementation intentionally pending."""\n')
    (path / 'pyproject.toml').write_text('[project]\nname = "' + re.sub(r'(?<!^)(?=[A-Z])', '-', title).lower()
        + '"\nversion = "0.0.0"\nrequires-python = ">=3.11"\ndescription = "Cross-language contract skeleton"\n')
    model = '"""Domain data for this module."""\nfrom __future__ import annotations\nfrom dataclasses import dataclass\n\n'
    model += '@dataclass\nclass Record:\n    """' + need + '"""\n'
    model += ''.join(f'    {name}: {typ}\n' for name, typ in fields(design))
    (src / 'models.py').write_text(model)
    if methods:
        contract = '"""' + need + '"""\nfrom __future__ import annotations\nfrom typing import Protocol\nfrom .models import Record\n\n'
        contract += f'class {title}Contract(Protocol):\n'
        contract += ''.join(f'    def {method}:\n        ...\n\n' for method in methods)
        (src / 'contracts.py').write_text(contract)
        service = '"""' + need + '"""\nfrom __future__ import annotations\nfrom .contracts import ' + title + 'Contract\nfrom .models import Record\n\n'
        service += f'class {title}({title}Contract):\n'
        service += ''.join(f'    def {method}:\n        raise NotImplementedError("Business implementation pending")\n\n' for method in methods)
        (src / 'service.py').write_text(service)
    else:
        # Pure model modules stay model modules, without invented CRUD behavior.
        (src / 'views.py').write_text('"""Typed edit, search and list boundaries for the domain model."""\n'
            'from __future__ import annotations\nfrom dataclasses import dataclass\nfrom .models import Record\n\n'
            '@dataclass\nclass SearchView:\n    filter: Record\n    page_index: int\n    page_size: int\n\n'
            '@dataclass\nclass ListView:\n    items: list[Record]\n    total_count: int\n')
    for source in src.glob('*.py'):
        text = source.read_text()
        text = re.sub(r'\bRecord\b', title + 'Data', text)
        source.write_text(text)
    if design.get('models'):
        model = '"""' + need + '"""\nfrom __future__ import annotations\nfrom dataclasses import dataclass\nfrom decimal import Decimal\n\n'
        for schema in design['models']:
            model += '@dataclass\nclass ' + schema['name'] + ':\n'
            model += ''.join('    ' + field.replace(':', ': ', 1) + '\n' for field in schema['fields'].split(';')) + '\n'
        (src / 'models.py').write_text(model)
        if title == 'ShippingQuotationModels':
            # Requests, package items and responses are the complete model seams;
            # this module has no search/list administration responsibility.
            (src / 'views.py').unlink(missing_ok=True)
        else:
            entity = design['models'][0]['name']
            (src / 'views.py').write_text('"""Paged search and list contracts."""\nfrom __future__ import annotations\nfrom dataclasses import dataclass\nfrom .models import ' + entity + '\n\n'
                + '@dataclass\nclass SearchView:\n    search_text: str\n    page_index: int\n    page_size: int\n\n'
                + '@dataclass\nclass ListView:\n    items: list[' + entity + ']\n    total_count: int\n')
    return 'Python', [f.relative_to(path).as_posix() for f in sorted(src.glob('*.py'))]


def identity(entry):
    return {key: entry[key] for key in ['repository', 'repositoryId', 'revision', 'projectId', 'artifactId', 'planHash', 'analysisHash']} | {'moduleId': entry['module']['id']}


def main():
    snapshot = json.loads((ROOT / 'oracle' / 'catalog-snapshot.json').read_text())
    designs = json.loads((ROOT / 'case-designs.json').read_text())
    selected, pool_sizes = select(snapshot['modules'])
    assert len(designs) == len(selected) == 50
    manifest, public_cases = [], []
    for i, (entry, design) in enumerate(zip(selected, designs), 1):
        case_id = f'case-{i:03}'
        target = ROOT / 'targets' / case_id
        source_language = entry['module']['language'].lower()
        target_language = design['targetLanguage']
        assert source_language not in {'csharp' if target_language == 'C#' else target_language.lower(), target_language.lower()}
        language, write_files = python_project(target, design) if target_language == 'Python' else emit(target, design, target_language)
        requirement = design['need'] + '\n\n这是契约骨架。实现需保留数据边界和公开接口，并依据需求补充业务逻辑；当前测试只评估历史模块检索。\n'
        (target / 'README.md').write_text('# ' + design['title'] + '\n\n' + requirement)
        public = {'caseId': case_id, 'targetPath': f'targets/{case_id}', 'language': language,
                  'moduleName': design['title'], 'requirement': design['need'], 'writeFiles': write_files,
                  'businessLogicPresent': False, 'shape': 'model' if not design['methods'] else 'contract-and-service'}
        public_cases.append(public)
        hashes = []
        evidence = []
        for file in production_files(entry['module']):
            source = SOURCE_ROOT / entry['repository'] / file
            raw = source.read_bytes()
            hashes.append({'path': file, 'sha256': hashlib.sha256(raw).hexdigest()})
            text = raw.decode('utf-8', errors='replace')
            # Store bounded source context for review outside every target workspace.
            if len(evidence) < 3:
                evidence.append({'path': file, 'excerpt': text[:6000], 'truncated': len(text) > 6000})
        equivalents = []
        if i in [25, 26]:
            equivalents = [identity(x) for x in snapshot['modules']
                          if x['repository'] == 'commons-fileupload' and 'servlet' in x['module']['name']
                          and x['module']['id'] != entry['module']['id']]
        manifest.append(public | {'gold': identity(entry) | {'moduleName': entry['module']['name'], 'sourceLanguage': entry['module']['language']},
            'sourceFiles': entry['module']['sourceFiles'], 'productionSourceHashes': hashes,
            'equivalentAnswers': equivalents, 'ambiguity': 'Servlet API-version adapters implement near-identical behavior; exact identity and behavioral relevance must be scored separately.' if equivalents else None,
            'parallelism': 'Requirement-and-contract-level skeleton; not a verified executable translation of all historical behavior.',
            'coverage': {'scope': 'representative public seams; full history file inventory retained in oracle',
                         'historicalProductionFiles': len(hashes), 'targetSourceFiles': len(write_files)}})
        dump(ROOT / 'oracle' / 'evidence' / (case_id + '.json'), {'caseId': case_id, 'source': identity(entry), 'excerpts': evidence})
    dump(ROOT / 'queries.json', {'schemaVersion': 1, 'cases': public_cases})
    dump(ROOT / 'oracle' / 'answers.json', {'schemaVersion': 1, 'database': snapshot['database'], 'seed': SEED,
        'sampling': {'method': 'stratified random sample without replacement', 'populationNodes': len(snapshot['modules']),
                     'eligiblePerRepository': pool_sizes, 'eligibleTotal': sum(pool_sizes.values()), 'quotas': QUOTAS,
                     'eligibility': 'No child in the same proposal; has production source and language; exclude test/build/documentation and versioned migration modules.'},
        'retrievalScope': sorted({(x['repositoryId'], x['revision']) for x in selected}), 'cases': manifest})
    dump(ROOT / 'evaluation-config.json', {'database': snapshot['database'], 'queries': 'queries.json', 'answers': 'oracle/answers.json',
        'historyRoleOnly': True, 'restrictToSelected50': False, 'topK': 4,
        'pipeline': 'production target modeling -> production module recall/fusion -> candidate assembly -> production reranking',
        'metrics': ['gold_recall_before_reranking', 'exact_hit_at_1', 'exact_hit_at_4', 'mrr', 'equivalent_hit_at_4', 'stage_latency_ms'],
        'policy': 'Host loads oracle; target modeling and search/reranking inputs must not include oracle or case-designs.json. Never inject gold into candidate lists.'})
    print(f'Built {len(manifest)} cases, {sum(len(c["writeFiles"]) for c in manifest)} source files; seed={SEED}')


if __name__ == '__main__':
    main()
