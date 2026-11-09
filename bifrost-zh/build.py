"""Merge translated batches (zh*.json) + manual overrides into dict.json, and build a Tampermonkey userscript."""
import glob, json, sys
from pathlib import Path
here = Path(__file__).parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "parts"
d = {}
for f in sorted(glob.glob(str(src / "zh*.json"))):
    for k, v in json.load(open(f)).items():
        if isinstance(v, str) and v.strip() and v != k:
            d[k.strip()] = v.strip()
over = here / "overrides.json"
if over.exists():
    d.update(json.load(open(over)))
(here / "dict.json").write_text(json.dumps(d, ensure_ascii=False, indent=0, sort_keys=True))
js = (here / "zh-bifrost.js").read_text()
head = """// ==UserScript==
// @name         Bifrost 控制台中文
// @match        http://127.0.0.1:8080/*
// @match        http://localhost:8080/*
// @run-at       document-end
// @grant        none
// ==/UserScript==
"""
(here / "bifrost-zh.user.js").write_text(head + "window.__BIFROST_ZH_DICT__ = " + json.dumps(d, ensure_ascii=False) + ";\n" + js)
print(len(d), "entries")
