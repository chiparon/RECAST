import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import type { SourceRange } from '@forexplore/contracts';
import type {
  TreeSitterLanguageId,
  TreeSitterLanguageRegistration,
} from './language-registry.js';

export type StructuralSourceRange = SourceRange;

export type StructuralSymbolKind =
  | 'class'
  | 'constructor'
  | 'enum'
  | 'field'
  | 'function'
  | 'implementation'
  | 'interface'
  | 'method'
  | 'namespace'
  | 'package'
  | 'property'
  | 'record'
  | 'struct'
  | 'type';

export interface TreeSitterDeclaration {
  astDeclarationId: string;
  containerSymbolKey?: string;
  declarationNodeType: string;
  isExported: boolean;
  kind: StructuralSymbolKind;
  name: string;
  qualifiedName: string;
  relativePath: string;
  signature: string;
  sourceRange: StructuralSourceRange;
  /**
   * Stable structural identity: qualified declaration, normalized signature,
   * grammar node type, and language. Position is deliberately not part of it.
   */
  symbolKey: string;
}

export interface TreeSitterImport {
  importKind: 'import' | 're-export';
  languageId: TreeSitterLanguageId;
  relativePath: string;
  sourceRange: StructuralSourceRange;
  targetReference: string;
}

export interface TreeSitterExport {
  exportKind: 'declaration' | 'named' | 're-export';
  languageId: TreeSitterLanguageId;
  relativePath: string;
  sourceRange: StructuralSourceRange;
  targetReference?: string;
}

export interface TreeSitterDiagnostic {
  code: 'TREE_SITTER_PARSE_ERROR';
  message: string;
  relativePath: string;
  severity: 'warning';
  sourceRange?: StructuralSourceRange;
}

export interface TreeSitterFileIndex {
  declarations: TreeSitterDeclaration[];
  diagnostics: TreeSitterDiagnostic[];
  exports: TreeSitterExport[];
  imports: TreeSitterImport[];
  languageId: TreeSitterLanguageId;
  relativePath: string;
}

export interface TreeSitterIndexRequest {
  content: string;
  language: TreeSitterLanguageRegistration;
  relativePath: string;
}

const declarationKinds: Readonly<Record<string, StructuralSymbolKind>> = {
  class_specifier: 'class',
  struct_specifier: 'struct',
  enum_specifier: 'enum',
  namespace_definition: 'namespace',
  object_declaration: 'class',
  package_header: 'package',
  // TypeScript and ArkTS spell an abstract class with its own node type, not
  // `class_declaration`. Measured on
  // fixtures/code-corpus/commons-fileupload-ts/src/file-upload.ts:
  // `abstract class FileUploadBase` was neither a declaration nor a container,
  // so its ten `public_field_definition` members and its seven
  // `method_definition`s carried bare qualified names (`sizeMax`,
  // `parseRequest`) with no `containerSymbolKey` at all, while the class itself
  // was absent from the index. An abstract class is where a contract lives and
  // the platform promotes a member to its declaring class by that container, so
  // both halves were unreachable. The node names itself through a `name` field
  // and owns a `class_body`, exactly like `class_declaration`, so `class` is the
  // only mapping this needs (measured corpus-wide on the scanner's own file set:
  // one `abstract_class_declaration`, in that file).
  abstract_class_declaration: 'class',
  // The abstract members of such a class are `abstract_method_signature`, a
  // node type distinct from the `method_definition` beside them and from the
  // `method_signature` an interface uses. Left unmapped they were invisible:
  // `FileUploadBase.getFileItemFactory` and `setFileItemFactory` — the two
  // operations a concrete subclass is obliged to provide — produced no symbol
  // at all, while non-abstract and interface methods both index. Only an
  // abstract declaration spells this node type, so the node type alone settles
  // the kind; `name` is a `property_identifier` and there is no body.
  abstract_method_signature: 'method',
  annotation_type_declaration: 'interface',
  class_declaration: 'class',
  class_definition: 'class',
  constructor_declaration: 'constructor',
  // C and C++ declare through `declaration` whether or not a body follows, and a
  // header is made of little else. Measured on
  // fixtures/code-corpus/harmony-upload-native/app/src/main/cpp/upload_bridge.h:
  // both namespace-scope functions and all three `extern "C"` JNI exports were
  // invisible because this node type was absent, while the matching .cpp
  // definitions were extracted. The node type cannot say whether it declares a
  // function or data, so the declarator decides (see classifyDeclaration).
  declaration: 'field',
  delegate_declaration: 'type',
  enum_declaration: 'enum',
  enum_item: 'enum',
  field_declaration: 'field',
  function_declaration: 'function',
  function_definition: 'function',
  function_item: 'function',
  impl_item: 'implementation',
  interface_declaration: 'interface',
  method_declaration: 'method',
  method_definition: 'method',
  method_signature: 'method',
  file_scoped_namespace_declaration: 'namespace',
  namespace_declaration: 'namespace',
  package_clause: 'package',
  package_declaration: 'package',
  property_declaration: 'property',
  // A TypeScript or ArkTS class property is a `public_field_definition`, whatever
  // its accessibility, `static`, `abstract` or `?` modifier says. Measured on
  // fixtures/code-corpus/harmony-upload-arkts/entry/src/main/ets/pages/UploadPage.ets:
  // the page component's `@State progress`, `@Prop fileName` and `@Link session`
  // never reached the index, nor did `UploadBridge.native`, while the
  // `method_signature` beside them in the same file was mapped — so the file
  // indexed as structure with no state, and a page's state is what a HarmonyOS
  // developer asks for by name. The grammar makes this node a child of
  // `class_body` only, so the node type alone settles the kind and no scope guard
  // is needed; see classifyDeclaration for why a body still cannot leak a local.
  public_field_definition: 'field',
  record_declaration: 'record',
  struct_declaration: 'struct',
  struct_item: 'struct',
  trait_item: 'interface',
  type_spec: 'type',
  // ECMAScript and TypeScript bind names through a lexical/variable
  // declaration wrapper rather than a class-style field node.  Treat those
  // bindings as structural fields so exported constants and functions stored
  // in variables are discoverable without claiming semantic call edges.
  lexical_declaration: 'field',
  variable_declaration: 'field',
};

const containerKinds = new Set<StructuralSymbolKind>([
  'class',
  'constructor',
  'enum',
  'function',
  'implementation',
  'interface',
  'method',
  'namespace',
  'package',
  'record',
  'struct',
  'type',
]);

const identifierNodeTypes = new Set([
  'dotted_name',
  'field_identifier',
  'identifier',
  'package_identifier',
  'property_identifier',
  'qualified_name',
  'qualified_identifier',
  'simple_identifier',
  'scoped_identifier',
  'type_identifier',
]);

function normalizedText(value: string, maximum = 1_000): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sourceFor(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function rangeForNode(node: Parser.SyntaxNode): StructuralSourceRange {
  const startLine = node.startPosition.row + 1;
  const startColumn = node.startPosition.column + 1;
  const endLine = node.endPosition.row + 1;
  const rawEndColumn = node.endPosition.column + 1;
  return {
    startLine,
    startColumn,
    endLine,
    // Missing/error nodes may have zero width. The shared contract requires a
    // non-empty, end-exclusive range, so retain the insertion point as one
    // column wide.
    endColumn: endLine === startLine && rawEndColumn <= startColumn
      ? startColumn + 1
      : rawEndColumn,
  };
}

/** Build a one-based source range for non-AST project manifest tokens. */
export function sourceRangeForOffsets(
  source: string,
  startOffset: number,
  endOffset: number,
): StructuralSourceRange {
  const boundedStart = Math.max(0, Math.min(source.length, startOffset));
  const boundedEnd = Math.max(boundedStart, Math.min(source.length, endOffset));
  const position = (offset: number): { column: number; line: number } => {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < offset; index += 1) {
      if (source[index] === '\n') {
        line += 1;
        lineStart = index + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  };
  const start = position(boundedStart);
  const end = position(boundedEnd);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.line === start.line && end.column <= start.column
      ? start.column + 1
      : end.column,
  };
}

function declarationKind(node: Parser.SyntaxNode): StructuralSymbolKind | undefined {
  return declarationKinds[node.type];
}

/**
 * Declarators that stand between a `function_declarator` and the name it
 * declares. `int (*cb)(int);` declares a function *pointer* — a data member —
 * even though it contains a function declarator. `int *lookup(int)` is the
 * other way round: the pointer sits above the function declarator and the
 * function is still a function.
 */
const indirectDeclaratorTypes = new Set([
  'abstract_pointer_declarator',
  'array_declarator',
  'parenthesized_declarator',
  'pointer_declarator',
  'reference_declarator',
]);

/** The `function_declarator` of a node that declares a function. */
function functionDeclarator(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let current = node.childForFieldName('declarator'); current;) {
    if (current.type === 'function_declarator') {
      const name = current.childForFieldName('declarator');
      return name && !indirectDeclaratorTypes.has(name.type) ? current : undefined;
    }
    current = current.childForFieldName('declarator');
  }
  return undefined;
}

/** Where a declaration sits, which the node type alone cannot express. */
type DeclarationScope = 'callable' | 'type';

/**
 * Node types whose body holds the members of the declaration that owns it.
 * They are only meaningful together with that owner: `declaration_list` also
 * wraps a C++ namespace and a C# namespace, whose contents are not members.
 */
const typeBodyNodeTypes = new Set([
  'class_body',
  'class_interface',
  'declaration_list',
  'enum_body',
  'enum_class_body',
  'field_declaration_list',
  'interface_body',
  'object_body',
]);

/** Declarations that own a type body, so a function inside it is a method. */
const typeDeclarationNodeTypes = new Set([
  'abstract_class_declaration',
  'annotation_type_declaration',
  'class_declaration',
  'class_definition',
  'class_specifier',
  'companion_object',
  'enum_declaration',
  'enum_specifier',
  'impl_item',
  'interface_declaration',
  'object_declaration',
  'record_declaration',
  'struct_declaration',
  'struct_item',
  'struct_specifier',
  'trait_item',
  'union_specifier',
]);

/**
 * Ancestors that make everything below them local to a callable body. The
 * statement blocks in between (`block`, `statement_block`,
 * `compound_statement`) are deliberately absent: they are only local because
 * of the callable that owns them, and walking on finds it.
 */
const callableAncestorNodeTypes = new Set([
  'annotated_lambda',
  'anonymous_function',
  'arrow_function',
  'closure_expression',
  'constructor_declaration',
  'function_body',
  'function_declaration',
  'function_definition',
  'function_expression',
  'function_item',
  'generator_function',
  'lambda_expression',
  'lambda_literal',
  'local_function_statement',
  'method_declaration',
  'method_definition',
]);

/**
 * Node types that always declare a callable, so only their position decides
 * whether they are a method. Kotlin spells a member function and a top-level
 * function `function_declaration` alike.
 */
const callableDeclarationNodeTypes = new Set([
  'function_declaration',
  'function_item',
  'method_declaration',
  'method_definition',
  'method_signature',
]);

/**
 * C/C++ node types whose declarator, not the node type, says whether a
 * function or data is being declared.
 */
const declaratorDecidedNodeTypes = new Set([
  'declaration',
  'field_declaration',
  'function_definition',
]);

function declarationScope(node: Parser.SyntaxNode): DeclarationScope | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (typeBodyNodeTypes.has(parent.type) && parent.parent &&
      typeDeclarationNodeTypes.has(parent.parent.type)) return 'type';
    if (callableAncestorNodeTypes.has(parent.type)) return 'callable';
  }
  return undefined;
}

/**
 * Refines the node-type default with the two things only the parent chain and
 * the declarator can answer:
 *   - a function declared inside a class body is a method. C++ spells a member
 *     function prototype `field_declaration` and Kotlin spells a member
 *     function `function_declaration`, so `ChunkWriter::write`, `flush`,
 *     `written` and `UploadSession.transfer` were reported as fields or plain
 *     functions; `field` is not in the retrieval `functionKinds`, so declared
 *     methods were not retrievable as functions;
 *   - a binding declared inside a callable body is a local, not a field:
 *     `const handle = this.native.beginUpload(...)` inside a method and the
 *     `val bytes`/`val sent` inside a Kotlin lambda are not structure;
 *   - C++ parses an in-class `std::size_t written_ = 0;` as a body-less
 *     function definition, and that declares data.
 */
function classifyDeclaration(
  node: Parser.SyntaxNode,
  base: StructuralSymbolKind,
  languageId: TreeSitterLanguageId,
): StructuralSymbolKind | undefined {
  const scope = declarationScope(node);
  const declaratorDecided = (languageId === 'c' || languageId === 'cpp') &&
    declaratorDecidedNodeTypes.has(node.type);
  const declaresFunction = declaratorDecided
    ? functionDeclarator(node) !== undefined
    : callableDeclarationNodeTypes.has(node.type);
  if (declaresFunction) {
    if (base === 'field') return scope === 'type' ? 'method' : 'function';
    return base === 'function' && scope === 'type' ? 'method' : base;
  }
  // The declarator settled it: this node declares data.
  if (declaratorDecided) {
    if (scope === 'callable') return undefined;
    return base === 'function' ? 'field' : base;
  }
  if (base === 'field' && scope === 'callable') return undefined;
  return base;
}

/**
 * Kotlin spells `interface` and `enum class` with a `class_declaration` node,
 * so the kind has to come from the node's own keyword: `interface` is an
 * anonymous child and `enum` is a `class_modifier`. Both were reported as
 * `class`, which is what `classKinds` routes class-level evidence by.
 */
function kotlinClassKind(node: Parser.SyntaxNode): StructuralSymbolKind | undefined {
  if (node.children.some((child) => !child.isNamed && child.type === 'interface')) return 'interface';
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  if (modifiers?.namedChildren.some((child) => child.type === 'class_modifier' && child.text.trim() === 'enum')) {
    return 'enum';
  }
  return undefined;
}

function nameNodeFor(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  // Native function names can be nested under pointer/qualified declarators;
  // inspecting the return type first would name `int sum()` as `int`.
  let declarator = node.childForFieldName('declarator');
  while (declarator) {
    const nested = declarator.childForFieldName('declarator');
    if (!nested) return declarator;
    declarator = nested;
  }
  for (const field of ['name', 'type', 'module_name']) {
    const candidate = node.childForFieldName(field);
    if (candidate) return candidate;
  }
  return node.namedChildren.find((candidate) => identifierNodeTypes.has(candidate.type));
}

function declarationName(node: Parser.SyntaxNode, source: string): string | undefined {
  const candidate = nameNodeFor(node);
  const name = candidate ? normalizedText(sourceFor(candidate, source), 512) : '';
  return name || undefined;
}

/**
 * A class property can name itself with an expression instead of an identifier
 * (`readonly [key] = 1`). `nameNodeFor` reads the `name` field either way, so
 * the member would be recorded under the source text of an arbitrary
 * expression — `[key]`, a name no developer can ask for and no stable identity
 * can key on. Only the property node is skipped: a computed *method* name is
 * pre-existing behaviour in a path this fix does not otherwise touch, and
 * narrowing it would remove symbols that no measurement here called for.
 */
function isComputedPropertyName(node: Parser.SyntaxNode): boolean {
  return node.type === 'public_field_definition' &&
    node.childForFieldName('name')?.type === 'computed_property_name';
}

function signatureFor(node: Parser.SyntaxNode, source: string): string {
  const body = node.childForFieldName('body')
    ?? node.namedChildren.find((child) =>
      ['function_body', 'enum_class_body', 'block', 'class_body', 'declaration_list', 'interface_body', 'statement_block'].includes(child.type),
    );
  const end = body?.startIndex ?? node.endIndex;
  return normalizedText(source.slice(node.startIndex, end));
}

function parentExported(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === 'export_statement';
}

function declarationExported(
  node: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  name: string,
  source: string,
): boolean {
  if (parentExported(node)) return true;
  const text = sourceFor(node, source).trimStart();
  if (languageId === 'kotlin') return !/\b(private|internal)\b/.test(signatureFor(node, source));
  if (languageId === 'rust') return /^pub(?:\s*\([^)]*\))?\b/.test(text);
  if (languageId === 'java' || languageId === 'csharp') return /^public\b/.test(text);
  if (languageId === 'go') return /^[A-Z]/.test(name);
  return false;
}

function bindingDeclarationNames(node: Parser.SyntaxNode, source: string): string[] {
  if (!['field_declaration', 'lexical_declaration', 'variable_declaration'].includes(node.type)) return [];
  const names = node.descendantsOfType(['variable_declarator']);
  return names
    .map((entry) => entry.childForFieldName('name') ?? entry.namedChildren.find((child) => identifierNodeTypes.has(child.type)))
    .flatMap((entry) => entry ? [normalizedText(sourceFor(entry, source), 512)] : [])
    .filter(Boolean);
}

function declarationNames(node: Parser.SyntaxNode, source: string): string[] {
  const bindingNames = bindingDeclarationNames(node, source);
  if (bindingNames.length > 0) return bindingNames;
  return [declarationName(node, source)].filter((name): name is string => Boolean(name));
}

function fileScopeName(
  root: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  source: string,
): string | undefined {
  const fileScopeTypes = languageId === 'kotlin' ? new Set(['package_header']) : languageId === 'java'
    ? new Set(['package_declaration'])
    : languageId === 'csharp'
      ? new Set(['file_scoped_namespace_declaration'])
      : languageId === 'go'
        ? new Set(['package_clause'])
        : new Set<string>();
  const declaration = root.namedChildren.find((child) => fileScopeTypes.has(child.type));
  return declaration ? declarationName(declaration, source) : undefined;
}

function symbolKey(
  languageId: TreeSitterLanguageId,
  qualifiedName: string,
  kind: StructuralSymbolKind,
  signature: string,
  astDeclarationId: string,
): string {
  return `symbol:${hash(JSON.stringify({
    languageId,
    qualifiedName,
    kind,
    signature,
    astDeclarationId,
  }))}`;
}

function astDeclarationId(node: Parser.SyntaxNode, signature: string, relativePath: string): string {
  // Tree-sitter's runtime node.id is allocation-local. A normalized syntax
  // identity survives reparsing and does not rely on a line or byte offset.
  return `ast:${hash(JSON.stringify({ relativePath, nodeType: node.type, signature }))}`;
}

interface ContainerContext {
  qualifiedName: string;
  symbolKey: string;
}

function qualifiedNameFor(name: string, contexts: readonly ContainerContext[], fileScope?: string): string {
  const parent = contexts.at(-1)?.qualifiedName ?? fileScope;
  return parent ? `${parent}.${name}` : name;
}

function collectDeclarations(
  root: Parser.SyntaxNode,
  request: TreeSitterIndexRequest,
): TreeSitterDeclaration[] {
  const declarations: TreeSitterDeclaration[] = [];
  const fileScope = fileScopeName(root, request.language.languageId, request.content);

  const visit = (node: Parser.SyntaxNode, contexts: readonly ContainerContext[]): void => {
    const declaredKind = declarationKind(node);
    let kind = declaredKind && !isComputedPropertyName(node)
      ? classifyDeclaration(node, declaredKind, request.language.languageId)
      : undefined;
    if (kind && node.type === 'class_declaration' && request.language.languageId === 'kotlin') {
      kind = kotlinClassKind(node) ?? kind;
    }
    let nextContexts = contexts;
    if (kind) {
      const nodeNames = declarationNames(node, request.content);
      const signature = signatureFor(node, request.content);
      for (const name of nodeNames) {
        // A Java package, Go package, or file-scoped C# namespace is both
        // the file scope and a declaration record. Do not qualify that
        // declaration with itself; children still inherit the file scope.
        const qualifiedName = contexts.length === 0 && fileScope === name &&
          (kind === 'package' || kind === 'namespace')
          ? name
          : qualifiedNameFor(name, contexts, fileScope);
        const declarationId = astDeclarationId(node, signature, request.relativePath);
        const entry: TreeSitterDeclaration = {
          astDeclarationId: declarationId,
          declarationNodeType: node.type,
          isExported: declarationExported(node, request.language.languageId, name, request.content),
          kind,
          name,
          qualifiedName,
          relativePath: request.relativePath,
          signature,
          sourceRange: rangeForNode(node),
          symbolKey: symbolKey(request.language.languageId, qualifiedName, kind, signature, declarationId),
          ...(contexts.at(-1) ? { containerSymbolKey: contexts.at(-1)?.symbolKey } : {}),
        };
        declarations.push(entry);
        if (containerKinds.has(kind) && nodeNames.length === 1) {
          nextContexts = [...contexts, { qualifiedName, symbolKey: entry.symbolKey }];
        }
      }
    }
    for (const child of node.namedChildren) visit(child, nextContexts);
  };

  for (const child of root.namedChildren) visit(child, []);
  return dedupeBy(declarations, (entry) => entry.symbolKey);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ['"', "'", '`'].includes(trimmed[0] ?? '') && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function importTargets(
  node: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  source: string,
): Array<{ range: Parser.SyntaxNode; target: string }> {
  if (languageId === 'javascript' || languageId === 'typescript' || languageId === 'arkts') {
    const sourceNode = node.childForFieldName('source');
    return sourceNode ? [{ range: sourceNode, target: unquote(sourceFor(sourceNode, source)) }] : [];
  }
  if (languageId === 'c' || languageId === 'cpp') {
    const target = node.childForFieldName('path');
    return target ? [{ range: target, target: unquote(sourceFor(target, source)) }] : [];
  }
  if (languageId === 'kotlin') {
    const target = sourceFor(node, source).replace(/^\s*import\s+/, '').replace(/\s+as\s+\w+\s*$/, '').trim();
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'java') {
    const target = sourceFor(node, source)
      .replace(/^\s*import\s+(?:static\s+)?/, '')
      .replace(/;\s*$/, '')
      .trim();
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'csharp') {
    const target = sourceFor(node, source)
      .replace(/^\s*(?:global\s+)?using\s+(?:static\s+)?/, '')
      .replace(/;\s*$/, '')
      .trim()
      .replace(/^[A-Za-z_][\w]*\s*=\s*/, '');
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'python') {
    if (node.type === 'import_from_statement') {
      const moduleName = node.childForFieldName('module_name');
      const fromPrefix = /^\s*from\s+(\.*)/.exec(sourceFor(node, source))?.[1] ?? '';
      const module = moduleName ? sourceFor(moduleName, source) : '';
      return module || fromPrefix ? [{ range: moduleName ?? node, target: `${fromPrefix}${module}` }] : [];
    }
    return node.namedChildren
      .filter((child) => child.type === 'dotted_name')
      .map((child) => ({ range: child, target: sourceFor(child, source) }));
  }
  if (languageId === 'go') {
    const path = node.childForFieldName('path');
    return path ? [{ range: path, target: unquote(sourceFor(path, source)) }] : [];
  }
  if (languageId === 'rust') {
    const target = sourceFor(node, source)
      .replace(/^\s*use\s+/, '')
      .replace(/;\s*$/, '')
      .trim();
    return target ? [{ range: node, target }] : [];
  }
  return [];
}

function collectImports(root: Parser.SyntaxNode, request: TreeSitterIndexRequest): TreeSitterImport[] {
  const imports: TreeSitterImport[] = [];
  const importTypes = new Set(
    request.language.languageId === 'go'
      ? ['import_spec']
      : request.language.languageId === 'python'
        ? ['import_from_statement', 'import_statement']
        : request.language.languageId === 'rust'
          ? ['use_declaration']
          : ['import', 'import_header', 'preproc_include', 'import_declaration', 'import_statement', 'using_directive'],
  );
  const visit = (node: Parser.SyntaxNode): void => {
    if (importTypes.has(node.type)) {
      const reExport = node.parent?.type === 'export_statement';
      for (const target of importTargets(node, request.language.languageId, request.content)) {
        if (!target.target) continue;
        imports.push({
          importKind: reExport ? 're-export' : 'import',
          languageId: request.language.languageId,
          relativePath: request.relativePath,
          sourceRange: rangeForNode(target.range),
          targetReference: target.target,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return dedupeBy(imports, (entry) => `${entry.importKind}:${entry.targetReference}:${rangeKey(entry.sourceRange)}`);
}

function exportTarget(node: Parser.SyntaxNode, source: string): string | undefined {
  const declaration = node.childForFieldName('declaration');
  if (declaration) return declarationNames(declaration, source)[0];
  const clause = node.namedChildren.find((child) => ['export_clause', 'namespace_export', 'identifier'].includes(child.type));
  return clause ? normalizedText(sourceFor(clause, source), 512) : undefined;
}

function collectExports(
  root: Parser.SyntaxNode,
  request: TreeSitterIndexRequest,
  declarations: readonly TreeSitterDeclaration[],
): TreeSitterExport[] {
  const exports: TreeSitterExport[] = [];
  const add = (
    sourceRange: StructuralSourceRange,
    exportKind: TreeSitterExport['exportKind'],
    targetReference?: string,
  ): void => {
    exports.push({
      exportKind,
      languageId: request.language.languageId,
      relativePath: request.relativePath,
      sourceRange,
      ...(targetReference ? { targetReference } : {}),
    });
  };

  if (request.language.languageId === 'javascript' || request.language.languageId === 'typescript' || request.language.languageId === 'arkts') {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === 'export_statement') {
        const sourceNode = node.childForFieldName('source');
        add(
          rangeForNode(node),
          sourceNode ? 're-export' : 'declaration',
          sourceNode ? unquote(sourceFor(sourceNode, request.content)) : exportTarget(node, request.content),
        );
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
  } else {
    for (const declaration of declarations) {
      if (declaration.isExported) {
        add(declaration.sourceRange, 'declaration', declaration.qualifiedName);
      }
    }
  }
  return dedupeBy(exports, (entry) => `${entry.exportKind}:${entry.targetReference ?? ''}:${rangeKey(entry.sourceRange)}`);
}

function rangeKey(range: StructuralSourceRange): string {
  return `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`;
}

function collectDiagnostics(root: Parser.SyntaxNode, relativePath: string): TreeSitterDiagnostic[] {
  const diagnostics: TreeSitterDiagnostic[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if ((node.isError || node.isMissing) && diagnostics.length < 25) {
      diagnostics.push({
        code: 'TREE_SITTER_PARSE_ERROR',
        message: node.isMissing
          ? `Tree-sitter reported a missing ${node.type} node.`
          : `Tree-sitter reported a syntax error near ${node.type}.`,
        relativePath,
        severity: 'warning',
        sourceRange: rangeForNode(node),
      });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return dedupeBy(diagnostics, (entry) => `${entry.message}:${entry.sourceRange ? rangeKey(entry.sourceRange) : ''}`);
}

function dedupeBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const result = new Map<string, T>();
  for (const entry of entries) result.set(key(entry), entry);
  return [...result.values()];
}

/**
 * Parses one already-authorized repository-relative source file. The parser
 * only produces structural evidence: declarations, import/export syntax,
 * source ranges, and parse diagnostics. It never attempts call-graph or
 * cross-file definition/reference claims.
 */
/**
 * ArkUI syntax remapped onto the TypeScript grammar without moving a single line or
 * column.
 *
 * `arkts` (.ets) is registered against the TypeScript grammar, so everything a
 * TypeScript file would contain already indexes correctly. Measured on
 * fixtures/code-corpus/harmony-upload-arkts: `UploadBridge`, its methods, its fields
 * and its imports — including the native `libentry.so` binding — all extract. What
 * the grammar cannot read is the ArkUI layer: `@Entry @Component struct UploadPage`
 * produced eight syntax errors, the page component (the symbol a HarmonyOS
 * developer actually names) never reached the index, and UI builder calls such as
 * `Column(...)` were misread as methods.
 *
 * Two substitutions, both exactly as wide as what they replace, so every source
 * range, column and content hash derived from this text still points at the
 * original file:
 *   `struct Name`  ->  `class  Name`
 *   `@Decorator`   ->  blanks
 *
 * Decorators are only blanked outside string literals: the fixture imports from
 * `'@kit.BasicServicesKit'`, and rewriting that would silently break the import
 * the graph is built on.
 */
export function normalizeArkTs(content: string): string {
  return content.split('\n').map((line) => {
    let text = '';
    let quote: string | undefined;
    for (let index = 0; index < line.length;) {
      const character = line[index]!;
      if (quote) {
        if (character === '\\') { text += line.slice(index, index + 2); index += 2; continue; }
        if (character === quote) quote = undefined;
        text += character; index += 1; continue;
      }
      if (character === "'" || character === '"' || character === '`') { quote = character; text += character; index += 1; continue; }
      if (character === '@' && /[A-Za-z_]/.test(line[index + 1] ?? '')) {
        let end = index + 1;
        while (end < line.length && /[A-Za-z0-9_]/.test(line[end]!)) end += 1;
        text += ' '.repeat(end - index); index = end; continue;
      }
      if (line.startsWith('struct', index) && /\s/.test(line[index + 6] ?? ' ')) { text += 'class '; index += 6; continue; }
      text += character; index += 1;
    }
    return text;
  }).join('\n');
}

export function indexTreeSitterFile(request: TreeSitterIndexRequest): TreeSitterFileIndex {
  const parser = new Parser();
  parser.setLanguage(request.language.grammar as never);
  // ArkUI syntax is remapped for arkts only; every other language is parsed verbatim.
  const content = request.language.languageId === 'arkts' ? normalizeArkTs(request.content) : request.content;
  // The native binding's default input buffer cannot accept an entire large string.
  const tree = parser.parse((offset) => content.slice(offset, offset + 8192));
  const declarations = collectDeclarations(tree.rootNode, { ...request, content });
  return {
    declarations,
    diagnostics: collectDiagnostics(tree.rootNode, request.relativePath),
    exports: collectExports(tree.rootNode, { ...request, content }, declarations),
    imports: collectImports(tree.rootNode, { ...request, content }),
    languageId: request.language.languageId,
    relativePath: request.relativePath,
  };
}

export const treeSitterIndexerInternals = {
  declarationKind,
  normalizedText,
  signatureFor,
  sourceRangeForOffsets,
  normalizeArkTs,
};
