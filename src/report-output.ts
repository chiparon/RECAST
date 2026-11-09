import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const layerMarker = "<!-- recast-index-build -->";

/** Keep the independently measured layer when either report is regenerated. */
export async function writeReportPart(
  part: "development" | "index",
  markdown: string,
  root = "results",
) {
  const path = join(root, "report.md");
  const previous = await readFile(path, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return "";
  });
  const boundary = previous.indexOf(layerMarker);
  const priorDevelopment = (
    boundary < 0 ? previous : previous.slice(0, boundary)
  ).trimEnd();
  const priorIndex =
    boundary < 0 ? "" : previous.slice(boundary + layerMarker.length).trim();
  const development =
    part === "development"
      ? markdown.trimEnd()
      : priorDevelopment || "# RECAST 基准实测";
  const index = part === "index" ? markdown.trim() : priorIndex;
  const report =
    development + (index ? "\n\n" + layerMarker + "\n\n" + index : "") + "\n";
  const require = createRequire(resolve("../weichai/package.json"));
  let html = require("markdown-it")({ html: true }).render(report);
  const scaleImage = 'src="index-query-scale.png"';
  if (html.includes(scaleImage)) {
    const png = await readFile(join(root, "index-query-scale.png"));
    html = html.replaceAll(
      scaleImage,
      'src="data:image/png;base64,' + png.toString("base64") + '"',
    );
  }
  const styles =
    "body{max-width:1120px;margin:36px auto;padding:0 24px;font:16px/1.6 system-ui,sans-serif;color:#19334b}h1,h2{color:#0c3446}h2{margin-top:1.8em}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 9px;text-align:left;border-bottom:1px solid #ccd8da}th{background:#e7f1f2}td{overflow-wrap:anywhere}";
  await writeFile(path, report);
  await writeFile(
    join(root, "report.html"),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RECAST 检索与开发速度实测</title><style>' +
      styles +
      "</style><main>" +
      html +
      "</main></html>",
  );
}
