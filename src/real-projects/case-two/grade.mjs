import assert from "node:assert/strict";
import { click, pyCheck, withReport } from "./test-support.mjs";

const mode = process.argv[2];
if (mode === "rank-and-pack") {
    pyCheck(`from coverage.html_context import allocate_context_codes, encode_line
entries = (iter(line) for line in [["tail", "hot", "β"], ["hot", "hot"], ["β", "gamma"]])
codes = allocate_context_codes(entries, lambda i: ["x", "YY", "z", "FFF"][i])
assert codes == {"hot":"x", "β":"YY", "tail":"z", "gamma":"FFF"}
assert encode_line(["gamma", "hot", "tail", "β", "hot"], codes) == "3FFFx  z  YY x  "
assert encode_line([], {}) == ""
`);
} else if (mode === "inline-data") {
    pyCheck(`import json
from coverage.html_context import serialize_contexts
value = "Δ</ScRiPt><i>&" + chr(34) + chr(39) + chr(92)
encoded = serialize_contexts({value:"c", "another":"aa"})
assert "</script" not in encoded.lower()
assert json.loads(encoded) == {"c":value, "aa":"another"}
assert serialize_contexts({}) is None
`);
} else if (mode === "wide-context-report") {
    const names = Array.from({length: 129}, (_, i) => "group" + String(i).padStart(3, "0"));
    const hazard = "</sCrIpT><b>Ж🚀&";
    const entries = [...names.map((name, i) => [name, i % 2 ? [1, 2] : [1]]), [hazard, [3]]];
    withReport(entries, true, (page, browser) => {
        assert.equal(page.lines["1"][0], "2");
        click(browser, page.lines["1"], names);
        click(browser, page.lines["2"], names.filter((_, i) => i % 2));
        click(browser, page.lines["3"], [hazard]);
    });
} else if (mode === "plain-report") {
    withReport([["alpha", [1, 3]]], false, (page, browser) => {
        assert.deepEqual(page.lines, {});
        assert.equal(browser.contexts, undefined);
        assert.equal(typeof browser.coverage.pyfile_ready, "function");
    });
} else {
    throw Error("Unknown grade mode");
}
