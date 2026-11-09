"""Freeze production source snapshots for Layer 0. Run on the Windows checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

BENCH = Path(__file__).resolve().parents[2]
PRODUCT = BENCH.parent / "weichai"
CORPORA = BENCH / "corpora"
ARCH = CORPORA / "enterprise-asset-upgrade"
ARCH_REF = "5ff260547903a81ce77de22d72853031566b8a19"
PRODUCT_REF = "986d21575803fca473d39693042b04adb7d75c26"
CAMEL_REF = "e44ef154a5d51ca8c5a353fb838c52815d197ae1"
CAMEL = BENCH.parent / "recast-smoke-camel"
LANGUAGES = {
    ".ets":"ArkTS", ".ts":"TypeScript", ".tsx":"TypeScript",
    ".js":"JavaScript", ".jsx":"JavaScript", ".mjs":"JavaScript", ".cjs":"JavaScript",
    ".py":"Python", ".go":"Go", ".rs":"Rust", ".java":"Java", ".cs":"C#",
    ".kt":"Kotlin", ".swift":"Swift", ".c":"C", ".h":"C", ".cpp":"C++",
    ".hpp":"C++", ".cc":"C++",
}
NON_PRODUCTION = {"test","tests","__tests__","testdata","fixtures","testing","benchmarks",
                  "examples","sample","samples","generated","generated-sources","vendor",
                  "node_modules","target","dist","build","bin","obj","coverage","it",
                  "test-fixtures","mocks","__mocks__"}
DESCRIPTORS = {"package.json","tsconfig.json","go.mod","Cargo.toml","pom.xml",
               "pyproject.toml","setup.cfg","settings.gradle","settings.gradle.kts",
               "build.gradle","build.gradle.kts","build-profile.json5","module.json5",
               "oh-package.json5","CMakeLists.txt"}
LEGAL = {"license","license.txt","license.md","notice","notice.txt","copying"}

def git(repo, *args):
    return subprocess.check_output(["git","-C",repo,*args])

def atomic_json(path, obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
    os.replace(tmp,path)

def archived_sources():
    ARCH.mkdir(parents=True,exist_ok=True)
    for f in ("materialize.py","asset-sources.json"):
        content=git(PRODUCT,"show",f"{ARCH_REF}:experiments/enterprise-asset-upgrade/{f}")
        (ARCH/f).write_bytes(content)
    return json.loads((ARCH/"asset-sources.json").read_text(encoding="utf8"))["repositories"]

def fetch_archived(sources):
    # The archived script clones default HEAD. Pre-seed its expected directories
    # at the explicit archive SHAs, then use its --depth 1 sparse materializer.
    for r in sources:
        repo=ARCH/"source-repositories"/r["id"]
        repo.mkdir(parents=True,exist_ok=True)
        if not (repo/".git").is_dir():
            git(repo,"init","-q")
            git(repo,"config","core.longpaths","true")
            git(repo,"config","core.autocrlf","false")
            git(repo,"remote","add","origin",r["url"])
        current=subprocess.run(["git","-C",repo,"rev-parse","--verify","HEAD"],capture_output=True)
        if current.returncode==0:
            if current.stdout.decode().strip()!=r["commit"]:
                raise ValueError(f"{repo} already holds a different revision")
        else:
            git(repo,"fetch","--depth","1","--no-tags","origin",r["commit"])
            git(repo,"update-ref","refs/heads/frozen",r["commit"])
            git(repo,"symbolic-ref","HEAD","refs/heads/frozen")
    subprocess.run([sys.executable,ARCH/"materialize.py","--depth","1","--file-hashes"],check=True)

def category(p, allowed):
    parts=p.parts
    if len(parts)==1 and p.name.lower() in LEGAL:
        return "legal"
    if any(x.lower() in NON_PRODUCTION for x in parts[:-1]):
        return None
    if p.name in DESCRIPTORS or p.suffix in (".csproj",".sln"):
        return "descriptor"
    lang=LANGUAGES.get(p.suffix.lower())
    if not lang or (allowed and lang not in allowed): return None
    n=p.name.lower()
    if any(s in n for s in (".min.",".test.",".spec.",".generated.",".designer.")):
        return None
    if n.startswith("test_") or n.endswith(("_test.go","_test.py","test.java","tests.java")):
        return None
    return lang

def count_lang(counts,lang,files,loc):
    entry=counts.setdefault(lang,{"files":0,"loc":0})
    entry["files"]+=files
    entry["loc"]+=loc

def snapshot(repo,commit,id,paths=(),prefix="",allowed=None,snapshot_name=None):
    root=CORPORA/"snapshots"/(snapshot_name or id)
    root.mkdir(parents=True,exist_ok=True)
    tree=git(repo,"ls-tree","-r","-z",commit,"--",*(paths or ([prefix] if prefix else [])))
    blobs=[]
    for rec in tree.split(b"\0"):
        if not rec: continue
        header,path=rec.split(b"\t",1)
        mode,kind,sha=header.split()
        if kind!=b"blob" or mode not in (b"100644",b"100755"):continue
        p=PurePosixPath(path.decode("utf8"))
        if prefix:p=p.relative_to(prefix)
        cat=category(p,allowed)
        if cat:blobs.append((p,cat,sha))
    blobs.sort(key=lambda x:x[0].as_posix())
    stream=subprocess.Popen(["git","-C",repo,"cat-file","--batch"],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    sources=[]
    hashes=[]
    counts={}
    try:
        for p,cat,sha in blobs:
            stream.stdin.write(sha+b"\n");stream.stdin.flush()
            header=stream.stdout.readline().split()
            if len(header)!=3 or header[0]!=sha:raise ValueError(f"Missing blob {sha}")
            content=stream.stdout.read(int(header[2]))
            if len(content)!=int(header[2]) or stream.stdout.read(1)!=b"\n":raise ValueError("Invalid Git object stream")
            out=root.joinpath(*p.parts)
            if out.exists():
                if out.read_bytes()!=content:
                    raise ValueError(f"Frozen file changed: {out}")
            else:
                out.parent.mkdir(parents=True,exist_ok=True)
                out.write_bytes(content)
            digest=hashlib.sha256(content).hexdigest()
            hashes.append({"path":p.as_posix(),"sha256":digest})
            if cat not in ("legal","descriptor"):
                sources.append(p.as_posix())
                loc=len(content.splitlines())
                count_lang(counts,cat,1,loc)
    finally:
        stream.stdin.close();stream.wait()
    actual={p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    if actual!={p.as_posix() for p,_,_ in blobs}:
        raise ValueError(f"Unexpected files in frozen snapshot {root}")
    sha=hashlib.sha256()
    for item in hashes:
        sha.update(item["path"].encode()+b"\0"+bytes.fromhex(item["sha256"]))
    list_file=CORPORA/"inventories"/(root.name+".sources.json")
    atomic_json(list_file,sources)
    atomic_json(CORPORA/"inventories"/(root.name+".sha256.json"),hashes)
    if not sources:raise ValueError(f"No production sources in {root}")
    return {"id":id,"root":str(root),"commit":commit,"files":len(sources),
            "loc":sum(x["loc"] for x in counts.values()),"languages":counts,"sha256":sha.hexdigest(),
            "sourceList":str(list_file),"snapshotFiles":len(blobs),"pathFilters":list(paths),
            "languageFilter":sorted(allowed) if allowed else None,"prefix":prefix}

def case(id,scale,languageMode,repos):
    langs={}
    for r in repos:
        for lang,count in r["languages"].items():count_lang(langs,lang,count["files"],count["loc"])
    sha=hashlib.sha256()
    for r in repos:sha.update(r["id"].encode()+b"\0"+r["commit"].encode()+bytes.fromhex(r["sha256"]))
    return {"id":id,"scale":scale,"languageMode":languageMode,"repositories":repos,
            "files":sum(x["files"] for x in langs.values()),"loc":sum(x["loc"] for x in langs.values()),
            "languages":langs,"sha256":sha.hexdigest()}

def main():
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument("--fixtures-only",action="store_true")
    args.add_argument("--already-materialized",action="store_true",help="Use local checkouts at the archived SHAs")
    opt=args.parse_args()
    if sys.platform!="win32":raise SystemExit("Use the Windows benchmark workspace")
    subprocess.run(["node","scripts/check-platform-workspace.mjs"],cwd=PRODUCT,check=True)
    cases=[]
    def publish(c):
        cases.append(c)
        atomic_json(CORPORA/"manifest.json",{"version":1,"archiveCommit":ARCH_REF,"productCommit":PRODUCT_REF,
            "counting":"Physical production-source lines from pinned Git blobs. Tests, vendored and generated directories are excluded. Root legal files and build descriptors are hashed but excluded from LoC. Scale denotes the planned case tier; use measured files and loc for comparisons.",
            "cases":cases})
        print(c["id"],c["files"],c["loc"],flush=True)
    def fixture(path):
        return snapshot(PRODUCT,PRODUCT_REF,PurePosixPath(path).name,prefix=path)
    ledger=fixture("fixtures/code-corpus/ledger-flow-ts")
    publish(case("B01","XS","single",[ledger]))
    java=fixture("fixtures/target-system/commons-fileupload-java-skeleton")
    publish(case("B02","S","single",[java]))
    names=git(PRODUCT,"ls-tree","-d","--name-only",PRODUCT_REF+":fixtures/code-corpus").decode().splitlines()
    fixtures=[ledger if name==ledger["id"] else fixture("fixtures/code-corpus/"+name) for name in names]
    publish(case("B03","S","multi",fixtures))
    if opt.fixtures_only:return
    sources=archived_sources()
    if not opt.already_materialized:fetch_archived(sources)
    lookup={r["id"]:r for r in sources}
    def archived(id,allowed=None,extra=(),snapshot_name=None):
        r=lookup[id];repo=ARCH/"source-repositories"/id
        commit=git(repo,"rev-parse","HEAD").decode().strip()
        if commit!=r["commit"]:raise ValueError(f"{id} HEAD differs from archived SHA")
        return snapshot(repo,commit,id,[*r["paths"],*extra,"LICENSE*","NOTICE*","COPYING","pom.xml","pyproject.toml","package.json"],
                        allowed=allowed,snapshot_name=snapshot_name)
    aps=archived("apscheduler",{"Python"})
    bull=archived("bullmq",{"TypeScript"})
    publish(case("B04","M","single",[aps]))
    publish(case("B05","M","multi",[bull,aps]))
    flow=archived("flowable-engine",{"Java"})
    publish(case("B06","L","single",[flow]))
    nop=archived("nopcommerce",{"C#","JavaScript"},["src/Presentation/Nop.Web/wwwroot/js"],"nopcommerce-with-web-js")
    publish(case("B07","L","multi",[nop]))
    big=snapshot(CAMEL,CAMEL_REF,"apache-camel-full",allowed={"Java"})
    publish(case("B08","XL","single",[big]))
    # B09 follows archive subtree boundaries, with no extra B07 web assets.
    archived_repos={r["id"]:r for r in (aps,bull,flow)}
    for r in sources:
        if r["id"] not in archived_repos:archived_repos[r["id"]]=archived(r["id"])
    publish(case("B09","XL","multi",[archived_repos[r["id"]] for r in sources]))

if __name__=="__main__":main()
