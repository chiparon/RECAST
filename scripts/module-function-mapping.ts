import type { ProjectModule } from "@forexplore/contracts";
import Parser from "tree-sitter";
import { createDefaultLanguageRegistry } from "../services/code-indexer/src/language-registry.js";
import { indexTreeSitterFile } from "../services/code-indexer/src/tree-sitter-indexer.js";
import type {
  FunctionGroupVerificationFunction,
  VerificationFunction,
} from "../services/translation-verifier/src/types.js";

type ModuleApiSource = {
  sourceFiles?: readonly string[];
  coreApis?: readonly string[];
  /** Optional target/source text used to resolve APIs whose class name differs from the file stem. */
  fileContents?: Readonly<Record<string, string>>;
};

/** Discover concrete public callables from the current files, never the old skeleton API list. */
export function discoverExecutableFunctions(fileContents: Readonly<Record<string, string>>): VerificationFunction[] {
  const registry = createDefaultLanguageRegistry();
  const functions: VerificationFunction[] = [];
  for (const [path, content] of Object.entries(fileContents)) {
    const language = registry.resolvePath(path);
    if (!language || !content) continue;
    const index = indexTreeSitterFile({ content, relativePath: path, language });
    const parser = new Parser();
    parser.setLanguage(language.grammar as never);
    const tree = parser.parse((offset) => content.slice(offset, offset + 8192));
    for (const declaration of index.declarations) {
      if (!["method", "function"].includes(declaration.kind)) continue;
      if (/\b(?:private|protected|internal)\b/.test(declaration.signature) ||
        declaration.name.startsWith("_") && !declaration.isExported && !/\bpublic\b/.test(declaration.signature)) continue;
      const range = declaration.sourceRange;
      // Local/anonymous implementations are exercised through their public factory.
      if (index.declarations.some(owner => ["method", "function", "constructor"].includes(owner.kind) &&
        owner !== declaration && owner.sourceRange.startLine <= range.startLine &&
        owner.sourceRange.endLine >= range.endLine &&
        (owner.sourceRange.endLine > range.endLine || owner.sourceRange.endColumn >= range.endColumn) &&
        (owner.sourceRange.startLine < range.startLine || owner.sourceRange.startColumn < range.startColumn))) continue;
      let node: Parser.SyntaxNode | null = tree.rootNode.namedDescendantForPosition({ row: range.startLine - 1, column: range.startColumn - 1 });
      while (node && node.type !== declaration.declarationNodeType) node = node.parent;
      if (!node || !(node.childForFieldName("body") || node.namedChildren.some(child =>
        ["block", "statement_block", "function_body", "expression_body", "arrow_expression_clause"].includes(child.type)))) continue;
      const siblings = index.declarations.filter(item => item.kind === declaration.kind &&
        item.qualifiedName === declaration.qualifiedName);
      const parameters = node.childForFieldName("parameters")?.text;
      functions.push({ path, name: declaration.name,
        signature: declaration.qualifiedName + (siblings.length > 1 && parameters ? parameters : "") });
    }
  }
  return deduplicateFunctions(functions);
}

export type FunctionMappingDiagnostic = {
  targetApi: string;
  reason:
    | "no-source-api"
    | "ambiguous-source-api"
    | "ambiguous-target-api"
    | "source-file-ambiguous"
    | "target-file-ambiguous";
};

export type ModuleFunctionMapping = {
  functions: FunctionGroupVerificationFunction[];
  unmatchedFunctions: VerificationFunction[];
  /** Target declarations with no executable body (interfaces/enums/delegates). */
  nonExecutableFunctions: VerificationFunction[];
  diagnostics: FunctionMappingDiagnostic[];
};

/**
 * Some language indexers emit an exported class as a module's core API (for
 * example `TraceFactory`) while the coverage report can only attribute an
 * executed method (`TraceFactory.Start`). Expand those class-level subjects
 * using the target source before handing them to the verifier. Method-level
 * APIs without parameters also need expansion when the declaring class has
 * overloads: execution of one overload must not stand in for the others.
 */
export function expandClassLevelFunctions(
  functions: readonly VerificationFunction[],
  readSource: (path: string) => string | undefined,
): VerificationFunction[] {
  const expanded: VerificationFunction[] = [];
  for (const target of functions) {
    const source = readSource(target.path);
    const className = callableApiName(target.signature ?? target.name);
    const declaresType = source && new RegExp(`\\b(?:class|record|struct)\\s+${escapeRegExp(className)}\\b`).test(source);
    if (!declaresType) {
      // Indexers often store a fully-qualified symbol as the signature but
      // omit its parameter list (`Namespace.Type.Method`). Coverage reports
      // provide the real method signature; retaining the incomplete indexer
      // text would make an otherwise unique method look unmatched.
      const identity = (target.signature ?? target.name).split("(", 1)[0]!.trim();
      const owner = identity.split(/::|[.#]/).filter(Boolean).at(-2)?.trim().split(/\s+/).at(-1);
      const overloads = source && !target.signature?.includes("(") && owner
        ? publicMethodsOfClass(source, owner).filter(method => method.name === target.name)
        : [];
      if (overloads.length > 1) {
        for (const method of overloads) expanded.push({ ...target, signature: `${owner}.${method.name}(${method.parameters})` });
      } else expanded.push({ ...target });
      continue;
    }
    const methods = publicMethodsOfClass(source!, className);
    if (methods.length === 0) {
      expanded.push(target.signature && !target.signature.includes("(")
        ? { path: target.path, name: target.name }
        : { ...target });
      continue;
    }
    for (const method of methods) {
      expanded.push({
        path: target.path,
        name: method.name,
        // A unique method needs the declaring type, not an approximate source
        // parameter list. Keep parameters only to distinguish real overloads.
        signature: methods.filter(item => item.name === method.name).length > 1
          ? `${className}.${method.name}(${method.parameters})`
          : `${className}.${method.name}`,
      });
    }
  }
  return deduplicateFunctions(expanded);
}

type ParsedMethod = { name: string; parameters: string };

function publicMethodsOfClass(source: string, className: string): ParsedMethod[] {
  // Keep offsets while removing braces and declaration-like text in comments
  // and strings. Nested classes must not contribute methods to their owner.
  source = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|@"(?:""|[^"])*"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    value => value.replace(/[^\r\n]/g, " "));
  const declaration = new RegExp(`\\b(?:class|record|struct)\\s+${escapeRegExp(className)}\\b`);
  const match = declaration.exec(source);
  if (!match) return [];
  const open = source.indexOf("{", match.index + match[0].length);
  if (open < 0) return [];
  const terminator = source.indexOf(";", match.index + match[0].length);
  if (terminator >= 0 && terminator < open) return [];
  const close = matchingBrace(source, open);
  if (close < 0) return [];
  const body = source.slice(open + 1, close);
  const methodPattern = /\b(?:public|protected|internal)\s+(?:(?:static|virtual|override|abstract|async|sealed|partial|final)\s+)*(?:[\w.?<>\[\],]+\s+)+([A-Za-z_]\w*)\s*(?:<[^<>]+>)?\s*\(([^()]*)\)/g;
  const methods: ParsedMethod[] = [];
  let depth = 0;
  let scanned = 0;
  for (const item of body.matchAll(methodPattern)) {
    for (; scanned < item.index!; scanned += 1) {
      if (body[scanned] === "{") depth += 1;
      else if (body[scanned] === "}") depth -= 1;
    }
    if (depth !== 0) continue;
    const name = item[1];
    if (!name || name === className) continue;
    methods.push({ name, parameters: (item[2] ?? "").trim() });
  }
  return [...new Map(methods.map((method) => [`${method.name}(${method.parameters})`, method])).values()];
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deduplicateFunctions(functions: readonly VerificationFunction[]): VerificationFunction[] {
  return [...new Map(functions.map((item) => [`${item.path}\\0${item.name}\\0${item.signature ?? ""}`, item])).values()];
}

type ApiDescriptor = {
  raw: string;
  name: string;
  compareName: string;
  path?: string;
};

function normalizeCompareName(value: string): string {
  return value
    .replace(/[`"']/g, "")
    .replace(/\s+/g, "")
    .replace(/^~/, "")
    .toLocaleLowerCase();
}

/**
 * Core APIs are emitted by several indexers in slightly different forms:
 * `Class.Method`, `Class::Method(args)`, and `returnType Method(args)` are all
 * valid. Keep the original text as a signature, but compare the callable tail
 * after removing arguments, generic brackets, and a return type.
 */
export function callableApiName(value: string): string {
  let base = value.trim();
  const argumentStart = base.indexOf("(");
  if (argumentStart >= 0) base = base.slice(0, argumentStart);
  base = base.replace(/<[^<>]*>/g, "");
  const qualified = base.split(/::|[.#]/).filter(Boolean).at(-1) ?? base;
  const tokens = qualified.trim().split(/\s+/).filter(Boolean);
  return (tokens.at(-1) ?? qualified.trim()).replace(/[;,]+$/, "");
}

function qualifierTokens(value: string): string[] {
  let base = value.trim();
  const argumentStart = base.indexOf("(");
  if (argumentStart >= 0) base = base.slice(0, argumentStart);
  base = base.replace(/<[^<>]*>/g, "");
  const pieces = base.split(/::|[.#]/).filter(Boolean);
  const last = pieces.at(-1) ?? base;
  const tokens = last.trim().split(/\s+/).filter(Boolean);
  return [...pieces.slice(0, -1), ...tokens.slice(0, -1)]
    .map((token) => normalizeCompareName(token))
    .filter(Boolean);
}

function fileStem(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  return normalizeCompareName(name.replace(/\.[^.]+$/, ""));
}

/** Return a path only when the API-to-file association is unambiguous. */
function resolveApiPath(rawApi: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  if (files.length === 1) return files[0];
  const qualifiers = new Set(qualifierTokens(rawApi));
  const raw = normalizeCompareName(rawApi);
  const scored = files.map((path) => {
    const stem = fileStem(path);
    let score = 0;
    if (qualifiers.has(stem)) score = 3;
    else if ([...qualifiers].some((token) => token === stem || token.endsWith(stem) || stem.endsWith(token))) score = 2;
    else if (raw.includes(stem)) score = 1;
    return { path, score };
  }).sort((left, right) => right.score - left.score);
  if (scored[0]!.score === 0 || scored[0]!.score === scored[1]?.score) return undefined;
  return scored[0]!.path;
}

function resolveApiPathFromContents(
  rawApi: string,
  files: readonly string[],
  fileContents: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!fileContents || files.length === 0) return undefined;
  const callable = callableApiName(rawApi);
  const qualifiers = qualifierTokens(rawApi);
  // A class-level declaration such as `AssetKind` has no qualifier tokens;
  // use its callable tail as the declaration name so source contents can still
  // disambiguate it from the other files in the module.
  const types = [callable, qualifiers.at(-1)].filter((name): name is string => Boolean(name));
  const candidates = files.map((file) => {
    const source = fileContents[file];
    if (!source) return { file, score: 0 };
    let score = 0;
    if (types.some(name => new RegExp(`\\b(?:class|interface|record|struct|enum)\\s+${escapeRegExp(name)}\\b`, "i").test(source))) score += 4;
    if (callable && new RegExp(`\\b${escapeRegExp(callable)}\\s*\\(`, "i").test(source)) score += 1;
    return { file, score };
  }).sort((left, right) => right.score - left.score);
  if (!candidates[0] || candidates[0].score === 0 || candidates[0].score === candidates[1]?.score) return undefined;
  return candidates[0].file;
}

function resolveRelatedFile(targetPath: string | undefined, sourceFiles: readonly string[]): string | undefined {
  if (!targetPath || sourceFiles.length === 0) return undefined;
  const targetStem = fileStem(targetPath);
  const matches = sourceFiles.filter((path) => fileStem(path) === targetStem);
  return matches.length === 1 ? matches[0] : undefined;
}

function describeApis(source: ModuleApiSource): ApiDescriptor[] {
  return [...new Set((source.coreApis ?? []).map((value) => value.trim()).filter(Boolean))]
    .map((raw) => {
      const name = callableApiName(raw);
      return {
        raw,
        name,
        compareName: normalizeCompareName(name),
        path: resolveApiPathFromContents(raw, source.sourceFiles ?? [], source.fileContents) ?? resolveApiPath(raw, source.sourceFiles ?? []),
      };
    });
}

function asVerificationFunction(api: ApiDescriptor, fallbackPath: string | undefined): VerificationFunction {
  return {
    path: api.path ?? fallbackPath ?? "unknown",
    name: api.name,
    ...(api.raw !== api.name ? { signature: api.raw } : {}),
  };
}

/**
 * Coverage can only establish execution for a concrete body.  Interface
 * members, enum declarations, and delegates are still useful structural
 * evidence, but asking the verifier to execute them produces a guaranteed
 * `coverage-unavailable` result and hides the behavior of the concrete
 * implementations behind those contracts.
 */
function isNonExecutableTargetApi(
  api: ApiDescriptor,
  targetFileContents: Readonly<Record<string, string>> | undefined,
  fallbackPath?: string,
): boolean {
  const raw = api.raw.trim();
  if (/\b(?:interface|enum|delegate)\b/i.test(raw) && !/\w+\s*\(/.test(raw)) return true;
  if (!targetFileContents) return false;
  const source = targetFileContents[api.path ?? fallbackPath ?? ""];
  if (!source) return false;
  const beforeParameters = raw.split("(", 1)[0]!.trim();
  const pieces = beforeParameters.split(/::|\./).filter(Boolean);
  const callable = callableApiName(raw);
  const typeDeclaration = new RegExp(`\\b(interface|enum|delegate|class|record|struct)\\s+${escapeRegExp(callable)}\\b`).exec(source);
  if (typeDeclaration) {
    if (["interface", "enum", "delegate"].includes(typeDeclaration[1]!)) return true;
    // DTOs and positional records have no callable business API. Their shape
    // is checked by compilation and their consumers' behavioral tests.
    return publicMethodsOfClass(source, callable).length === 0;
  }
  const typeName = pieces.length > 1 ? pieces.at(-2) : callable;
  if (!typeName) return false;
  const typePattern = escapeRegExp(typeName);
  // A method whose declaring type is an interface has no executable body in
  // the target assembly. Enums and delegates are likewise declarations only.
  return new RegExp(`\\b(?:interface|enum|delegate)\\s+${typePattern}\\b`, "i").test(source);
}

/**
 * Build only mappings that can be justified by both API identity and file
 * ownership. Every target API that fails one of those checks is retained as an
 * unmatched target so the verifier cannot silently claim complete coverage.
 */
export function buildModuleFunctionMapping(
  targetModule: ProjectModule,
  sourceModule: ModuleApiSource | undefined,
  targetFileContents?: Readonly<Record<string, string>>,
  currentTargets?: readonly VerificationFunction[],
): ModuleFunctionMapping {
  // Parser-owned paths and concrete bodies are stronger evidence than indexer
  // API-to-file guesses, including default implementations on interfaces.
  const targetApis = currentTargets
    ? currentTargets.map(target => ({ raw: target.signature ?? target.name, name: target.name,
      compareName: normalizeCompareName(target.name), path: target.path }))
    : describeApis({ ...targetModule, fileContents: targetFileContents });
  const sourceApis = sourceModule ? describeApis(sourceModule) : [];
  const sourceByName = new Map<string, ApiDescriptor[]>();
  const targetByName = new Map<string, ApiDescriptor[]>();
  for (const api of sourceApis) sourceByName.set(api.compareName, [...(sourceByName.get(api.compareName) ?? []), api]);
  for (const api of targetApis) targetByName.set(api.compareName, [...(targetByName.get(api.compareName) ?? []), api]);

  const functions: FunctionGroupVerificationFunction[] = [];
  const unmatchedFunctions: VerificationFunction[] = [];
  const nonExecutableFunctions: VerificationFunction[] = [];
  const diagnostics: FunctionMappingDiagnostic[] = [];
  for (const targetApi of targetApis) {
    const sourceMatches = sourceByName.get(targetApi.compareName) ?? [];
    const targetMatches = targetByName.get(targetApi.compareName) ?? [];
    const targetFunction = asVerificationFunction(targetApi, targetModule.sourceFiles[0]);
    if (!currentTargets && isNonExecutableTargetApi(targetApi, targetFileContents, targetFunction.path)) {
      nonExecutableFunctions.push(targetFunction);
      continue;
    }
    if (sourceMatches.length === 0) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "no-source-api" });
      continue;
    }
    if (sourceMatches.length !== 1) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "ambiguous-source-api" });
      continue;
    }
    if (targetMatches.length !== 1) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "ambiguous-target-api" });
      continue;
    }
    const sourceApi = sourceMatches[0]!;
    const sourcePath = sourceApi.path ?? resolveRelatedFile(targetApi.path, sourceModule?.sourceFiles ?? []);
    if (!sourcePath) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "source-file-ambiguous" });
      continue;
    }
    if (!targetApi.path) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "target-file-ambiguous" });
      continue;
    }
    functions.push({
      source: { ...asVerificationFunction(sourceApi, sourceModule?.sourceFiles?.[0]), path: sourcePath },
      target: targetFunction,
    });
  }
  return { functions, unmatchedFunctions, nonExecutableFunctions, diagnostics };
}
