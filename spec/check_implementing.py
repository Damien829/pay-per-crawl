"""Checks IMPLEMENTING.md and IMPLEMENTATIONS.md against ai-terms-vectors.json.   python3 spec/check_implementing.py

- Every vector group IMPLEMENTING.md names exists at its JSON path, with the case count it states, and every case
  has the members the table says each case has (a member written as "sometimes x" is optional).
- The robots check count and the "58 of 58" total it states match the file.
- Every row of IMPLEMENTATIONS.md is complete: an https link, "N of M" vectors with M the file's total, an
  independent value of yes or no, and a date. The "none" line holds only while no row says yes.
Standard library only.
"""
import json
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
read = lambda name: open(os.path.join(here, name), encoding="utf-8").read()
vectors = json.loads(read("ai-terms-vectors.json"))
implementing, implementations = read("IMPLEMENTING.md"), read("IMPLEMENTATIONS.md")
problems = []


def table(text, tag):
    m = re.search(r"<!-- %s:[^>]*-->\n(.*?)<!-- /%s -->" % (tag, tag), text, re.S)
    if not m:
        problems.append("no %s table" % tag)
        return []
    rows = [[c.strip() for c in line.strip().strip("|").split("|")] for line in m.group(1).strip().splitlines()]
    return rows[2:]  # skip the header and the |---| line


def at(path):
    node = vectors
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


groups = table(implementing, "vector-groups")
reader_total = 0
for row in groups:
    if len(row) != 5:
        problems.append("vector-groups row has %d cells: %s" % (len(row), row))
        continue
    name, path, count = row[0].strip("`"), row[1].strip("`"), row[2]
    cases = at(path)
    if not isinstance(cases, list):
        problems.append("%s: %s is not a list in the vectors" % (name, path))
        continue
    if not count.isdigit() or int(count) != len(cases):
        problems.append("%s: table says %s cases, the file has %d" % (name, count, len(cases)))
    required = [m for m in re.findall(r"(sometimes [a-z ]*)?`([a-z_]+)`", row[3]) if not m[0]]
    for _, key in required:
        missing = [c.get("name", "?") for c in cases if key not in c]
        if missing:
            problems.append("%s: %d case(s) lack %s" % (name, len(missing), key))
    if name == "robots":
        checks = sum(len(c["checks"]) for c in cases)
        m = re.search(r"\((\d+) in all\)", row[3])
        if not m or int(m.group(1)) != checks:
            problems.append("robots: table says %s checks, the file has %d" % (m and m.group(1), checks))
    else:
        reader_total += len(cases)

named = {r[0].strip("`") for r in groups if len(r) == 5}
expected = {"validate", "resolve", "content_usage", "robots"}
if named != expected:
    problems.append("groups named %s, the file has %s" % (sorted(named), sorted(expected)))
if not isinstance(at("resolve.terms"), dict):
    problems.append("resolve.terms is missing")
if "**%d of %d**" % (reader_total, reader_total) not in implementing:
    problems.append("IMPLEMENTING.md does not state %d of %d" % (reader_total, reader_total))

rows = table(implementations, "implementations")
independent = 0
for row in rows:
    if len(row) != 7:
        problems.append("implementations row has %d cells: %s" % (len(row), row))
        continue
    name, _, link, passed, _, indep, listed = row
    if not link.startswith("https://"):
        problems.append("%s: link is not https" % name)
    m = re.match(r"(\d+) of (\d+)\b", passed)
    if not m or int(m.group(2)) != reader_total or int(m.group(1)) > reader_total:
        problems.append("%s: vectors passed %r is not 'N of %d'" % (name, passed, reader_total))
    if not re.match(r"(yes|no)\b", indep):
        problems.append("%s: independent must start with yes or no" % name)
    independent += indep.startswith("yes")
    if not re.match(r"\d{4}-\d{2}-\d{2}$", listed):
        problems.append("%s: listed date %r" % (name, listed))
if not rows:
    problems.append("no implementations listed")
if independent and "Independent implementations so far: none." in implementations:
    problems.append('a row says independent: yes, but the page still says "none"')

for p in problems:
    print("FAIL", p)
print("%d vector groups, %d reader cases, %d implementations (%d independent): %s"
      % (len(groups), reader_total, len(rows), independent, "ok" if not problems else "%d problem(s)" % len(problems)))
sys.exit(1 if problems else 0)
