#!/usr/bin/env python3
"""Extract a .zip or tar archive without letting it escape the output folder.

Usage: python3 -I tools/safe_extract.py ARCHIVE OUTDIR [--allow-large]

Skips (and reports) members that are absolute paths, use "..", are symlinks,
hard links or device files. Nothing inside the archive is run. Stops before
writing anything if the archive unpacks to more than 5 GB, unless
--allow-large is given (exit code 3 means "ask the user first").
"""

import os
import shutil
import stat
import sys
import tarfile
import zipfile

LARGE_BYTES = 5 * 1024**3
EXIT_TOO_LARGE = 3


def safe_path(outdir, name):
    """Return the destination path for a member, or None if it escapes."""
    if os.path.isabs(name) or name.startswith("\\"):
        return None
    dest = os.path.realpath(os.path.join(outdir, name))
    if os.path.commonpath([dest, outdir]) != outdir:
        return None
    return dest


def check_size(total, allow_large):
    if total > LARGE_BYTES and not allow_large:
        print(
            f"Archive unpacks to {total / 1024**3:.1f} GB (over 5 GB). "
            "Ask the user, then rerun with --allow-large.",
            file=sys.stderr,
        )
        sys.exit(EXIT_TOO_LARGE)


def extract_zip(archive, outdir, allow_large):
    extracted, skipped = 0, []
    with zipfile.ZipFile(archive) as zf:
        members = zf.infolist()
        check_size(sum(m.file_size for m in members), allow_large)
        for member in members:
            mode = member.external_attr >> 16
            dest = safe_path(outdir, member.filename)
            if dest is None or stat.S_ISLNK(mode):
                skipped.append(member.filename)
                continue
            if member.is_dir():
                os.makedirs(dest, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            extracted += 1
    return extracted, skipped


def extract_tar(archive, outdir, allow_large):
    extracted, skipped = 0, []
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        check_size(sum(m.size for m in members if m.isfile()), allow_large)
        for member in members:
            if not (member.isfile() or member.isdir()):
                skipped.append(member.name)  # links, devices, fifos
                continue
            dest = safe_path(outdir, member.name)
            if dest is None:
                skipped.append(member.name)
                continue
            if member.isdir():
                os.makedirs(dest, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with tf.extractfile(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(dest, member.mode & 0o644)  # never keep executable bits
            extracted += 1
    return extracted, skipped


def main():
    args = [a for a in sys.argv[1:] if a != "--allow-large"]
    allow_large = "--allow-large" in sys.argv[1:]
    if len(args) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    archive, outdir = args
    if os.path.exists(outdir):
        sys.exit(f"Already exists, remove it first: {outdir}")

    if zipfile.is_zipfile(archive):
        extract = extract_zip
    elif tarfile.is_tarfile(archive):
        extract = extract_tar
    else:
        sys.exit(f"Not a zip or tar archive: {archive}")

    os.makedirs(outdir)
    outdir = os.path.realpath(outdir)
    extracted, skipped = extract(archive, outdir, allow_large)
    print(f"Extracted {extracted} files to {outdir}")
    if skipped:
        print(f"Skipped {len(skipped)} unsafe entries:")
        for name in skipped:
            print(f"  {name}")


if __name__ == "__main__":
    main()
