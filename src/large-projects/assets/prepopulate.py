"""Public slug-prepopulation checks using the real admin template and jQuery."""
import json
from html.parser import HTMLParser
from types import SimpleNamespace
from bench_checks.common import browser, compile_sources, execute, initialize, js_value

initialize()
from django import forms
from django.contrib.admin.templatetags.admin_modify import prepopulated_fields_js
from django.template import Context
from django.template.loader import render_to_string


class SlugForm(forms.Form):
    title=forms.CharField()
    subtitle=forms.CharField()
    slug=forms.SlugField(max_length=16,allow_unicode=True)
    short=forms.CharField()


def definition(form,target="slug",deps=("title","subtitle")):
    return {"field":form[target],"dependencies":[form[key] for key in deps]}


def rendered(definitions, inlines=()):
    class Constants(HTMLParser):
        fields=None
        def handle_starttag(self,tag,attrs):
            attrs=dict(attrs)
            if tag=="script" and attrs.get("id")=="django-admin-prepopulated-fields-constants":
                self.fields=json.loads(attrs["data-prepopulated-fields"])
    ctx=Context({"adminform":SimpleNamespace(prepopulated_fields=definitions),"inline_admin_formsets":inlines})
    result=prepopulated_fields_js(ctx)
    parser=Constants()
    parser.feed(render_to_string("admin/prepopulated_fields_js.html",result.flatten()))
    assert parser.fields is not None
    return parser.fields


def environment(fields,load_plugin=True,load_binding=True):
    js=browser()
    js.eval("var metadata="+json.dumps(fields,ensure_ascii=True))
    js.eval("""
      const constants=element('django-admin-prepopulated-fields-constants','script');
      constants.setAttribute('data-prepopulated-fields',JSON.stringify(metadata));
      const inline=element('inline','div');inline.className='empty-form';
      for(const f of metadata){
        const row=document.createElement('div'); row.className='form-row'; inline.appendChild(row);
        const cell=document.createElement('div');cell.className='field-'+f.name;row.appendChild(cell);
        if(!document.querySelector(f.id))element(f.id.slice(1),'input',cell);
        for(const id of f.dependency_ids)if(!document.querySelector(id))element(id.slice(1));
      }
    """)
    execute(js,"vendor/xregexp/xregexp.js")
    execute(js,"urlify.js")
    if load_plugin:
        execute(js,"prepopulate.js")
    if load_binding:
        execute(js,"prepopulate_init.js")
    return js


def sample():
    return {"id":"#id_slug","name":"slug","dependency_ids":["#id_title","#id_subtitle"],
            "dependency_list":["title","subtitle"],"maxLength":16,"allowUnicode":True}


def metadata_smoke():
    assert rendered([definition(SlugForm())])==[sample()]


def plugin_smoke():
    js=environment([sample()],load_binding=False)
    js.eval("$('#id_slug').prepopulate(['#id_title','#id_subtitle'],10,false);$('#id_title').val('Hello').trigger('keyup');")
    assert js.eval("$('#id_slug').val()")=="hello"


def binding_smoke():
    js=environment([sample()],load_plugin=False,load_binding=False)
    js.eval("$.fn.prepopulate=function(ids,max,unicode){this[0].bound=[ids,max,unicode];return this;};")
    execute(js,"prepopulate_init.js")
    assert js_value(js,"$('#id_slug')[0].bound")==[["#id_title","#id_subtitle"],16,True]
    assert js_value(js,"$('#id_slug').data('dependency_list')")==["title","subtitle"]


def run(mode):
    if mode=="compile":
        compile_sources("django/contrib/admin/templatetags/admin_modify.py","prepopulate.js","prepopulate_init.js")
    elif mode=="metadata":
        metadata_smoke()
    elif mode=="plugin":
        plugin_smoke()
    elif mode=="binding":
        binding_smoke()
    elif mode=="all":
        metadata_smoke()
        plugin_smoke()
        binding_smoke()
        js=environment(rendered([definition(SlugForm())]))
        js.eval("$('#id_title').val('Hello');$('#id_subtitle').val('世界').trigger('change');")
        assert js.eval("$('#id_slug').val()")=="hello-世界"
    else:
        raise ValueError(mode)
