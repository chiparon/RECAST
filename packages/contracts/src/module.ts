export type Language = 'TypeScript' | 'Python' | 'Java' | 'C#' | 'Rust' | 'Go' | 'C' | 'C++';

export type ModuleKind =
  | 'workspace'
  | 'folder'
  | 'file'
  | 'class'
  | 'record'
  | 'interface'
  | 'function';

export type ImplementationStatus = 'implemented' | 'unimplemented';

export interface ModuleNode {
  id: string;
  name: string;
  kind: ModuleKind;
  path: string;
  language?: Language;
  signature?: string;
  documentation?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
  children?: ModuleNode[];
}

export interface ModuleTarget {
  id: string;
  name: string;
  kind: 'class' | 'function' | 'module';
  path: string;
  language: Language;
  signature: string;
  documentation?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
  /** Current source text of the target file, read by the host for side-by-side review. */
  source?: string;
  /** Complete module boundary when the target is a reviewed project module. */
  module?: {
    repositoryId?: string;
    analysisRevision?: string;
    projectId?: string;
    /** Reviewed module identity and behavior summary; independent of user input. */
    moduleId?: string;
    purpose?: string;
    description?: string;
    /** Bounded declaration and referenced port/type names from this module's indexed files. */
    symbolNames?: string[];
    sourceFiles: string[];
    coreApis: string[];
    dependsOn: string[];
  };
}
