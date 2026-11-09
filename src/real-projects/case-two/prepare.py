"""Materialize the immutable upstream production tree with two withheld modules."""
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

assets = Path(__file__).resolve().parent
root, variant, url, commit = sys.argv[1:]
root = Path(root)
cache = assets.parents[2] / "work" / "real-projects" / "coveragepy-7.6.12"


def git(*args):
    return subprocess.check_output(["git", *args])


if variant not in {"golden", "starter"}:
    raise ValueError(variant)
if not cache.exists():
    cache.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache.parent) as temp:
        checkout = Path(temp) / "clone"
        git("clone", "--depth", "1", "--branch", "7.6.12", "--no-checkout", url, checkout)
        try:
            checkout.rename(cache)
        except OSError:
            if not cache.exists():  # Another concurrent initializer may have won.
                raise

if git("-C", cache, "rev-parse", "HEAD").decode().strip() != commit:
    raise ValueError(f"Wrong commit in {cache}")
paths = ["coverage", "LICENSE.txt", "NOTICE.txt", "README.rst", "pyproject.toml", "setup.py"]
with zipfile.ZipFile(io.BytesIO(git("-C", cache, "archive", "--format=zip", commit, "--", *paths))) as archive:
    archive.extractall(root)


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Upstream anchor does not match: {old[:80]}")
    return text.replace(old, new)


def replace_block(text, start, end, new):
    return replace(text, text[text.index(start):text.index(end, text.index(start))], new)


html_file = root / "coverage/html.py"
html = html_file.read_text(encoding="utf-8")
html = replace(html, "import collections\n", "")
html = replace(html, "from coverage.files import flat_rootname",
               "from coverage.files import flat_rootname\n"
               "from coverage.html_context import allocate_context_codes, serialize_contexts, encode_line")
html = replace(html, '        "coverage_html.js",', '        "coverage_html.js",\n        "context_view.js",')
html = replace_block(html, "        contexts = collections.Counter(", "        for ldata in file_data.lines:",
                     "        codes = allocate_context_codes((line.contexts for line in file_data.lines), encode_int)\n"
                     "        contexts_json = serialize_contexts(codes)\n\n")
html = replace_block(html, "            if ldata.context_list:", "            if ldata.short_annotations:",
                     "            ldata.context_str = encode_line(ldata.context_list, codes)\n\n")
html_file.write_text(html, encoding="utf-8", newline="\n")

static = root / "coverage/htmlfiles"
script_file = static / "coverage_html.js"
js = replace_block(script_file.read_text(encoding="utf-8"), "coverage.expand_contexts = function",
                   'document.addEventListener("DOMContentLoaded",', "")
script_file.write_text(js, encoding="utf-8", newline="\n")
template_file = static / "pyfile.html"
script_tag = '    <script src="{{ statics.coverage_html_js }}" defer></script>'
html = replace(template_file.read_text(encoding="utf-8"), script_tag,
               script_tag + '\n    <script src="{{ statics.context_view_js }}" defer></script>')
template_file.write_text(html, encoding="utf-8", newline="\n")

shutil.copyfile(assets / f"{variant}_encoder.py", root / "coverage/html_context.py")
shutil.copyfile(assets / f"{variant}_viewer.js", static / "context_view.js")
public = root / "bench-public"
public.mkdir()
for filename in ["check.mjs", "test-support.mjs", "probe.py"]:
    shutil.copyfile(assets / filename, public / filename)
