import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Check, Command, RealFixture } from "./types.ts";

const exec = promisify(execFile);
const local = (path: string) => fileURLToPath(new URL("./case-one/" + path, import.meta.url));
const view = "django/views/i18n.py";
const template = "django/views/templates/i18n_catalog.js";
const run = (mode: string): Command => ({
  executable: process.execPath, args: [local("driver.mjs"), mode], timeoutMs: 60_000,
});
const requirements = {
  catalog: "Implement JavaScriptCatalog.get_catalog and get_plural for the existing JSON and JavaScript views. Walk Django's GNU translation fallback chain, with nearer entries taking precedence independently per key and plural index. Omit the empty metadata key, accept string translations and (message, index) plural keys, and raise TypeError for unsupported keys. Plural lists have the length declared by the primary catalog (default 2), with empty strings for missing slots. Return the plural expression from the plural= clause of the primary catalog's Plural-Forms header, or None when the header is absent. Preserve IDs including gettext's context separator.",
  browser: "Implement ngettext, pgettext and npgettext in the browser library emitted by the Django template. ngettext looks up the singular key, uses the active pluralidx for arrays, returns scalar translations unchanged, and uses the source singular for count 1 and source plural otherwise on a miss. For context, compose context + EOT (U+0004) + message for lookup. pgettext returns the original msgid on a contextual miss. npgettext uses contextual singular/plural IDs first and delegates to plain ngettext on a miss. Preserve exports and repeated catalog loading.",
};
export const fixture: RealFixture = {
  id: "django-i18n", title: "Django internationalization catalog delivery",
  upstream: { url: "https://github.com/django/django.git", commit: "c941d0deec0ea08a30670be0fac879f2372f071b" },
  requirement: "Restore Django's server-to-browser translation catalog feature in this pinned Django source tree. " +
    "The JSON catalog and the generated JavaScript library must agree, including when used by the Django admin calendar with a German .mo locale. " +
    "Only edit the TODO bodies in " + view + " and " + template + ". " +
    requirements.catalog + " " + requirements.browser +
    " See bench_checks/public.py for runnable examples. Public commands run inside the supplied Python/QuickJS environment.",
  modules: [
    {name: "catalog", path: view, language: "Python", description: requirements.catalog},
    {name: "browser", path: template, language: "JavaScript", description: requirements.browser, dependsOn: ["catalog"]},
  ],
  references: ["django/utils/translation/trans_real.py", "django/utils/translation/__init__.py",
    "django/utils/formats.py", "django/contrib/admin/static/admin/js/calendar.js", "bench_checks/public.py"],
  compile: run("compile"), test: run("all"),
  moduleTests: { catalog: run("catalog"), browser: run("browser") },
  async prepare(root, variant) {
    await exec("python", [local("prepare.py"), root, variant], { timeout: 360_000, windowsHide: true });
  },
  async grade(root) {
    const { stdout } = await exec(process.execPath, run("external").args, {
      cwd: root, timeout: 60_000, windowsHide: true,
    });
    const checks: Check[] = JSON.parse(stdout);
    if (checks.length !== 5) throw Error("Incomplete Django external grade");
    return checks;
  },
  productionFiles: (path) => path.startsWith("django/") && /\.(py|js)$/.test(path),
};
