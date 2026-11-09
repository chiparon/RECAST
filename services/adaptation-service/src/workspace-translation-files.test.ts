import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkspaceFiles } from "./workspace-translation-files";

vi.mock("node:fs", async (load) => {
  const fs = await load<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const rename = vi.mocked(renameSync);
const id = randomUUID();
let files: TranslationWorkspaceFiles;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "translation-journal-"));
  files = new TranslationWorkspaceFiles(root);
  rename.mockReset();
  files.save(id, { turn: 1 });
  rename.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function saveAs(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...original, value: platform });
    files.save(id, { turn: 2 });
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

it.each(["EPERM", "EBUSY"])("retries an interrupted Windows journal rename (%s) using the same snapshot", (code) => {
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  rename.mockImplementationOnce(() => {
    expect(files.load(id)).toEqual({ turn: 1 });
    throw Object.assign(new Error("temporarily locked"), { code });
  });
  saveAs("win32");
  expect(rename).toHaveBeenCalledTimes(2);
  expect(rename.mock.calls[0]).toEqual(rename.mock.calls[1]);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(files.load(id)).toEqual({ turn: 2 });
  expect(readdirSync(files.recordsRoot)).toEqual([`${id}.json`]);
});

it("preserves the previous journal when the Windows sharing lock persists", () => {
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  const locked = Object.assign(new Error("persistently locked"), { code: "EPERM" });
  rename.mockImplementation(() => { throw locked; });
  expect(() => saveAs("win32")).toThrow(locked);
  expect(rename).toHaveBeenCalledTimes(6);
  expect(rename.mock.calls.every(([src, dst]) => src === rename.mock.calls[0]![0] && dst === rename.mock.calls[0]![1])).toBe(true);
  expect(files.load(id)).toEqual({ turn: 1 });
  expect(readdirSync(files.recordsRoot)).toEqual([`${id}.json`]);
});

it.each([["win32", "EIO"], ["linux", "EPERM"]] as const)("propagates %s %s immediately", (platform, code) => {
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  const failure = Object.assign(new Error("rename failure"), { code });
  rename.mockImplementation(() => { throw failure; });
  expect(() => saveAs(platform)).toThrow(failure);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
  expect(files.load(id)).toEqual({ turn: 1 });
});
