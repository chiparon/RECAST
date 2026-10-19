import { MAVEN_COVERAGE_GOALS } from "./test-runner.js";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestEnvironment } from "./test-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-environment-"));
  roots.push(root);
  return root;
}

describe("resolveTestEnvironment", () => {
  it("uses Maven test roots configured in pom.xml", async () => {
    const root = await project();
    await mkdir(join(root, "custom-tests/java"), { recursive: true });
    await mkdir(join(root, "custom-tests/resources"), { recursive: true });
    await writeFile(
      join(root, "pom.xml"),
      `<project><build><testSourceDirectory>custom-tests/java</testSourceDirectory><testResources><testResource><directory>custom-tests/resources</directory></testResource></testResources></build></project>`,
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).resolves.toEqual({
      framework: "maven",
      testRoots: ["custom-tests/java", "custom-tests/resources"],
      targetTest: { executable: "mvn", args: [...MAVEN_COVERAGE_GOALS] },
    });
  });

  it("creates and cleans the Maven default test root when a project has no tests", async () => {
    const root = await project();
    await writeFile(join(root, "pom.xml"), "<project />");
    const environment = await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "maven", testRoots: ["src/test/java"] });
    await expect(access(join(root, "src/test/java"))).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(join(root, "src/test/java"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("matches an isolated Maven harness to the compiled project's Java release", async () => {
    const root = await project();
    await mkdir(join(root, "target/classes"), { recursive: true });
    await writeFile(join(root, "pom.xml"), "<project><artifactId>demo</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>");
    const environment = await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root });
    const harnessPom = join(root, environment.targetTest.args[1]!);
    expect(await readFile(harnessPom, "utf8")).toContain("<maven.compiler.release>17</maven.compiler.release>");
    expect(await readFile(harnessPom, "utf8")).toContain("<outputDirectory>\${production.classes}</outputDirectory>");
    expect(await readFile(harnessPom, "utf8")).not.toContain("<classDirectories>");
    await environment.cleanup?.();
  });

  it("uses pytest testpaths from project configuration", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await mkdir(join(root, "integration-tests"), { recursive: true });
    await writeFile(
      join(root, "pytest.ini"),
      "[pytest]\ntestpaths = checks integration-tests\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "pytest",
      testRoots: ["checks", "integration-tests"],
      targetTest: { args: ["-m", "pytest"] },
    });
  });

  it("uses the Vitest root from vitest.config.ts", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.0.0" }, scripts: { test: "vitest run" } }),
    );
    await writeFile(
      join(root, "vitest.config.ts"),
      "export default { test: { root: 'checks' } }\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "TypeScript", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "vitest",
      testRoots: ["checks"],
      targetTest: { args: ["test", "--"] },
    });
  });

  it("creates and cleans a Node test root when Jest has no configured root", async () => {
    const root = await project();
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { jest: "^30.0.0" }, scripts: { test: "jest" } }));
    const environment = await resolveTestEnvironment({ targetLanguage: "JavaScript", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "jest", targetTest: { args: ["test", "--", "--runInBand"] } });
    expect(environment.testRoots[0]).toMatch(/^\.translation-verifier-tests\/.+\/tests$/);
    const generatedRoot = join(root, environment.testRoots[0]!);
    await expect(access(generatedRoot)).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(generatedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and cleans a Python tests root without pytest configuration", async () => {
    const root = await project();
    const environment = await resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "pytest", testRoots: ["tests"], targetTest: { args: ["-m", "pytest"] } });
    await expect(access(join(root, "tests"))).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(join(root, "tests"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds C# to one dedicated standard test project and ignores build artifacts", async () => {
    const root = await project();
    await mkdir(join(root, "tests/obj"), { recursive: true });
    await writeFile(join(root, "tests/PriceTests.csproj"), '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1"/></ItemGroup></Project>');
    await writeFile(join(root, "tests/obj/Noise.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root })).resolves.toEqual({ framework: "dotnet", testRoots: ["tests"], targetTest: { executable: "dotnet", args: ["test", "tests/PriceTests.csproj"] } });
    await mkdir(join(root, "other-tests"));
    await writeFile(join(root, "other-tests/Other.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "CSharp", targetProjectPath: root })).rejects.toThrow("exactly one");
  });

  it("requires a dedicated directory for a C# test project", async () => {
    const root = await project();
    await writeFile(join(root, "Tests.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root })).rejects.toThrow("dedicated test directory");
  });

  it("creates and cleans a disposable harness for a C# Console project", async () => {
    const root = await project();
    await writeFile(join(root, "Application.csproj"), '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>');
    const environment = await resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "dotnet", targetTest: { executable: "dotnet" } });
    const harnessProject = join(root, environment.targetTest.args[1]!);
    expect(environment.testRoots[0]).toMatch(/^\.translation-verifier-tests\/.+\/tests$/);
    await expect(access(harnessProject)).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(harnessProject)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a configured test root that does not exist", async () => {
    const root = await project();
    await writeFile(
      join(root, "pom.xml"),
      "<project><build><testSourceDirectory>missing-tests</testSourceDirectory></build></project>",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("test root does not exist: missing-tests");
  });

  it("rejects ambiguous Java build frameworks", async () => {
    const root = await project();
    await writeFile(join(root, "pom.xml"), "<project />");
    await writeFile(join(root, "build.gradle"), "plugins {}\n");

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("ambiguous Maven and Gradle configurations");
  });
});
