"""Render the Layer 0 scale curve from measured CSV rows. Usage: plot-scale.py results"""
import csv
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FuncFormatter, LogLocator

root = Path(sys.argv[1])
with (root / "index-query-scale.csv").open(encoding="utf-8-sig", newline="") as file:
    rows = [r for r in csv.DictReader(file) if r["heap"] == "default"
            and r["modeling"] == "directory-dependency/v1" and r["mode"] == "sag2-2hop"
            and r["phase"] == "warm" and r["query"] == "all"]
configs = ["seekdb-model", "seekdb-hash", "sag2-memory", "sag2-sqlite-file", "sag2-over-seekdb"]
colors = ["#95512b", "#d59900", "#166c86", "#66429b", "#27815c"]
markers = ["o", "s", "D", "^", "P"]
cases = sorted({r["caseId"]:int(r["loc"]) for r in rows}.items(), key=lambda x:x[1])
lookup = {(r["config"],r["caseId"]):r for r in rows}
fig = plt.figure(figsize=(10.2, 7.8), layout="constrained", facecolor="white")
grid = fig.add_gridspec(2, 2, height_ratios=[1.55, 1.05])
timing = fig.add_subplot(grid[0,0])
recall = fig.add_subplot(grid[0,1])
status = fig.add_subplot(grid[1,:])
xs = list(range(len(cases)))
def observed(r, k):
    return float(r[k]) if r and r[k] and r["status"] in ("ok","partial") else math.nan

for config, color, marker in zip(configs, colors, markers):
    group = [lookup.get((config,case)) for case,_ in cases]
    for ax, metric in [(timing,"p95Ms"),(recall,"recallAt4")]:
        ys = [observed(r, metric) for r in group]
        ax.plot(xs, ys, color=color, marker=marker, fillstyle="none", markersize=6, linewidth=1.5)
for ax in [timing,recall]:
    ax.set_xticks(xs, labels=[f"{case}\n{loc:,}" for case,loc in cases], fontsize=9)
    ax.set_xlabel("Corpus / production lines", labelpad=8)
    ax.spines[["right","top"]].set_visible(False)
    ax.grid(axis="y", color="#d4dfe4", linewidth=.8)
    ax.set_axisbelow(True)
    ax.set_xlim(-.25,max(len(xs)-.75,.25))
if any(observed(r,"p95Ms")>0 for r in rows):
    timing.set_yscale("log")
    timing.yaxis.set_major_locator(LogLocator(base=10, subs=(1,2,5)))
    timing.yaxis.set_major_formatter(FuncFormatter(lambda value,_: f"{value:,.0f}" if value>=1 else f"{value:g}"))
else:
    timing.text(.5,.5,"No successful timings",ha="center",transform=timing.transAxes)
    timing.set_ylim(0, 1)
    timing.set_yticks([])
timing.set_ylabel("Milliseconds, logarithmic scale")
timing.set_title("Warm P95 latency", loc="left", fontsize=13)
recall.set_ylabel("Fraction of labeled modules in Top-4")
recall.set_ylim(-.04,1.04)
recall.set_title("Warm Recall@4", loc="left", fontsize=13)
status.set_title("Successful / expected warm queries", loc="left", fontsize=13)
status.axis("off")
cells=[]; backgrounds=[]
for config in configs:
    cells.append([]); backgrounds.append([])
    for case,_ in cases:
        r=lookup.get((config,case))
        if not r: label,shade="Not run","#edf1f3"
        else:
            label=f"{r['succeeded']}/{r['expected']} · {r['status']}"
            shade={"ok":"#e0f0e9","unavailable":"#f5dddd","error":"#f5dddd","partial":"#f8eac9"}[r["status"]]
        cells[-1].append(label)
        backgrounds[-1].append(shade)
if cases:
    t=status.table(cellText=cells,cellColours=backgrounds,rowLabels=configs,colLabels=[c for c,_ in cases],
                   colLoc="center",cellLoc="center",bbox=[.2,.02,.79,.92])
    t.auto_set_font_size(False); t.set_fontsize(9)
    for (i,j), cell in t.get_celld().items():
        cell.set_edgecolor("white")
        if not i or j<0: cell.set_facecolor("white")
        if j<0 and i>0: cell.get_text().set_color(colors[i-1])
fig.suptitle("Retrieving the same four labeled probes as the corpus grows", fontsize=16)
fig.legend(handles=[Line2D([],[],color=c,marker=m,fillstyle="none",label=n)
                    for n,c,m in zip(configs,colors,markers)],loc="outside lower center",
           ncol=len(configs),fontsize=9,frameon=False)
fig.savefig(root/"index-query-scale.png", dpi=160, bbox_inches="tight")
plt.close(fig)
