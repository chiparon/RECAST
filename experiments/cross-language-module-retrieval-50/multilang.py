"""Dependency-free emitters for typed, unimplemented cross-language contracts."""
import ast
import json
from pathlib import Path


def pascal(name):
    return ''.join(x[:1].upper() + x[1:] for x in name.split('_'))


def methods(design):
    result = []
    for signature in design['methods']:
        node = ast.parse('def ' + signature + ':\n    pass\n').body[0]
        result.append((node.name, [(a.arg, a.annotation) for a in node.args.args if a.arg != 'self'], node.returns))
    return result


def translate(node, language, data, boxed=False):
    if isinstance(node, str):
        node = ast.parse(node, mode='eval').body
    if node is None or isinstance(node, ast.Constant) and node.value is None:
        return {'C#': 'void', 'Java': 'void', 'TypeScript': 'void', 'Go': ''}[language]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        base = translate(node.left, language, data, True)
        return {'C#': base + '?', 'Java': base, 'TypeScript': base + ' | null', 'Go': '*' + base}[language]
    if isinstance(node, ast.Name):
        common = {'Record': data}
        primitives = {
            'C#': {'str': 'string', 'int': 'int', 'float': 'double', 'bool': 'bool', 'object': 'object', 'bytes': 'byte[]', 'Decimal': 'decimal'},
            'Java': {'str': 'String', 'int': 'Integer' if boxed else 'int', 'float': 'Double' if boxed else 'double', 'bool': 'Boolean' if boxed else 'boolean', 'object': 'Object', 'bytes': 'byte[]', 'Decimal': 'BigDecimal'},
            'TypeScript': {'str': 'string', 'int': 'number', 'float': 'number', 'bool': 'boolean', 'object': 'unknown', 'bytes': 'Uint8Array', 'Decimal': 'number'},
            'Go': {'str': 'string', 'int': 'int', 'float': 'float64', 'bool': 'bool', 'object': 'any', 'bytes': '[]byte', 'Decimal': 'string'},
        }
        if node.id == 'Record' and language == 'Go':
            return '*' + data
        return primitives[language].get(node.id, common.get(node.id, node.id))
    if isinstance(node, ast.Subscript):
        outer = node.value.id
        args = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        types = [translate(a, language, data, True) for a in args]
        if outer == 'list':
            return {'C#': 'List<' + types[0] + '>', 'Java': 'List<' + types[0] + '>',
                    'TypeScript': 'Array<' + types[0] + '>', 'Go': '[]' + types[0]}[language]
        if outer == 'dict':
            return {'C#': 'Dictionary<' + ', '.join(types) + '>', 'Java': 'Map<' + ', '.join(types) + '>',
                    'TypeScript': '{ [key: string]: ' + types[1] + ' }', 'Go': 'map[' + types[0] + ']' + types[1]}[language]
    raise ValueError(ast.dump(node))


def schemas(design):
    return design.get('models') or [{'name': design['title'] + 'Data', 'fields': design['fields']}]


def emit(path, design, language):
    path.mkdir(parents=True, exist_ok=True)
    title, need, data = design['title'], design['need'], design['title'] + 'Data'
    specs = methods(design)
    models = schemas(design)
    created = []
    def write(relative, text, source=True):
        full = path / relative
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(text)
        if source:
            created.append(relative)
    def ty(annotation, boxed=False):
        return translate(annotation, language, data, boxed)
    if language == 'C#':
        write('ParallelModule.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n', False)
        text = 'namespace ParallelModule;\n\n/// <summary>' + need + '</summary>\n'
        for model in models:
            text += f'public sealed record {model["name"]}\n{{\n'
            for field in model['fields'].split(';'):
                name, annotation = field.split(':', 1)
                text += f'    public {ty(annotation)} {pascal(name)} {{ get; init; }} = default!;\n'
            text += '}\n\n'
        write('Models.cs', text)
        if specs:
            signatures = []
            for name, args, returns in specs:
                result = ty(returns)
                async_suffix = ''
                if design.get('async'):
                    result = 'Task' if result == 'void' else f'Task<{result}>'
                    async_suffix = 'Async'
                signatures.append(f'{result} {pascal(name)}{async_suffix}(' + ', '.join(f'{ty(a)} {n}' for n, a in args) + ')')
            write('Contracts.cs', f'namespace ParallelModule;\n\n/// <summary>{need}</summary>\npublic interface I{title}\n{{\n' + ''.join(f'    {s};\n' for s in signatures) + '}\n')
            write('Service.cs', f'namespace ParallelModule;\n\n/// <summary>{need}</summary>\npublic sealed class {title} : I{title}\n{{\n' + ''.join(f'    public {s} => throw new NotImplementedException("Business implementation pending");\n' for s in signatures) + '}\n')
    elif language == 'TypeScript':
        write('package.json', json.dumps({'name': 'parallel-contract-module', 'version': '0.0.0', 'private': True, 'type': 'module'}, indent=2) + '\n', False)
        write('tsconfig.json', json.dumps({'compilerOptions': {'target': 'ES2022', 'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'strict': True, 'noEmit': True, 'types': []}, 'include': ['src/**/*.ts']}, indent=2) + '\n', False)
        text = '/** ' + need + ' */\n'
        for model in models:
            text += 'export interface ' + model['name'] + ' {\n'
            for field in model['fields'].split(';'):
                name, annotation = field.split(':', 1)
                text += f'  {name}: {ty(annotation)};\n'
            text += '}\n\n'
        write('src/models.ts', text)
        if specs:
            signatures = [name + '(' + ', '.join(f'{"function_text" if n == "function" else n}: {ty(a)}' for n, a in args) + '): ' + ty(returns) for name, args, returns in specs]
            write('src/contracts.ts', f'import type {{ {data} }} from "./models.js";\n\n/** {need} */\nexport interface {title}Contract {{\n' + ''.join(f'  {s};\n' for s in signatures) + '}\n')
            write('src/service.ts', f'import type {{ {data} }} from "./models.js";\nimport type {{ {title}Contract }} from "./contracts.js";\n\n/** {need} */\nexport class {title} implements {title}Contract {{\n' + ''.join(f'  {s} {{ throw new Error("Business implementation pending"); }}\n' for s in signatures) + '}\n')
    elif language == 'Go':
        write('go.mod', 'module example.local/parallelmodule\n\ngo 1.22\n', False)
        text = 'package parallelmodule\n\n// ' + need + '\n'
        for model in models:
            text += 'type ' + model['name'] + ' struct {\n'
            for field in model['fields'].split(';'):
                name, annotation = field.split(':', 1)
                text += f'    {pascal(name)} {ty(annotation)}\n'
            text += '}\n\n'
        write('models.go', text)
        if specs:
            signatures = [pascal(name) + '(' + ', '.join(f'{n} {ty(a)}' for n, a in args) + ')' + (' ' + ty(returns) if ty(returns) else '') for name, args, returns in specs]
            write('contracts.go', f'package parallelmodule\n\n// {need}\ntype {title}Contract interface {{\n' + ''.join(f'    {s}\n' for s in signatures) + '}\n')
            write('service.go', f'package parallelmodule\n\n// {need}\ntype {title} struct {{}}\n\nvar _ {title}Contract = (*{title})(nil)\n\n' + ''.join(f'func (service *{title}) {s} {{\n    panic("Business implementation pending")\n}}\n\n' for s in signatures))
    elif language == 'Java':
        write('pom.xml', '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>local.parallel</groupId><artifactId>parallel-contract-module</artifactId><version>0.0.0</version><properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>\n', False)
        prefix = 'src/main/java/parallelmodule/'
        imports = 'package parallelmodule;\n\nimport java.util.*;\nimport java.math.BigDecimal;\n'
        text = imports + '\n/** ' + need + ' */\npublic final class Models {\n'
        for model in models:
            text += '    public static final class ' + model['name'] + ' {\n'
            for field in model['fields'].split(';'):
                name, annotation = field.split(':', 1)
                text += f'        public {ty(annotation)} {name};\n'
            text += '    }\n'
        write(prefix + 'Models.java', text + '}\n')
        if specs:
            signatures = [ty(returns) + ' ' + name + '(' + ', '.join(f'{ty(a)} {n}' for n, a in args) + ')' for name, args, returns in specs]
            imports += 'import parallelmodule.Models.*;\n'
            write(prefix + title + 'Contract.java', imports + f'\n/** {need} */\npublic interface {title}Contract {{\n' + ''.join(f'    {s};\n' for s in signatures) + '}\n')
            write(prefix + title + '.java', imports + f'\n/** {need} */\npublic final class {title} implements {title}Contract {{\n' + ''.join(f'    @Override public {s} {{ throw new UnsupportedOperationException("Business implementation pending"); }}\n' for s in signatures) + '}\n')
        elif title != 'ShippingQuotationModels':
            entity = models[0]['name']
            write(prefix + 'Views.java', imports + f'import parallelmodule.Models.{entity};\n\npublic final class Views {{\n    public static final class SearchView {{ public String search_text; public int page_index; public int page_size; }}\n    public static final class ListView {{ public List<{entity}> items; public int total_count; }}\n}}\n')
    else:
        raise ValueError(language)
    return language, created
