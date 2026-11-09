import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

export function python(args, input) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
        ["path", "systemroot", "windir", "temp", "tmp", "comspec", "pathext", "systemdrive"].includes(k.toLowerCase())));
    return execFileSync("python", ["-I", "-B", "-X", "utf8", ...args], {
        env, input, encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"],
    });
}

export function pyCheck(source) {
    python(["-c", 'import sys,os; sys.path.insert(0, os.getcwd())\n' + source]);
}

function browser() {
    return createContext({
        document: {
            addEventListener() {},
            createTextNode: (value) => ({ kind: "text", value: String(value) }),
            createElement: (name) => ({ kind: "element", name: name.toLowerCase() }),
        },
    });
}

export function click(browser, payload, labels) {
    const classes = new Set();
    const nodes = [{kind: "text", value: payload}];
    const span = {
        get textContent() { return nodes.map(node => node.value || "").join(""); },
        set textContent(value) {
            nodes.length = 0;
            if (value) nodes.push({kind: "text", value});
        },
        replaceChildren(...children) { nodes.splice(0, nodes.length, ...children); },
        classList: { contains: (cls) => classes.has(cls), add: (cls) => classes.add(cls) },
        appendChild(node) { nodes.push(node); },
        append(...newNodes) { nodes.push(...newNodes); },
    };
    const event = {target: {parentNode: {querySelector(selector) {
        assert.equal(selector, ".ctxs");
        return span;
    }}}};
    browser.event = event;
    const expand = () => runInContext("coverage.expand_contexts(event)", browser, {timeout: 1500});
    expand();
    assert.equal(span.textContent, labels.join(""));
    assert.ok(classes.has("expanded"));
    const expected = labels.flatMap((value) => [{kind: "text", value}, {kind: "element", name: "br"}]);
    assert.deepEqual(nodes, expected);
    const first = nodes.slice();
    expand();
    assert.equal(nodes.length, first.length);
    nodes.forEach((node, i) => assert.equal(node, first[i]));
}

export function viewerCheck() {
    const context = browser();
    context.coverage = {};
    context.contexts = {a: "checkout", b: "à la carte"};
    runInContext(readFileSync("coverage/htmlfiles/context_view.js", "utf8"), context);
    click(context, "1ba", ["à la carte", "checkout"]);
}

export function withReport(entries, show, check) {
    const directory = mkdtempSync(join(tmpdir(), "coverage-context-report-"));
    try {
        const page = JSON.parse(python(["bench-public/probe.py", directory], JSON.stringify({entries, show})));
        const context = browser();
        for (const script of page.scripts) {
            const source = script.src ? readFileSync(resolve(directory, "html", script.src), "utf8") : script.inline;
            runInContext(source, context, {timeout: 1500});
        }
        check(page, context);
    } finally {
        rmSync(directory, {force: true, recursive: true});
    }
}
