"""AdminPasswordChangeForm and native browser fallback smoke tests."""
import json
from bench_checks.common import browser, compile_sources, execute, initialize, js_value

initialize()
from django.contrib.auth.forms import AdminPasswordChangeForm
from django.contrib.auth.models import User
from django.db import connection


def user():
    account=User(username="worker")
    account.set_password("old-credential")
    return account


def native(data,account=None):
    return AdminPasswordChangeForm(account if account is not None else user(), data)


def page(radios,mode="legacy",optional=True,passwords=None):
    js=browser()
    passwords=passwords or ('<input id="id_password1">','<input id="id_password2">')
    html="<form>"+radios+"".join('<div class="form-row">'+w+"</div>" for w in passwords)
    if optional:
        html+='<p id="id_unusable_warning"></p><input type="submit" class="set-password"><input type="submit" class="unset-password">'
    js.eval("document.body.innerHTML="+json.dumps(html+"</form>"))
    if mode=="legacy":
        js.eval("""
            const nativeQuery=document.querySelector.bind(document);
            document.querySelector=selector=>{
                if(selector.includes(':has('))throw new DOMException('Unsupported selector','SyntaxError');
                return nativeQuery(selector);
            };
        """)
    execute(js,"unusable_password_field.js")
    return js


def native_page(form,mode="legacy",optional=True):
    return page(str(form["usable_password"]),mode,optional,tuple(str(form[k]) for k in ("password1","password2")))


def select(js,value):
    js.eval("""const selectedRadio=document.querySelector('input[name=usable_password][value=%s]');
        selectedRadio.checked=true;selectedRadio.dispatchEvent(new Event('change',{bubbles:true}));""".replace(
        "const selectedRadio","var selectedRadio") % json.dumps(value))


def visibility(js):
    return js_value(js,"""[
        document.getElementById('id_password1').closest('.form-row').hidden,
        document.getElementById('id_password2').closest('.form-row').hidden,
        document.getElementById('id_unusable_warning')?.hidden ?? null,
        document.querySelector('.set-password')?.hidden ?? null,
        document.querySelector('.unset-password')?.hidden ?? null
    ]""")


def form_smoke():
    form=native({"usable_password":"false","password1":"different","password2":"ignored"})
    assert form.is_valid(), form.errors
    account=form.save(commit=False)
    assert not account.has_usable_password() and account.pk is None


def browser_smoke():
    js=page('<input type="radio" name="usable_password" value="true" checked><input type="radio" name="usable_password" value="false">')
    assert visibility(js)==[False,False,True,False,True]
    select(js,"false")
    assert visibility(js)==[True,True,False,True,False]


def run(mode):
    if mode=="compile":
        compile_sources("django/contrib/auth/forms.py","unusable_password_field.js")
    elif mode=="form":
        form_smoke()
    elif mode=="browser":
        browser_smoke()
    elif mode=="all":
        form_smoke()
        browser_smoke()
        form=native({"usable_password":"false"})
        assert form.is_valid() and not form.save(commit=False).has_usable_password()
        assert visibility(native_page(form))==[True,True,False,True,False]
    else:
        raise ValueError(mode)
