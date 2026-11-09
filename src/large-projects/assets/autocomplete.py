"""Public Django admin autocomplete checks and reusable browser/HTTP fixtures."""
import json
from html.parser import HTMLParser
from types import SimpleNamespace
from bench_checks.common import browser, compile_sources, execute, initialize, js_value

initialize()
from django import forms
from django.contrib.admin import AdminSite, ModelAdmin
from django.contrib.admin.widgets import AutocompleteSelect
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.db import connection
from django.test import RequestFactory
from django.urls import path


class ContentSearch(ModelAdmin):
    search_fields = ["model"]
    ordering = ["pk"]


site = AdminSite("library")
site.register(ContentType, ContentSearch)
urlpatterns = [path("manage/", site.urls)]


class ExtractSelect(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag == "select":
            self.attrs = dict(attrs)


def records():
    if ContentType._meta.db_table not in connection.introspection.table_names():
        with connection.schema_editor() as editor:
            editor.create_model(ContentType)
        for name in ["needle%02d" % i for i in range(24)] + ["other"]:
            ContentType.objects.create(app_label="bench", model=name)


def widget_attrs(required=False, extra=None):
    records()
    source = Permission._meta.get_field("content_type")
    widget = AutocompleteSelect(source, site, attrs={"class":"keep", "data-custom":"base"})
    field = forms.ModelChoiceField(queryset=ContentType.objects.all(), widget=widget, required=required)
    parser = ExtractSelect()
    parser.feed(field.widget.render("content_type", None, attrs=extra))
    return parser.attrs


def client(attrs):
    labels = {key: attrs.get("data-" + name) for key,name in
              (("appLabel","app-label"),("modelName","model-name"),("fieldName","field-name"))}
    ctx = browser()
    ctx.eval("""
      var live=element('id_content_type','select'), empty=element('id_forms-__prefix__-content_type','select');
      live.name='content_type';empty.name='forms-__prefix__-content_type';
      live.className=empty.className='admin-autocomplete';
    """)
    ctx.eval("Object.assign(live.dataset," + json.dumps(labels) + ")")
    execute(ctx, "autocomplete.js")
    return ctx


def query(ctx, term, page=1, node="live"):
    return js_value(ctx, node+".selectConfig.ajax.data(" + json.dumps({"term":term,"page":page}) + ")")


def response(params, allow=True):
    records()
    request = RequestFactory().get("/manage/autocomplete/", params)
    request.user = SimpleNamespace(has_perm=lambda *args:allow)
    return json.loads(site.autocomplete_view(request).content)


def widget_smoke():
    attrs = widget_attrs()
    assert attrs["class"].split() == ["keep", "admin-autocomplete"]
    assert attrs["data-app-label"] == "auth" and attrs["data-field-name"] == "content_type"
    assert attrs["data-ajax--url"] == "/manage/autocomplete/" and attrs["data-allow-clear"] == "true"


def browser_smoke():
    ctx = client({"data-app-label":"sample","data-model-name":"book","data-field-name":"author"})
    assert query(ctx,"a") == {"term":"a","page":1,"app_label":"sample","model_name":"book","field_name":"author"}
    assert ctx.eval("empty.selectConfig === undefined")


def run(mode):
    if mode == "compile":
        compile_sources("django/contrib/admin/widgets.py","autocomplete.js")
    elif mode == "widget":
        widget_smoke()
    elif mode == "browser":
        browser_smoke()
    elif mode == "all":
        widget_smoke()
        browser_smoke()
        data = response(query(client(widget_attrs()),"needle01"))
        assert len(data["results"]) == 1 and data["pagination"] == {"more":False}
    else:
        raise ValueError(mode)
