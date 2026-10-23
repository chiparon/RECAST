import { MAVEN_COVERAGE_GOALS } from "./test-runner.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeCmakeSettings } from '../../../../scripts/native-cmake.mjs';
import { access, chmod, mkdir, readFile, realpath, rm, rmdir, stat, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { VerificationInput } from "../types.js";
import {
  relativePath,
  type TargetTest,
  type TestRunner,
} from "./tools/common.js";

export type TestFramework = TestRunner;

export type TestEnvironment = {
  framework: TestFramework;
  testRoots: readonly string[];
  targetTest: TargetTest;
  cleanup?: () => Promise<void>;
};

async function removeGeneratedTree(root: string): Promise<void> {
  try {
    await chmod(root, 0o755);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) await removeGeneratedTree(child);
      else await chmod(child, 0o644);
    }
  } catch {
    // Best effort permission repair; the removal below still runs if a child
    // has already disappeared or cannot be chmod'ed.
  }
  try { await rm(root, { recursive: true, force: true }); } catch {
    // Test artifacts are disposable; a cleanup failure must not change the
    // Host-observed test result or mask the verifier's terminal response.
  }
}

type EphemeralDirectory = {
  relativePath: string;
  cleanup: () => Promise<void>;
};

/** Create a Host-owned test root without changing the product project permanently. */
async function createEphemeralDirectory(projectRoot: string, relativeDirectory: string): Promise<EphemeralDirectory> {
  const absolute = resolve(projectRoot, relativeDirectory);
  const outside = relative(projectRoot, absolute);
  if (outside === ".." || outside.startsWith(`..${sep}`) || absolute === projectRoot) {
    throw new Error(`Ephemeral test root escapes the target project: ${relativeDirectory}`);
  }
  const missing: string[] = [];
  let cursor = absolute;
  while (!(await directoryExists(cursor))) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Could not create ephemeral test root: ${relativeDirectory}`);
    cursor = parent;
  }
  await mkdir(absolute, { recursive: true });
  return {
    relativePath: relative(projectRoot, absolute).replaceAll(sep, "/"),
    cleanup: async () => {
      await removeGeneratedTree(absolute);
      for (const directory of missing.slice(1)) {
        try { await rmdir(directory); } catch { break; }
      }
    },
  };
}

type ProjectConfig = {
  root: string;
  entries: readonly string[];
};

/**
 * Resolve the target project's framework-owned test directories and runner.
 * The returned paths are project-relative and have already been checked on disk.
 */
export async function resolveTestEnvironment(
  input: Pick<VerificationInput, "targetLanguage" | "targetProjectPath">,
  retainedDirectory?: string,
): Promise<TestEnvironment> {
  const root = await existingDirectory(input.targetProjectPath, "target project");
  const language = normalizeLanguage(input.targetLanguage);

  switch (language) {
    case "java":
      return resolveJavaEnvironment(root, retainedDirectory);
    case "javascript":
      return resolveNodeEnvironment(root, retainedDirectory);
    case "csharp":
      return resolveDotnetEnvironment(root, retainedDirectory);
    case "python":
      return resolvePythonEnvironment(root);
    case "native": {
      if (!(await fileExists(join(root, 'CMakeLists.txt')))) throw new Error('C/C++ behavior verification requires a CMakeLists.txt project with a linkable library target.');
      const settings = nativeCmakeSettings(root);
      for (const executable of [settings.command, process.env.GCOV_COMMAND?.trim() || 'gcov']) {
        try { await promisify(execFile)(executable, ['--version'], { windowsHide: true, timeout: 5_000 }); }
        catch { throw new Error(`C/C++ verification tool is unavailable: ${executable}. Install CMake 3.21+, GCC/G++ and matching gcov on the extension platform; check PATH/CMAKE_COMMAND/GCOV_COMMAND.`); }
      }
      const generated = await createEphemeralDirectory(root, `${retainedDirectory ?? `.translation-verifier-tests/${randomUUID()}`}/tests`);
      return { framework: 'cmake', testRoots: [generated.relativePath], targetTest: { executable: process.execPath, args: [] }, cleanup: generated.cleanup };
    }
    default:
      throw new Error(
        `Unsupported target language for test environment resolution: ${input.targetLanguage}`,
      );
  }
}

async function resolveJavaEnvironment(root: string, retainedDirectory?: string): Promise<TestEnvironment> {
  const pom = join(root, "pom.xml");
  const gradle = join(root, "build.gradle");
  const gradleKotlin = join(root, "build.gradle.kts");
  const candidates = [
    ...(await fileExists(pom) ? [{ framework: "maven" as const, config: pom }] : []),
    ...(await fileExists(gradle)
      ? [{ framework: "gradle" as const, config: gradle }]
      : []),
    ...(await fileExists(gradleKotlin)
      ? [{ framework: "gradle" as const, config: gradleKotlin }]
      : []),
  ];
  if (candidates.length === 0) {
    throw new Error("Could not find a Maven or Gradle configuration for the Java target project.");
  }
  if (candidates.length > 1 && candidates.some((candidate) => candidate.framework !== candidates[0]?.framework)) {
    throw new Error("Java target project has ambiguous Maven and Gradle configurations.");
  }

  const candidate = candidates[0];
  const config = await readText(candidate.config);
  let roots = candidate.framework === "maven"
    ? mavenTestRoots(config)
    : gradleTestRoots(config);
  const hasConfiguredSourceRoot = candidate.framework === "maven"
    ? mavenTestSourceRoots(config).length > 0
    : gradleTestSourceRoots(config).length > 0;
  let cleanup: (() => Promise<void>) | undefined;
  let targetTest: TargetTest;
  if (candidate.framework === "maven" && !hasConfiguredSourceRoot && !(await directoryExists(join(root, "src/test/java")))) {
    // A production Maven skeleton frequently has no JUnit dependency and its
    // target/ directory may be owned by a Docker build. Use a disposable
    // Host-owned test project with JUnit/Surefire/JaCoCo instead of writing
    // dependencies or reports into the product project.
    // A resolver unit test or a freshly created skeleton may not have been
    // compiled yet. In that case there is no production classpath for a
    // temporary harness to reference; preserve the ordinary Maven test root
    // and let the normal compile gate establish the classpath first. Once
    // target/classes or a production jar exists, use the isolated harness.
    const compiledOutput = await mavenCompiledOutput(root, config);
    if (compiledOutput) {
      const harness = await createMavenHarness(root, config, compiledOutput, retainedDirectory);
      roots = [harness.testsRelative];
      targetTest = harness.targetTest;
      cleanup = harness.cleanup;
    } else {
      const generated = await createEphemeralDirectory(root, "src/test/java");
      roots = [generated.relativePath];
      targetTest = { executable: await wrapperOrCommand(root, "mvnw"), args: [...MAVEN_COVERAGE_GOALS] };
      cleanup = generated.cleanup;
    }
  } else {
    targetTest = {
      executable: await wrapperOrCommand(root, candidate.framework === "maven" ? "mvnw" : "gradlew"),
      args: candidate.framework === "maven" ? [...MAVEN_COVERAGE_GOALS] : ["test"],
    };
  }
  const testRoots = await validateTestRoots(root, roots, candidate.framework);
  return {
    framework: candidate.framework,
    testRoots,
    targetTest,
    ...(cleanup ? { cleanup } : {}),
  };
}

async function mavenCompiledOutput(root: string, pom: string): Promise<{ jar?: string; classes?: string } | undefined> {
  const target = join(root, "target");
  const classes = await directoryExists(join(target, "classes"));
  const artifactId = (pom.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i)?.[1] ?? "").trim();
  const jars = (await readdir(target).catch(() => [] as string[]))
    .filter(name => name.endsWith(".jar") && !name.endsWith("-sources.jar") && !name.endsWith("-javadoc.jar"));
  const jarName = jars.find(name => artifactId && name.startsWith(`${artifactId}-`)) ?? jars[0];
  if (!jarName && !classes) return undefined;
  return { ...(jarName ? { jar: join(target, jarName) } : {}), ...(classes ? { classes: join(target, "classes") } : {}) };
}

async function createMavenHarness(root: string, productionPom: string, compiled: { jar?: string; classes?: string }, retainedDirectory?: string): Promise<{
  testsRelative: string;
  targetTest: TargetTest;
  cleanup: () => Promise<void>;
}> {
  const artifactId = (productionPom.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i)?.[1] ?? "target-project").trim();
  const version = (productionPom.match(/<version>\s*([^<]+)\s*<\/version>/i)?.[1] ?? "0.0.0").trim();
  const release = (productionPom.match(/<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/i)?.[1] ??
    productionPom.match(/<release>\s*([^<]+)\s*<\/release>/i)?.[1] ?? "21").trim();
  const harnessRelative = retainedDirectory ?? `.translation-verifier-tests/${randomUUID()}`;
  const harnessRoot = join(root, harnessRelative);
  const testsRelative = `${harnessRelative}/tests`;
  const pomRelative = `${harnessRelative}/pom.xml`;
  const fromHarness = (file: string) => `\${project.basedir}/${relative(harnessRoot, file).replaceAll(sep, "/")}`;
  const productionJar = compiled.jar ? fromHarness(compiled.jar) : undefined;
  const productionClasses = fromHarness(compiled.classes ?? join(root, "target", "classes"));
  const productionSources = fromHarness(join(root, "src", "main", "java"));
  await mkdir(join(harnessRoot, "tests"), { recursive: true });
  await writeFile(join(harnessRoot, "pom.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>forexplore.verifier</groupId><artifactId>translation-verifier-harness</artifactId><version>1.0.0</version>
  <properties><maven.compiler.release>${release}</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <production.classes>${productionClasses}</production.classes><production.sources>${productionSources}</production.sources>
  </properties>
  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version></dependency>
    ${productionJar ? `<dependency><groupId>target.production</groupId><artifactId>${artifactId}</artifactId><version>${version}</version><scope>system</scope><systemPath>${productionJar}</systemPath></dependency>` : ""}
  </dependencies>
  <build>
    <!-- JaCoCo report reads the Maven project's outputDirectory, not classDirectories. -->
    <outputDirectory>\${production.classes}</outputDirectory>
    <testSourceDirectory>\${project.basedir}/tests</testSourceDirectory>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.0</version><configuration><useModulePath>false</useModulePath><reportsDirectory>\${surefire.reportsDirectory}</reportsDirectory></configuration></plugin>
      <plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>0.8.13</version><configuration><destFile>\${jacoco.dataFile}</destFile><dataFile>\${jacoco.dataFile}</dataFile><outputDirectory>\${jacoco.outputDirectory}</outputDirectory></configuration></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version><configuration><release>\${maven.compiler.release}</release>${productionJar ? "" : "<additionalClasspathElements><additionalClasspathElement>\${production.classes}</additionalClasspathElement></additionalClasspathElements>"}</configuration></plugin>
    </plugins>
  </build>
</project>
`, "utf8");
  return {
    testsRelative,
    targetTest: {
      executable: await wrapperOrCommand(root, "mvnw"),
      args: ["-f", pomRelative, ...MAVEN_COVERAGE_GOALS],
    },
    cleanup: async () => {
      await removeGeneratedTree(harnessRoot);
      try { await rmdir(join(root, ".translation-verifier-tests")); } catch { /* sibling harnesses may remain */ }
    },
  };
}

async function resolveDotnetEnvironment(root: string, retainedDirectory?: string): Promise<TestEnvironment> {
  const entries = await readdir(root, { recursive: true });
  const projects: string[] = [];
  for (const name of entries) {
    const path = name.replaceAll("\\", "/");
    // Harnesses created by the Host live under .translation-verifier-tests.
    // They are disposable test environments, never user test projects. If a
    // previous Agent run was interrupted before cleanup, do not rediscover
    // that stale project and bind every later verifier attempt to it.
    if (!path.endsWith(".csproj") || path.split("/").some(part => ["obj", "bin", ".git", ".translation-verifier-tests", ".recast-tests"].includes(part))) continue;
    const text = await readText(join(root, path));
    if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text) || /Include=["']Microsoft\.NET\.Test\.Sdk["']/i.test(text)) projects.push(path);
  }
  if (projects.length > 1) throw new Error("C# target project must contain exactly one standard dotnet test project.");
  if (projects.length === 1) {
    const project = projects[0]!;
    const directory = project.includes("/") ? project.slice(0, project.lastIndexOf("/")) : "";
    if (!directory) throw new Error("C# test project must be in a dedicated test directory.");
    return { framework: "dotnet", testRoots: await validateTestRoots(root, [directory], "dotnet"), targetTest: { executable: "dotnet", args: ["test", project] } };
  }

  // Enterprise skeletons commonly keep all tests outside the target project so
  // hidden evaluators cannot be inspected by the Agent. Create a disposable
  // Host-owned xUnit harness in that case instead of making the product project
  // carry a test dependency or requiring the user to edit the skeleton.
  const productionProjects = entries
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".csproj") && !name.split("/").some((part) => ["obj", "bin", ".git", ".translation-verifier-tests", ".recast-tests"].includes(part)));
  if (productionProjects.length !== 1) throw new Error("C# target project must contain one production project when no test project is present.");
  const productionProject = productionProjects[0]!;
  const productionAbsolute = join(root, productionProject);
  const productionText = await readText(productionAbsolute);
  const targetFramework = productionText.match(/<TargetFramework(?:s)?[^>]*>\s*([^<]+)\s*<\/TargetFramework(?:s)?>/i)?.[1]?.trim() ?? "net8.0";
  const harnessRelative = retainedDirectory ?? `.translation-verifier-tests/${randomUUID()}`;
  const harnessRoot = join(root, harnessRelative);
  const harnessParent = join(root, ".translation-verifier-tests");
  const testsRelative = `${harnessRelative}/tests`;
  const projectRelative = `${harnessRelative}/AgentTests.csproj`;
  const reference = relative(harnessRoot, productionAbsolute).replaceAll(sep, "/");
  await mkdir(join(harnessRoot, "tests"), { recursive: true });
  await writeFile(join(harnessRoot, "AgentTests.csproj"), `<Project Sdk="Microsoft.NET.Sdk">\n` +
    `  <PropertyGroup>\n` +
    `    <TargetFramework>${targetFramework}</TargetFramework>\n` +
    `    <IsTestProject>true</IsTestProject>\n` +
    `    <IsPackable>false</IsPackable>\n` +
    `    <Nullable>enable</Nullable>\n` +
    `    <ImplicitUsings>enable</ImplicitUsings>\n` +
    `  </PropertyGroup>\n` +
    `  <ItemGroup>\n` +
    `    <ProjectReference Include="${reference}" />\n` +
    `    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n` +
    `    <PackageReference Include="xunit" Version="2.9.2" />\n` +
    `    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference>\n` +
    `    <PackageReference Include="coverlet.collector" Version="6.0.2"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference>\n` +
    `  </ItemGroup>\n` +
    `</Project>\n`, "utf8");
  return {
    framework: "dotnet",
    testRoots: [testsRelative],
    targetTest: { executable: "dotnet", args: ["test", projectRelative] },
    cleanup: async () => {
      await removeGeneratedTree(harnessRoot);
      try { await rmdir(harnessParent); } catch {
        // Another verifier run may still own a sibling harness.
      }
    },
  };
}

async function resolvePythonEnvironment(root: string): Promise<TestEnvironment> {
  const configFiles = ["pytest.ini", "pyproject.toml", "setup.cfg"];
  const configs: ProjectConfig[] = [];
  for (const name of configFiles) {
    const path = join(root, name);
    if (await fileExists(path)) configs.push({ root: path, entries: [await readText(path)] });
  }
  const config = configs.find(({ root: path, entries }) =>
    path.endsWith("pytest.ini")
      ? /^\s*\[pytest\]/m.test(entries[0] ?? "")
      : path.endsWith("setup.cfg")
        ? /^\s*\[tool:pytest\]/m.test(entries[0] ?? "")
        : /\[tool\.pytest\.ini_options\]/.test(entries[0] ?? ""),
  );
  const configuredRoots = config ? parsePythonTestPaths(config.entries[0] ?? "") : [];
  let roots = configuredRoots.length > 0 ? configuredRoots : ["tests"];
  let cleanup: (() => Promise<void>) | undefined;
  if (configuredRoots.length === 0 && !(await directoryExists(join(root, roots[0]!)))) {
    const generated = await createEphemeralDirectory(root, roots[0]!);
    roots = [generated.relativePath, ...roots.slice(1)];
    cleanup = generated.cleanup;
  }
  const testRoots = await validateTestRoots(root, roots, "pytest");
  return {
    framework: "pytest",
    testRoots,
    targetTest: {
      executable: await fileExists(join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"))
        ? join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")
      : process.platform === "win32" ? "python.exe" : "python3",
      args: ["-m", "pytest"],
    },
    ...(cleanup ? { cleanup } : {}),
  };
}

async function resolveNodeEnvironment(root: string, retainedDirectory?: string): Promise<TestEnvironment> {
  const packagePath = join(root, "package.json");
  if (!(await fileExists(packagePath))) {
    throw new Error("Could not find package.json for the JavaScript or TypeScript target project.");
  }
  const packageJson = parseJson(await readText(packagePath), "package.json") as Record<string, unknown>;
  const dependencies = {
    ...asStringRecord(packageJson.dependencies),
    ...asStringRecord(packageJson.devDependencies),
    ...asStringRecord(packageJson.peerDependencies),
  };
  const script = asStringRecord(packageJson.scripts).test ?? "";
  const hasJest = "jest" in dependencies || /\bjest\b/.test(script) || await anyFileExists(root, ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json"]);
  const hasVitest = "vitest" in dependencies || /\bvitest\b/.test(script) || await anyFileExists(root, ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"]);
  if (hasJest === hasVitest) {
    throw new Error("Could not uniquely identify Jest or Vitest for the Node target project.");
  }

  const framework: TestFramework = hasJest ? "jest" : "vitest";
  let roots = await nodeTestRoots(root, framework, packageJson);
  let cleanup: (() => Promise<void>) | undefined;
  if (roots.length === 0) {
    const generated = await createEphemeralDirectory(root, `${retainedDirectory ?? `.translation-verifier-tests/${randomUUID()}`}/tests`);
    roots = [generated.relativePath];
    cleanup = generated.cleanup;
  }
  return {
    framework,
    testRoots: await validateTestRoots(root, roots, framework),
    targetTest: {
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
      args: framework === "jest" ? ["test", "--", "--runInBand"] : ["test", "--"],
    },
    ...(cleanup ? { cleanup } : {}),
  };
}

function mavenTestRoots(xml: string): string[] {
  const roots = [
    ...allTagValues(xml, "testSourceDirectory"),
    ...allTagValues(xml, "testResourceDirectory"),
    ...allNestedTagValues(xml, "testResource", "directory"),
  ];
  return unique(roots.length > 0 ? roots : ["src/test/java"]);
}

function mavenTestSourceRoots(xml: string): string[] {
  return allTagValues(xml, "testSourceDirectory");
}

function gradleTestRoots(script: string): string[] {
  const roots = [
    ...allCallValues(script, "java.srcDirs"),
    ...allCallValues(script, "resources.srcDirs"),
  ];
  return unique(roots.length > 0 ? roots : ["src/test/java"]);
}

function gradleTestSourceRoots(script: string): string[] {
  return allCallValues(script, "java.srcDirs");
}

function parsePythonTestPaths(config: string): string[] {
  const match = config.match(/^\s*testpaths\s*=\s*(.+)$/m);
  if (!match?.[1]) return [];
  const value = match[1].trim();
  const array = value.match(/^\[(.*)\]$/s);
  if (array) return [...array[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string);
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

async function nodeTestRoots(
  root: string,
  framework: "jest" | "vitest",
  packageJson: Record<string, unknown>,
): Promise<string[]> {
  if (framework === "jest") {
    const jest = packageJson.jest;
    if (typeof jest === "object" && jest !== null && !Array.isArray(jest)) {
      const roots = (jest as Record<string, unknown>).roots;
      if (Array.isArray(roots) && roots.every((value) => typeof value === "string")) return roots as string[];
    }
    const configPath = await firstExistingFile(root, ["jest.config.json", "jest.config.js", "jest.config.cjs", "jest.config.mjs"]);
    if (configPath) {
      const config = await readText(configPath);
      const roots = stringArrayProperty(config, "roots");
      if (roots.length > 0) return roots;
    }
  } else {
    const configPath = await firstExistingFile(root, ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"]);
    if (configPath) {
      const config = await readText(configPath);
      const root = stringProperty(config, "root");
      if (root) return [root];
      const include = stringArrayProperty(config, "include");
      const derived = include.map((pattern) => pattern.split("/").slice(0, -1).join("/")).filter(Boolean);
      if (derived.length > 0) return unique(derived);
    }
  }
  return [];
}

async function validateTestRoots(
  projectRoot: string,
  roots: readonly string[],
  framework: string,
): Promise<string[]> {
  if (roots.length === 0) throw new Error(`No test roots were configured for ${framework}.`);
  const result: string[] = [];
  for (const root of unique(roots)) {
    const safeRoot = normalizeConfiguredRoot(root, framework);
    const absolute = resolve(projectRoot, safeRoot);
    const outside = relative(projectRoot, absolute);
    if (outside === ".." || outside.startsWith(`..${sep}`) || absolute === projectRoot) {
      throw new Error(`Configured ${framework} test root escapes the target project: ${root}`);
    }
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) throw new Error(`Configured ${framework} test root is not a directory: ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Configured ${framework} test root does not exist: ${root}`);
      }
      throw error;
    }
    result.push(safeRoot);
  }
  return result;
}

function normalizeConfiguredRoot(value: string, framework: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\$\{project\.basedir\}\/?/, "");
  normalized = normalized.replace(/^\$rootDir\/?/, "");
  normalized = normalized.replace(/^<rootDir>\/?/, "");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid ${framework} test root: ${value}`);
  }
  return relativePath(normalized, `${framework} test root`);
}

function allTagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\s*>([^<]+)</${tag}>`, "g"))].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function allNestedTagValues(xml: string, parent: string, child: string): string[] {
  return [...xml.matchAll(new RegExp(`<${parent}\\b[^>]*>[\\s\\S]*?<${child}\\s*>([^<]+)</${child}>[\\s\\S]*?</${parent}>`, "g"))].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function allCallValues(script: string, call: string): string[] {
  const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...script.matchAll(new RegExp(`${escaped}\\s*(?:\\(|\\s+)([^)\\n]+)\\)?`, "g"))]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string));
}

function stringArrayProperty(value: string, property: string): string[] {
  const match = value.match(new RegExp(`\\b${property}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  return match ? [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string) : [];
}

function stringProperty(value: string, property: string): string | undefined {
  return value.match(new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`))?.[1];
}

async function existingDirectory(path: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  return canonical;
}

async function wrapperOrCommand(root: string, wrapper: string): Promise<string> {
  const wrapperPath = join(root, wrapper);
  if (await fileExists(wrapperPath)) return `./${wrapper}`;
  return wrapper === "mvnw" ? "mvn" : "gradle";
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function anyFileExists(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) if (await fileExists(join(root, name))) return true;
  return false;
}

async function firstExistingFile(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const path = join(root, name);
    if (await fileExists(path)) return path;
  }
  return undefined;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in ${name}.`);
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizeLanguage(value: string): "java" | "javascript" | "python" | "csharp" | "native" | "unsupported" {
  const language = value.trim().toLowerCase();
  if (['c', 'c++', 'cpp', 'cxx'].includes(language)) return 'native';
  if (["c#", "csharp", "cs", "c-sharp"].includes(language)) return "csharp";
  if (language === "java") return "java";
  if (["javascript", "typescript", "node", "node.js", "js", "ts"].includes(language)) return "javascript";
  if (["python", "python3", "py"].includes(language)) return "python";
  return "unsupported";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
