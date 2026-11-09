"""Export pinned Git blobs and provision an isolated Python + JavaScript runtime."""
import io
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
WORK = HERE.parents[2] / "work"
TAG = "5.2.4"
SHA = "c941d0deec0ea08a30670be0fac879f2372f071b"
UPSTREAM = "https://github.com/django/django.git"
IMAGE = "recast-bench-django:py312-qjs194-v1"
VIEW = "django/views/i18n.py"
TEMPLATE = "django/views/templates/i18n_catalog.js"


def ensure_runtime():
    if subprocess.run(["docker", "image", "inspect", IMAGE], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode == 0:
        return
    with TemporaryDirectory(dir=WORK) as context:
        wheels = Path(context)
        shutil.copy(HERE / "requirements.txt", wheels)
        subprocess.run([sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
                        "--only-binary=:all:", "--platform", "manylinux2014_x86_64",
                        "--implementation", "cp", "--python-version", "312", "--abi", "cp312",
                        "--require-hashes", "-r", str(wheels / "requirements.txt"),
                        "--dest", context], check=True)
        subprocess.run(["docker", "build", "--platform", "linux/amd64", "--tag", IMAGE,
                        "--file", str(HERE / "Dockerfile"), context], check=True)


def ensure_source():
    source = WORK / ("django-" + TAG)
    if not source.exists():
        with TemporaryDirectory(dir=WORK) as staging:
            clone = Path(staging) / "clone"
            subprocess.run(["git", "clone", "--branch", TAG, "--depth=1", "--single-branch",
                            UPSTREAM, str(clone)], check=True)
            try:
                clone.rename(source)
            except OSError:
                if not source.is_dir():
                    raise
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip()
    if head != SHA:
        raise RuntimeError(f"Expected Django {SHA}, found {head}")
    return source


def mask(path, source):
    if path == VIEW:
        for name in ("get_catalog", "get_plural"):
            pattern = rf"(?ms)^(    def {name}\(self\):\n).*?(?=^    def )"
            source, count = re.subn(pattern, rf'\1        raise NotImplementedError("TODO: {name}")\n\n', source)
            assert count == 1, (path, name, count)
    if path == TEMPLATE:
        for name in ("ngettext", "pgettext", "npgettext"):
            pattern = rf"(?ms)^(    django\.{name} = function\([^)]*\) \{{\n).*?(?=^    \}};)"
            source, count = re.subn(pattern, rf"\1      throw new Error('TODO: {name}');\n", source)
            assert count == 1, (path, name, count)
    return source


def prepare(root, variant):
    WORK.mkdir(exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    source = ensure_source()
    ensure_runtime()
    paths = (HERE / "upstream-files.txt").read_text().splitlines()
    paths += ["LICENSE", TEMPLATE, "django/contrib/admin/static/admin/js/calendar.js",
              "django/contrib/admin/static/admin/js/core.js", "django/conf/locale/de/formats.py",
              "django/conf/locale/de/__init__.py", "django/contrib/admin/locale/de/LC_MESSAGES/djangojs.mo"]
    query = "".join(f"{SHA}:{p}\n" for p in paths).encode("utf-8")
    blobs = io.BytesIO(subprocess.check_output(["git", "-C", str(source), "cat-file", "--batch"],
                                                input=query))
    for path in paths:
        oid, kind, size = blobs.readline().split()
        assert kind == b"blob", (oid, path)
        data = blobs.read(int(size))
        assert blobs.read(1) == b"\n"
        if variant == "starter" and path in (VIEW, TEMPLATE):
            data = mask(path, data.decode("utf-8")).encode("utf-8")
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    checks = root / "bench_checks"
    checks.mkdir()
    (checks / "public.py").write_bytes((HERE / "public.py").read_text("utf-8").encode())


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), sys.argv[2])
