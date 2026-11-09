"""Private behavioral acceptance groups. The driver delivers this over stdin."""
from pathlib import Path
import json
from types import SimpleNamespace

# Failure to import a submitted module (including a syntax error) is a delivery
# failure. Docker launch errors and broken grader infrastructure stay visible.
import quickjs
try:
    from bench_checks.public import browser, render_client, request, view_with, JavaScriptCatalog, JSONCatalog
except (Exception, SystemExit) as error:
    import_failed = type(error).__name__ + ": " + str(error)
else:
    import_failed = None


def fallback():
    third = SimpleNamespace(_catalog={("boxes", 2): "many", "lowest": "c"}, _fallback=None)
    second = SimpleNamespace(_catalog={"label": "old", ("boxes", 0): "obsolete",
                                      ("boxes", 1): "two", "new": "new"}, _fallback=third)
    source = {"": "Content-Type: text/plain\nPlural-Forms: nplurals=3; plural=n==1?0:n==2?1:2;\n",
              "label": "active", ("boxes", 0): "one", ("sparse", 2): "some"}
    view = view_with(source, second)
    assert view.get_catalog() == {"label": "active", "new": "new", "lowest": "c",
                                  "boxes": ["one", "two", "many"], "sparse": ["", "", "some"]}
    assert view.get_plural() == "n==1?0:n==2?1:2"


def headers():
    view = view_with({("key", 1): "plural"})
    assert view.get_catalog() == {"key": ["", "plural"]}
    assert view.get_plural() is None
    assert view_with({"": "Plural-Forms: plural=n == 1 ? 0 : 1; nplurals=2;"}).get_plural() == "n == 1 ? 0 : 1"
    try:
        view_with({42: "unsupported"}).get_catalog()
    except TypeError:
        pass
    else:
        raise AssertionError("Unsupported catalog key accepted")


def context_plural():
    js = render_client({"work\x04person": ["eins", "zwei", "viele"], "person": ["a", "b", "c"],
                        "tea": "Tee", "verb\x04charge": "berechnen"},
                       "n === 1 ? 0 : n === 2 ? 1 : 2")
    assert js.eval("npgettext('work', 'person', 'people', 0)") == "viele"
    assert js.eval("npgettext('missing', 'person', 'people', 2)") == "b"
    assert js.eval("npgettext('missing', 'x', 'xs', 2)") == "xs"
    assert js.eval("ngettext('tea', 'teas', 10)") == "Tee"
    assert js.eval("ngettext('missing', 'absent', 1)") == "missing"
    assert js.eval("pgettext('verb', 'charge')") == "berechnen"
    assert js.eval("pgettext('noun', 'charge')") == "charge"


def browser_reload():
    js = render_client({"x": ["one", "many"], "book\x04x": ["private-one", "private-many"]})
    response = JavaScriptCatalog().render_to_response({"catalog": {"other": "weiter"},
                                                       "formats": {}, "plural": "n != 1"})
    js.eval(response.content.decode())
    assert js.eval("npgettext('book','x','xs',3)") == "private-many"
    assert js.eval("npgettext('other','unknown','unknowns',1)") == "unknown"
    assert js.eval("gettext('other')") == "weiter"


def admin_calendar():
    payload = json.loads(request(JSONCatalog).content)
    assert payload["catalog"]["abbrev. month March\x04Mar"] == "Mrz"
    assert payload["catalog"]["%s selected option not visible"][1] == "%s ausgewählte Optionen nicht sichtbar"
    response = request(JavaScriptCatalog)
    assert response["Content-Type"].startswith("text/javascript")
    js = browser(response)
    js.eval(Path("django/contrib/admin/static/admin/js/calendar.js").read_text())
    assert js.eval("CalendarNamespace.monthsOfYear[2]") == "März"
    assert js.eval("CalendarNamespace.monthsOfYearAbbrev[2]") == "Mrz"
    assert js.eval("CalendarNamespace.daysOfWeekInitial[0]") == "So"
    assert js.eval("ngettext('%s selected option not visible','ignored',5)") == payload["catalog"]["%s selected option not visible"][1]


def evaluate():
    checks = []
    for name, check in [("catalog-fallback", fallback), ("catalog-metadata", headers),
                        ("browser-context-plural", context_plural), ("browser-reload", browser_reload),
                        ("localized-admin-calendar", admin_calendar)]:
        if import_failed:
            checks.append({"id": name, "passed": False, "error": import_failed})
            continue
        try:
            check()
        except (Exception, SystemExit) as error:
            checks.append({"id": name, "passed": False, "error": type(error).__name__ + ": " + str(error)})
        else:
            checks.append({"id": name, "passed": True})
    return checks
