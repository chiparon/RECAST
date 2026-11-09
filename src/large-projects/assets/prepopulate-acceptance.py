def metadata():
    from types import SimpleNamespace as NS
    from bench_checks.scenario import SlugForm,definition,rendered
    main,new,old=SlugForm(),SlugForm(prefix="books-0"),SlugForm(prefix="books-1")
    rows=[[NS(original=None,prepopulated_fields=[definition(new,"short",("subtitle","title"))]),
           NS(original=object(),prepopulated_fields=[definition(old)])]]
    records=rendered([definition(main)],rows)
    assert [r["id"] for r in records]==["#id_slug","#id_books-0-short"]
    second=records[1]
    assert second["dependency_ids"]==["#id_books-0-subtitle","#id_books-0-title"]
    assert second["dependency_list"]==["subtitle","title"] and second["maxLength"]==50 and not second["allowUnicode"]
    assert rendered([],[])==[]


def plugin():
    from bench_checks.scenario import sample,environment
    js=environment([sample()],load_binding=False)
    assert js.eval("const names=['#id_title','#id_subtitle'];const target=$('#id_slug'); target.prepopulate(names,8,false)===target")
    js.eval("$('#id_subtitle').val('LOUD').trigger('focus');")
    assert js.eval("target.val()")=="loud"
    js.eval("$('#id_title').val('Crème').trigger('change');")
    assert js.eval("target.val()")=="creme-lo"
    js.eval("target.val('handwritten').trigger('change');$('#id_title').val('next').trigger('keyup');")
    assert js.eval("target.val()")=="handwritten"


def wire():
    from bench_checks.scenario import sample,environment,execute,js_value
    js=environment([sample()],False,False)
    js.eval("""const row=document.querySelector('.empty-form .form-row');row.classList.add('field-slug');
      const tab=document.createElement('tr');tab.className='empty-form form-row';document.body.appendChild(tab);
      const child=document.createElement('td');child.className='field-slug';tab.appendChild(child);
      $.fn.prepopulate=function(...args){this[0].settings=args;return this;};""")
    execute(js,"prepopulate_init.js")
    assert js_value(js,"$('#id_slug')[0].settings")==[["#id_title","#id_subtitle"],16,True]
    assert js.eval("row.classList.contains('prepopulated_field') && child.classList.contains('prepopulated_field')")


def rendered_inline():
    from types import SimpleNamespace as NS
    from bench_checks.scenario import SlugForm,definition,rendered,environment
    fields=rendered([definition(SlugForm())],[[NS(original=None,prepopulated_fields=[definition(SlugForm(prefix="item-0"))])]])
    js=environment(fields)
    js.eval("$('#id_item-0-title').val('Σχήμα');$('#id_item-0-subtitle').val('世界').trigger('change');")
    assert js.eval("$('#id_item-0-slug').val()")=="σχήμα-世界"
    assert js.eval("$('#id_slug').val()")=="" and js.eval("$('.field-slug.prepopulated_field').length")>=1


def existing():
    from bench_checks.scenario import SlugForm,definition,rendered,environment,execute
    js=environment(rendered([definition(SlugForm())]),True,False)
    js.eval("$('#id_slug').val('from-storage')")
    execute(js,"prepopulate_init.js")
    js.eval("$('#id_title').val('fresh').trigger('focus');")
    assert js.eval("$('#id_slug').val()")=="from-storage"


CHECKS=[("inline-metadata",metadata),("slug-events-and-overrides",plugin),("inline-registration",wire),
        ("rendered-inline-unicode",rendered_inline),("existing-slug",existing)]
