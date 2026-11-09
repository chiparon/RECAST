"""Generate and parse an actual coverage.py report for supplied line contexts."""
from html.parser import HTMLParser
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path.cwd()))
from coverage import Coverage


class SourcePage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.lines = {}
        self.script = None
        self.line = None
        self.in_context = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self.script = {"src": attrs.get("src"), "inline": ""}
            self.scripts.append(self.script)
        elif tag == "a" and attrs.get("id", "").startswith("t"):
            self.line = attrs["id"][1:]
        elif tag == "span" and attrs.get("class") == "ctxs":
            self.in_context = True
            self.lines[self.line] = ""

    def handle_endtag(self, tag):
        if tag == "script":
            self.script = None
        elif tag == "span":
            self.in_context = False
        elif tag == "p":
            self.line = None

    def handle_data(self, data):
        if self.script is not None:
            self.script["inline"] += data
        elif self.in_context:
            self.lines[self.line] += data


directory = Path(sys.argv[1])
source = directory / "specimen.py"
source.write_text("one = 1\ntwo = 2\nthree = 3\n", encoding="utf-8")
params = json.load(sys.stdin)
cov = Coverage(config_file=False, data_file=None, timid=True)
data = cov.get_data()
for name, lines in params["entries"]:
    data.set_context(name)
    data.add_lines({str(source): lines})
report = directory / "html"
cov.html_report(morfs=[str(source)], directory=str(report), show_contexts=params["show"])
page = SourcePage()
page.feed(next(report.glob("*specimen_py.html")).read_text(encoding="utf-8"))
print(json.dumps({"scripts": page.scripts, "lines": page.lines}))
