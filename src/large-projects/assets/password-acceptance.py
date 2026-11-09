def validation():
    from bench_checks.scenario import native
    for flag in ({},{"usable_password":"true"}):
        form=native(dict(flag,password1="",password2=""))
        assert not form.is_valid()
        errors=form.errors.as_data()
        assert [e.code for e in errors["password1"]]==["required"] and [e.code for e in errors["password2"]]==["required"]
        assert form.cleaned_data["set_usable_password"] and "usable_password" not in form.cleaned_data
    bad=native({"usable_password":"true","password1":"alpha","password2":"beta"})
    assert not bad.is_valid() and bad.errors.as_data()["password2"][0].code=="password_mismatch"
    from django.test import override_settings
    with override_settings(AUTH_PASSWORD_VALIDATORS=[{"NAME":"django.contrib.auth.password_validation.MinimumLengthValidator",
                                                     "OPTIONS":{"min_length":10}}]):
        short=native({"usable_password":"true","password1":"short","password2":"short"})
        assert not short.is_valid() and short.errors.as_data()["password2"][0].code=="password_too_short"
        off=native({"usable_password":"false","password1":"short","password2":"short"})
        assert off.is_valid()


def persistence():
    from bench_checks.scenario import user,native,User,connection
    if User._meta.db_table not in connection.introspection.table_names():
        with connection.schema_editor() as editor:
            editor.create_model(User)
    u=user()
    u.save()
    form=native({"usable_password":"false","password1":"ignored"},u)
    assert form.is_valid() and form.save(commit=True) is u
    u.refresh_from_db()
    assert not u.has_usable_password()
    on=native({"password1":"resumed","password2":"resumed"},u)
    assert on.is_valid() and on.save(commit=False).check_password("resumed")
    assert not User.objects.get(pk=u.pk).has_usable_password()
    on.save()
    u.refresh_from_db()
    assert u.check_password("resumed")


def legacy():
    from bench_checks.scenario import page,visibility,select
    radios='<input name="usable_password" type="radio" value="false" checked><input name="usable_password" type="radio" value="true">'
    js=page(radios,optional=False)
    assert visibility(js)==[True,True,None,None,None]
    select(js,"true")
    assert visibility(js)==[False,False,None,None,None]
    select(js,"false")
    assert visibility(js)==[True,True,None,None,None]


def modern():
    from bench_checks.scenario import page,visibility,select
    radios='<input name="usable_password" type="radio" value="true"><input name="usable_password" type="radio" value="false" checked>'
    js=page(radios,mode="modern")
    assert visibility(js)==[False,False,False,False,False]
    select(js,"true")
    assert visibility(js)==[False,False,False,False,False]


def roundtrip():
    from bench_checks.scenario import native,native_page,select,visibility,js_value
    view=native({"usable_password":"true","password1":"native-test","password2":"native-test"})
    assert view.is_valid()
    js=native_page(view)
    assert visibility(js)==[False,False,True,False,True]
    select(js,"false")
    assert visibility(js)==[True,True,False,True,False]
    submitted=js_value(js,"Object.fromEntries(new FormData(document.querySelector('form')))")
    form=native(submitted)
    assert form.is_valid() and not form.save(commit=False).has_usable_password()


CHECKS=[("enabled-validation",validation),("sqlite-password-persistence",persistence),("legacy-controls",legacy),
        ("native-css-branch",modern),("browser-form-roundtrip",roundtrip)]
