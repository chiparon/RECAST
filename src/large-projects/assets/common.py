"""Shared isolated Django and stateful JSDOM runtime for large-repository tasks."""
import ast
import json
from pathlib import Path
import subprocess
import weakref

from django.conf import settings

JS = Path("django/contrib/admin/static/admin/js")


def initialize():
    import django
    settings.configure(
        SECRET_KEY="benchmark-test", USE_I18N=False, USE_TZ=False, STATIC_URL="/assets/",
        ROOT_URLCONF="bench_checks.scenario", DEFAULT_AUTO_FIELD="django.db.models.AutoField",
        INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth", "django.contrib.sessions",
                        "django.contrib.messages", "django.contrib.admin.apps.SimpleAdminConfig"],
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},
        PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
        TEMPLATES=[{"BACKEND":"django.template.backends.django.DjangoTemplates", "APP_DIRS":True}],
    )
    django.setup()


def close_browser(proc):
    proc.stdin.close()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class browser:
    def __init__(self):
        self.proc = subprocess.Popen(["node","/opt/browser/bridge.cjs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True,encoding="utf8")
        weakref.finalize(self, close_browser, self.proc)

    def eval(self, source):
        self.proc.stdin.write(json.dumps(source)+"\n")
        self.proc.stdin.flush()
        line=self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Browser terminated without reply")
        response=json.loads(line)
        if not response["ok"]:
            raise RuntimeError(response["error"])
        return response["value"]


def execute(js, name):
    js.eval((JS / name).read_text())


def js_value(js, expression):
    return json.loads(js.eval("JSON.stringify(" + expression + ")"))


def compile_sources(py, *scripts):
    ast.parse(Path(py).read_bytes(), filename=py)
    js = browser()
    for script in scripts:
        js.eval("new Function(" + json.dumps((JS / script).read_text()) + ")")


def grade(source):
    import traceback
    scope = {}
    # Each external file defines check functions. Perform imports inside the
    # functions so a candidate import failure is scored in its relevant groups.
    exec(source, scope)
    result = []
    for name, check in scope["CHECKS"]:
        try:
            check()
            result.append({"id": name, "passed": True})
        except (Exception, SystemExit) as exc:
            result.append({"id": name, "passed": False, "error": traceback.format_exc()[-1400:]})
    return result
