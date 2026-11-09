def attrs():
    from bench_checks.scenario import widget_attrs
    a = widget_attrs(required=True, extra={"class":"custom one","data-custom":"override"})
    assert a["class"].split()==["custom","one","admin-autocomplete"] and a["data-custom"]=="override"
    assert a["data-theme"]=="admin-autocomplete" and a["data-placeholder"]==""
    assert a["data-ajax--cache"]=="true" and a["data-ajax--type"]=="GET" and a["data-ajax--delay"]=="250"
    assert a["data-allow-clear"]=="false" and a["data-model-name"]=="permission"


def dynamic():
    from bench_checks.scenario import client, query
    ctx=client({"data-app-label":"one","data-model-name":"two","data-field-name":"three"})
    ctx.eval("""var row=element('row','div'), added=element('inline','select',row);
        added.className='admin-autocomplete';
        Object.assign(added.dataset,{appLabel:'alt',modelName:'related',fieldName:'relation'});
        row.dispatchEvent(new CustomEvent('formset:added',{bubbles:true}));""")
    assert query(ctx,"検索",2,"added")=={"term":"検索","page":2,"app_label":"alt","model_name":"related","field_name":"relation"}
    assert ctx.eval("const q=$(added);q.djangoAdminSelect2()===q && empty.selectConfig===undefined")
    assert query(ctx,"",1)["app_label"]=="one"


def pages():
    from bench_checks.scenario import client,query,response,widget_attrs,ContentType
    ctx=client(widget_attrs())
    first,second=(response(query(ctx,"needle",i)) for i in (1,2))
    assert len(first["results"])==20 and len(second["results"])==4
    assert first["pagination"]=={"more":True} and second["pagination"]=={"more":False}
    expected=[str(pk) for pk in ContentType.objects.filter(model__startswith="needle").order_by("pk").values_list("pk",flat=True)]
    assert [r["id"] for r in first["results"]+second["results"]]==expected


def empty_result():
    from bench_checks.scenario import client,query,response,widget_attrs
    attrs=widget_attrs(False,{"class":"manually-styled"})
    assert attrs["data-ajax--url"]=="/manage/autocomplete/"
    assert response(query(client(attrs),"不存在"))=={"results":[],"pagination":{"more":False}}


def permission():
    from bench_checks.scenario import client,query,response,widget_attrs
    from django.core.exceptions import PermissionDenied
    params=query(client(widget_attrs()),"needle03")
    assert len(response(params)["results"])==1
    try:
        response(params,False)
    except PermissionDenied:
        return
    raise AssertionError("Unauthorized autocomplete returned records")


CHECKS=[("widget-attributes",attrs),("dynamic-inline",dynamic),("relational-pagination",pages),
        ("empty-result",empty_result),("permission-boundary",permission)]
