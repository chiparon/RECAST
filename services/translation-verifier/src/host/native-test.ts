import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeCmakeSettings, cmakeLiteral as quote } from '../../../../scripts/native-cmake.mjs';
import { counter, jsonReport, percent } from './coverage-reports.js';
import { assertTestPath, resolveSafePath, type ToolRuntimeContext } from './tools/common.js';
import type { TargetFunctionCoverage, VerificationFunction } from '../types.js';

/** Host owns build scripts and flags; the Agent can write only test sources. */
export async function prepareNativeTests(runtime: ToolRuntimeContext, testPaths: readonly string[], directory: string, portable = false): Promise<string[]> {
  const root = runtime.targetProjectPath;
  const settings = nativeCmakeSettings(root);
  const tests = testPaths.map(path => {
    assertTestPath(path, runtime.testRoots);
    if (!/\.(c|cc|cpp|cxx)$/i.test(path)) throw new Error(`Native tests require a standalone .c/.cpp/.cc/.cxx program: ${path}`);
    const absolute = resolveSafePath(root, path);
    return { path: portable ? `"\${CMAKE_CURRENT_LIST_DIR}/${relative(directory, absolute).replaceAll('\\', '/')}"` : quote(absolute), name: `recast_${createHash('sha256').update(path).digest('hex').slice(0, 16)}` };
  });
  const product = portable ? `"\${CMAKE_CURRENT_LIST_DIR}/${relative(directory, root).replaceAll('\\', '/')}"` : quote(root);
  const cmake = `cmake_minimum_required(VERSION 3.21)
project(RECASTVerifier LANGUAGES C CXX)
if(NOT CMAKE_C_COMPILER_ID STREQUAL "GNU" OR NOT CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  message(FATAL_ERROR "RECAST behavior coverage currently requires GCC/G++ and matching gcov; MSVC/Clang are not supported by this adapter.")
endif()
set(CMAKE_BUILD_TYPE Debug CACHE STRING "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_compile_options(--coverage -O0 -g -fno-inline)
add_link_options(--coverage)
enable_testing()
add_subdirectory(${product} product)
function(recast_libraries dir)
  get_property(targets DIRECTORY "\${dir}" PROPERTY BUILDSYSTEM_TARGETS)
  foreach(t IN LISTS targets)
    get_target_property(kind "\${t}" TYPE)
    if(kind MATCHES "^(STATIC_LIBRARY|SHARED_LIBRARY|INTERFACE_LIBRARY|OBJECT_LIBRARY)$")
      set_property(GLOBAL APPEND PROPERTY RECAST_LIBRARIES "\${t}")
    endif()
  endforeach()
  get_property(children DIRECTORY "\${dir}" PROPERTY SUBDIRECTORIES)
  foreach(child IN LISTS children)
    recast_libraries("\${child}")
  endforeach()
endfunction()
recast_libraries(${product})
get_property(libraries GLOBAL PROPERTY RECAST_LIBRARIES)
set(selected ${settings.testTargets.map(quote).join(' ')})
if(NOT selected)
  list(LENGTH libraries count)
  if(NOT count EQUAL 1)
    message(FATAL_ERROR "RECAST requires one linkable library or explicit testTargets in .recast-native.json. Found: \${libraries}")
  endif()
  set(selected \${libraries})
endif()
foreach(t IN LISTS selected)
  if(NOT TARGET "\${t}")
    message(FATAL_ERROR "Unknown RECAST testTargets library: \${t}")
  endif()
  get_target_property(kind "\${t}" TYPE)
  if(NOT kind MATCHES "^(STATIC_LIBRARY|SHARED_LIBRARY|INTERFACE_LIBRARY|OBJECT_LIBRARY)$")
    message(FATAL_ERROR "RECAST testTargets must be linkable libraries: \${t}")
  endif()
endforeach()
${tests.map(test => `add_executable(${test.name} ${test.path})
target_link_libraries(${test.name} PRIVATE \${selected})
target_compile_options(${test.name} PRIVATE -UNDEBUG)
set_property(TARGET ${test.name} PROPERTY BUILD_RPATH_USE_ORIGIN TRUE)
file(GENERATE OUTPUT "\${CMAKE_BINARY_DIR}/runtime-${test.name}-$<CONFIG>.txt" CONTENT "$<TARGET_FILE_DIR:${test.name}>\n$<JOIN:$<TARGET_RUNTIME_DLLS:${test.name}>,\n>")
add_test(NAME ${test.name} COMMAND ${test.name})`).join('\n')}
`;
  await writeFile(join(directory, 'CMakeLists.txt'), cmake);
  // Keep the runner self-contained so the extension's packaged CJS and direct
  // TypeScript entry points use exactly the same native execution path.
  const runner = `const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname, build = path.join(dir, 'build');
function run(command, args, silent=false) {
 const result = spawnSync(command, args, {cwd:dir, shell:false, windowsHide:true, encoding:'utf8', maxBuffer:16000000, timeout:120000});
 if (!silent) {process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');}
 if (result.error) throw result.error;
 return result;
}
try {
 const cmake = ${portable ? "process.env.CMAKE_COMMAND || 'cmake'" : JSON.stringify(settings.command)};
 const configureArgs = ${portable ? `(fs.existsSync(path.resolve(dir, '../../.recast-native.json')) ? JSON.parse(fs.readFileSync(path.resolve(dir, '../../.recast-native.json'), 'utf8')).configureArgs : []) || []` : JSON.stringify(settings.configureArgs)};
 ${portable ? `if(process.platform === 'win32' && !process.env.CMAKE_GENERATOR && run('gcc', ['--version'], true).status === 0) configureArgs.unshift('-G', 'MinGW Makefiles');` : ''}
 const configure = run(cmake, ['-S',dir,'-B',build,...configureArgs]);
 if(configure.status !== 0) process.exit(configure.status || 1);
 const compiled = run(cmake, ['--build',build,'--config','Debug','--parallel','4','--target',...${JSON.stringify(tests.map(test => test.name))}]);
 if(compiled.status !== 0) process.exit(compiled.status || 1);
 if(process.platform === 'win32') for(const name of ${JSON.stringify(tests.map(test => test.name))}) {
  const [destination,...dlls] = fs.readFileSync(path.join(build,'runtime-'+name+'-Debug.txt'),'utf8').split(/\\r?\\n/);
  for(const dll of dlls.filter(Boolean)) {
   const target = path.join(destination,path.basename(dll));
   if(path.resolve(dll).toLowerCase() !== path.resolve(target).toLowerCase()) fs.copyFileSync(dll,target);
  }
 }
 const ctest = path.join(path.dirname(cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest');
 const tested = run(cmake === 'cmake' ? 'ctest' : ctest, ['--test-dir',build,'-C','Debug','--output-on-failure','--output-junit',path.join(dir,'tests.xml'),'-R','^recast_']);
 const reports = [];
 function scan(directory) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
   const file = path.join(directory,entry.name);
   if(entry.isDirectory()) scan(file);
   else if(entry.isFile() && entry.name.endsWith('.gcno')) {
    const coverage = run(${portable ? "process.env.GCOV_COMMAND || 'gcov'" : JSON.stringify(process.env.GCOV_COMMAND?.trim() || 'gcov')}, ['--json-format','--stdout','--branch-probabilities','--branch-counts',file], true);
    if(coverage.status !== 0) throw new Error('gcov failed (use the version matching GCC): '+coverage.stderr);
    reports.push(JSON.parse(coverage.stdout));
   }
  }
 }
 scan(build);
 fs.writeFileSync(path.join(dir,'gcov.json'),JSON.stringify(reports));
 process.exitCode = tested.status === 0 ? 0 : 1;
} catch(error) {console.error(error.message); process.exitCode=1;}
`;
  const script = join(directory, 'run-native.cjs');
  await writeFile(script, runner);
  return [script];
}

/** Exact file + declaration matching; an ambiguous overload never gets a green result. */
export function parseGcovReports(json: string, root: string, subject: VerificationFunction): TargetFunctionCoverage {
  const reports = jsonReport(json);
  if (!Array.isArray(reports)) throw new Error('Invalid gcov report.');
  const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const requested = canonical(resolve(root, subject.path));
  const candidates: Array<{ fn: any; lines: any[] }> = [];
  for (const report of reports) for (const file of report.files ?? []) {
    if (canonical(resolve(report.current_working_directory || root, file.file)) !== requested) continue;
    for (const fn of file.functions ?? []) {
      const name = String(fn.demangled_name ?? fn.name).split('(')[0].replaceAll('::', '.');
      const qualified = subject.signature?.split('(')[0].replaceAll('::', '.');
      if (name.split('.').at(-1) !== subject.name || qualified?.includes('.') && name !== qualified) continue;
      if (subject.startLine !== undefined && fn.start_line !== subject.startLine) continue;
      candidates.push({ fn, lines: (file.lines ?? []).filter((line: any) => line.function_name === fn.name) });
    }
  }
  const identities = new Set(candidates.map(({ fn }) => `${fn.name}:${fn.start_line}`));
  if (identities.size !== 1) throw new Error(`Cannot uniquely locate C/C++ function ${subject.signature ?? subject.name} in gcov coverage (${identities.size} matches).`);
  const lines = new Map<number, number>(), branches = new Map<string, number>();
  let executed = false;
  for (const { fn, lines: entries } of candidates) {
    executed ||= counter(fn.execution_count) > 0;
    for (const line of entries) {
      lines.set(line.line_number, (lines.get(line.line_number) ?? 0) + counter(line.count));
      for (const [index, branch] of (line.branches ?? []).entries()) {
        const key = `${line.line_number}:${index}`;
        branches.set(key, (branches.get(key) ?? 0) + counter(branch.count));
      }
    }
  }
  return { name: subject.name, executed, lineCoverage: percent([...lines.values()]), branchCoverage: percent([...branches.values()]) };
}
