"""Public smoke checks. Run with the project's provided build/test tools."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace

import quickjs
from django.apps import apps
from django.conf import settings

settings.configure(SECRET_KEY="catalog-fixture", USE_I18N=False, LANGUAGE_CODE="de",
                   LOCALE_PATHS=[str(Path("django/contrib/admin/locale").resolve())])
apps.populate([])
from django.http import HttpRequest
from django.views.i18n import JavaScriptCatalog, JSONCatalog


def view_with(entries, fallback=None):
    view = JavaScriptCatalog()
    view.translation = SimpleNamespace(_catalog=entries, _fallback=fallback)
    return view


def browser(response):
    context = quickjs.Context()
    context.set_time_limit(2)
    context.eval("var window = globalThis;")
    context.eval(response.content.decode())
    return context


def render_client(catalog, plural=None):
    response = JavaScriptCatalog().render_to_response(
        {"catalog": catalog, "formats": {}, "plural": plural})
    return browser(response)


def request(view):
    req = HttpRequest()
    req.method = "GET"
    return view.as_view()(req)


def compile_sources():
    for source in Path("django").rglob("*.py"):
        ast.parse(source.read_bytes(), filename=str(source))
    render_client({"label": "translated"}, "n != 1")
    render_client({}, None)


def catalog_smoke():
    entries = {"": "Plural-Forms: nplurals=2; plural=n!=1;\n",
               "greeting": "Hallo", ("post", 0): "Beitrag", ("post", 1): "Beiträge"}
    view = view_with(entries)
    assert view.get_catalog() == {"greeting": "Hallo", "post": ["Beitrag", "Beiträge"]}
    assert view.get_plural() == "n!=1"


def browser_smoke():
    js = render_client({"cat": ["Katze", "Katzen"], "title\x04run": "Lauf"})
    assert js.eval("ngettext('cat', 'cats', 2)") == "Katzen"
    assert js.eval("pgettext('title', 'run')") == "Lauf"
    assert js.eval("npgettext('other', 'cat', 'cats', 1)") == "Katze"


def integration_smoke():
    payload = json.loads(request(JSONCatalog).content)
    assert payload["catalog"]["January"] == "Januar"
    js = browser(request(JavaScriptCatalog))
    assert js.eval("gettext('January')") == "Januar"
    assert js.eval("pgettext('abbrev. month March', 'Mar')") == "Mrz"


def run(mode):
    if mode == "compile":
        compile_sources()
    elif mode == "catalog":
        catalog_smoke()
    elif mode == "browser":
        browser_smoke()
    elif mode == "all":
        catalog_smoke()
        browser_smoke()
        integration_smoke()
    else:
        raise ValueError(mode)
