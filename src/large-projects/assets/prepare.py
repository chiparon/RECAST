"""Export the immutable Django production package from canonical upstream blobs."""
import ast
import io
from pathlib import Path, PurePosixPath
import runpy
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
previous = runpy.run_path(str(HERE.parents[1] / "real-projects/case-one/prepare.py"))
SHA = previous["SHA"]
JS = "django/contrib/admin/static/admin/js/"
PY_MASKS = {
    "autocomplete": {"django/contrib/admin/widgets.py": (
        "AutocompleteMixin", ["build_attrs"]),
    },
    "prepopulate": {"django/contrib/admin/templatetags/admin_modify.py": (
        None, ["prepopulated_fields_js"]),
    },
    "password": {"django/contrib/auth/forms.py": (
        "SetUnusablePasswordMixin", ["validate_passwords", "validate_password_for_user", "set_password_and_save"]),
    },
}
JS_MASKS = {
    "autocomplete": ["autocomplete.js"], "prepopulate": ["prepopulate.js", "prepopulate_init.js"],
    "password": ["unusable_password_field.js"],
}


def keep(path):
    if path == "LICENSE":
        return True
    p = PurePosixPath(path)
    if not path.startswith("django/"):
        return False
    if "vendor" in p.parts:
        return (path.startswith(JS + "vendor/xregexp/") and p.name in {"xregexp.js", "LICENSE.txt"} or
                path.startswith(JS + "vendor/jquery/") and p.name in {"jquery.js", "LICENSE.txt"})
    if "locale" in p.parts and not (path in {"django/conf/locale/__init__.py", "django/conf/locale/en/__init__.py", "django/conf/locale/en/formats.py"}):
        return False
    if "project_template" in p.parts or "app_template" in p.parts:
        return False
    return p.suffix in {".py", ".js", ".html", ".css"}


def strip_python(body, class_name, methods):
    text = body.decode("utf8")
    lines = text.splitlines(keepends=True)
    parsed = ast.parse(text)
    scope = next(c for c in parsed.body if isinstance(c, ast.ClassDef) and c.name == class_name) if class_name else parsed
    replacements = [node for node in scope.body if isinstance(node, ast.FunctionDef) and node.name in methods]
    assert len(replacements) == len(methods)
    for node in reversed(replacements):
        first = node.body[0]
        start = first.lineno - 1
        lines[start:node.end_lineno] = [" " * first.col_offset + f'raise NotImplementedError("TODO: {node.name}")\n']
    return "".join(lines).encode("utf8")


def prepare(root, task, variant):
    if variant not in {"starter", "golden"} or task not in PY_MASKS:
        raise ValueError((task, variant))
    root.mkdir(parents=True, exist_ok=True)
    previous["WORK"].mkdir(exist_ok=True)
    repo = previous["ensure_source"]()
    previous["ensure_runtime"]()
    image = subprocess.check_output(["node", str(HERE / "image-tag.mjs")], encoding="utf8").strip()
    if subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run(["docker", "build", "--platform", "linux/amd64", "-t", image, str(HERE / "browser-runtime")], check=True)
    paths = [p for p in subprocess.check_output(["git", "-C", repo, "ls-tree", "-r", "--name-only", SHA],
                                                  encoding="utf8").splitlines() if keep(p)]
    batch = subprocess.check_output(["git", "-C", repo, "cat-file", "--batch"],
                                    input="".join(f"{SHA}:{p}\n" for p in paths).encode())
    stream = io.BytesIO(batch)
    for p in paths:
        _, kind, size = stream.readline().split()
        assert kind == b"blob", p
        data = stream.read(int(size))
        assert stream.read(1) == b"\n"
        if variant == "starter" and p in PY_MASKS[task]:
            data = strip_python(data, *PY_MASKS[task][p])
        elif variant == "starter" and p in {JS + n for n in JS_MASKS[task]}:
            data = b'"use strict";\n// TODO: implement this Django admin browser module.\n'
        destination = root / p
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    checks = root / "bench_checks"
    checks.mkdir()
    for source, target in (("common.py","common.py"), ("browser.js","browser.js"), (task+".py","scenario.py")):
        shutil.copyfile(HERE / source, checks / target)


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
