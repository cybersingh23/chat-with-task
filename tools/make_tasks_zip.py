#!/usr/bin/env python3
"""Build a tasks .zip for admin upload to chat-with-task.

Bundles selected <task_id>/ folders from a materialized delivery plus the
delivery's _audit artifacts (so the upload auto-sorts into Hard/Soft/Pass and
each task gets its audit seed). Tasks shipped in previous deliveries can be
excluded by id list — though the web upload also skips anything already in the
workspace.

Usage:
  python3 tools/make_tasks_zip.py ~/Downloads/ACC_DELIVERY_0610 --out tasks_0610.zip
      [--ids 6a0e... 6a11...] [--ids-file prior_ids.txt --exclude]
"""
import argparse
import re
import sys
import zipfile
from pathlib import Path

TASK_ID_RE = re.compile(r"^[a-f0-9]{24}$")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("delivery", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--ids", nargs="*", default=None, help="only include these task ids")
    ap.add_argument("--ids-file", type=Path, default=None, help="file with one task id per line")
    ap.add_argument("--exclude", action="store_true", help="treat the id list as an exclusion list")
    args = ap.parse_args()

    delivery = args.delivery.expanduser().resolve()
    ids = set(args.ids or [])
    if args.ids_file:
        ids |= {l.strip() for l in args.ids_file.read_text().splitlines() if TASK_ID_RE.match(l.strip())}

    task_dirs = sorted(
        d for d in delivery.iterdir()
        if d.is_dir() and TASK_ID_RE.match(d.name) and (d / "rank.json").exists()
    )
    if ids:
        task_dirs = [d for d in task_dirs if (d.name in ids) != args.exclude]
    if not task_dirs:
        sys.exit("no tasks selected")

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as z:
        for td in task_dirs:
            for f in sorted(td.rglob("*")):
                if f.is_file() and f.name != ".DS_Store":
                    z.write(f, f.relative_to(delivery))
        audit = delivery / "_audit"
        if audit.is_dir():
            for f in sorted(audit.rglob("*")):
                if f.is_file() and f.name != ".DS_Store":
                    z.write(f, f.relative_to(delivery))
            print(f"included _audit ({sum(1 for f in audit.rglob('*') if f.is_file())} files)")
        else:
            print("WARNING: no _audit dir — upload will land everything in the fallback bucket")

    print(f"{args.out}: {len(task_dirs)} task(s), {args.out.stat().st_size / 1e6:.1f} MB")
    for td in task_dirs:
        print(f"  {td.name}")


if __name__ == "__main__":
    main()
