import { execFileSync } from "node:child_process";
import { click, pyCheck, viewerCheck, withReport } from "./test-support.mjs";

const mode = process.argv[2] ?? "all";
if (!["compile", "encoder", "viewer", "all"].includes(mode)) throw Error("Unknown check: " + mode);
if (mode === "compile") {
    pyCheck("import ast,pathlib\nfor path in pathlib.Path('coverage').rglob('*.py'): ast.parse(path.read_bytes(), filename=str(path))");
    for (const name of ["coverage_html.js", "context_view.js"]) {
        execFileSync(process.execPath, ["--check", "coverage/htmlfiles/" + name], {windowsHide: true});
    }
}
if (mode === "encoder" || mode === "all") {
    pyCheck(`import json
from coverage.html import encode_int
from coverage.html_context import allocate_context_codes, serialize_contexts, encode_line
codes = allocate_context_codes([["first", "second"], ["second"]], encode_int)
assert codes == {"second": encode_int(0), "first": encode_int(1)}
assert json.loads(serialize_contexts(codes)) == {encode_int(0): "second", encode_int(1): "first"}
assert encode_line(["first", "second"], codes) == "1" + encode_int(1) + encode_int(0)
assert encode_line([], codes) == ""
`);
}
if (mode === "viewer" || mode === "all") viewerCheck();
if (mode === "all") {
    withReport([["alpha", [1, 2]], ["beta", [2, 3]]], true, (page, browser) => {
        click(browser, page.lines["1"], ["alpha"]);
        click(browser, page.lines["2"], ["alpha", "beta"]);
        click(browser, page.lines["3"], ["beta"]);
    });
}
