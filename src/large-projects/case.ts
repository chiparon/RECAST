import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Command, RealFixture } from "../real-projects/types.ts";

const execute = promisify(execFile);
const local = (name:string) => fileURLToPath(new URL("./assets/" + name, import.meta.url));
const js = "django/contrib/admin/static/admin/js/";
const upstream = {url:"https://github.com/django/django.git", commit:"c941d0deec0ea08a30670be0fac879f2372f071b"};

function fixture(task:string, title:string, requirement:string, modules:RealFixture["modules"], references:string[], count:number):RealFixture {
  const command = (mode:string):Command => ({executable:process.execPath,args:[local("driver.mjs"),task,mode],timeoutMs:75_000});
  return {
    id:"django-admin-"+task, title, upstream,modules,references,
    requirement:requirement + "\n" + modules.map(m=>m.path + " — " + m.description).join("\n") +
      "\nKeep the supplied Django public APIs compatible. Only the listed writable production modules are editable. bench_checks/scenario.py contains the public component and integration checks.",
    compile:command("compile"),test:command("all"),
    moduleTests:Object.fromEntries(modules.map(m=>[m.name,command(m.name)])),
    async prepare(root,variant) {
      await execute("python",[local("prepare.py"),root,task,variant],{timeout:360000,windowsHide:true});
    },
    async grade(root) {
      const {stdout}=await execute(process.execPath,command("external").args,{cwd:root,timeout:75000,windowsHide:true});
      const checks=JSON.parse(stdout);
      if(checks.length!==count) throw Error("Incomplete "+task+" external grade");
      return checks;
    },
    productionFiles:path=>path.startsWith("django/") && !path.includes("/vendor/") && !path.includes("/locale/") &&
      !path.includes("/migrations/") && /\.(py|js|html|css)$/.test(path),
  };
}
export const fixtures:RealFixture[]=[
  fixture("autocomplete","Relational autocomplete in Django admin",
    "Restore the complete admin relation-autocomplete handoff. The widget emits Select2 metadata. A browser query built from that metadata must reach the shipping permission-checked, paginated Django admin endpoint and return the requested relation's records.",
    [{name:"widget",path:"django/contrib/admin/widgets.py",language:"Python",description:
      "Restore AutocompleteMixin.build_attrs. Merge inherited base and extra attributes, preserve other classes and add admin-autocomplete. Emit the existing widget URL and the source app/model/field identities, a cached GET with 250 ms delay, the widget theme, empty placeholder, language, and a JSON boolean data-allow-clear reflecting whether the field is optional."},
     {name:"browser",path:js+"autocomplete.js",language:"JavaScript",dependsOn:["widget"],description:
      "Implement the djangoAdminSelect2 chainable jQuery plugin. Initialize each widget with a Select2 ajax.data callback returning term/page plus app_label, model_name and field_name from that element's data attributes. On DOM ready skip formset empty-template names containing __prefix__; initialize the widgets within newly added inline form rows on formset:added."}],
    ["django/contrib/admin/views/autocomplete.py","django/contrib/admin/sites.py","django/contrib/auth/models.py","django/forms/widgets.py",js+"inlines.js"],5),
  fixture("prepopulate","Slug prepopulation across Django admin forms and inlines",
    "Restore admin slug prepopulation from the server's form/inline dependencies through browser registration and edit events. The admin template, URLify and existing inline code consume the supplied interfaces.",
    [{name:"metadata",path:"django/contrib/admin/templatetags/admin_modify.py",language:"Python",description:
      "Restore prepopulated_fields_js(context). Collect primary admin-form definitions and new inline definitions (original is None) in order. Publish both the original definitions and JSON metadata for each target: CSS ID selector, field name, ordered dependency ID selectors and names, field maximum length (default 50) and allowUnicode (default false). Preserve other context entries."},
     {name:"plugin",path:js+"prepopulate.js",language:"JavaScript",description:
      "Implement the chainable jQuery prepopulate(dependencies, maxLength, allowUnicode) plugin. Wire initially empty targets to dependency keyup, change and focus, combine nonempty source values in dependency order and call URLify with the supplied constraints. Once a user changes a target, future dependency events must preserve it. Existing nonempty values must remain untouched."},
     {name:"binding",path:js+"prepopulate_init.js",language:"JavaScript",dependsOn:["metadata","plugin"],description:
      "Read prepopulatedFields from #django-admin-prepopulated-fields-constants. Mark matching empty tabular/stacked inline field rows with prepopulated_field; bind each target selector to its dependency names, CSS ID selectors, length and Unicode policy through the prepopulate plugin. This must work for multiple targets and prefixed inline IDs."}],
    ["django/contrib/admin/templates/admin/prepopulated_fields_js.html","django/contrib/admin/helpers.py",js+"urlify.js",js+"inlines.js"],5),
  fixture("password","Enable and disable password login through Django admin",
    "Restore the admin change-password form and its browser fallback. The radio option, password validation, persisted user password and visible controls must agree for both password-based and externally authenticated users.",
    [{name:"form",path:"django/contrib/auth/forms.py",language:"Python",description:
      "Restore SetUnusablePasswordMixin.validate_passwords, validate_password_for_user and set_password_and_save. Consume the configurable usable-password field; only the literal false string disables passwords. Record set_usable_password. In the enabled branch require both named credentials once, preserve existing field errors, delegate equality and user validation to the parent, and set/save through the parent. In the disabled branch skip password checks, call set_unusable_password, honor commit, and return the user."},
     {name:"browser",path:js+"unusable_password_field.js",language:"JavaScript",dependsOn:["form"],description:
      "Implement the admin JS fallback for browsers whose querySelector rejects :has(). If native :has works leave CSS in charge. Otherwise wire change listeners to the usable_password radios and synchronize immediately even when the unchecked radio dispatches the event. Hide both password rows when disabling credentials, toggle the optional warning and optional set/unset submit buttons, and preserve operation on a page without those optional controls."}],
    ["django/contrib/auth/models.py","django/contrib/auth/base_user.py","django/contrib/admin/static/admin/css/unusable_password_field.css",
     "django/contrib/admin/templates/admin/auth/user/change_password.html","django/contrib/auth/admin.py"],5),
];
