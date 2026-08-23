#!/usr/bin/env python3
"""Validate Desktop release inputs and assemble the signed updater manifest."""

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import urllib.parse


TAG_PATTERN = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?$")


def validate_tag_version(tag, version):
    if not TAG_PATTERN.fullmatch(tag):
        raise ValueError("release tag must be SemVer with a v prefix")
    if tag != "v" + version:
        raise ValueError("Desktop version does not match release tag")


def find_signed_pair(root, directory, suffix):
    base = root / directory
    artifacts = sorted(
        path for path in base.rglob("*") if path.is_file() and path.name.endswith(suffix)
    )
    signatures = sorted(
        path
        for path in base.rglob("*")
        if path.is_file() and path.name.endswith(suffix + ".sig")
    )
    if len(artifacts) != 1 or len(signatures) != 1:
        raise ValueError(
            "expected exactly one signed {} in {}".format(suffix, directory)
        )
    expected_signature = pathlib.Path(str(artifacts[0]) + ".sig")
    if signatures[0] != expected_signature:
        raise ValueError("updater signature does not match artifact filename")
    signature = signatures[0].read_text(encoding="utf-8").strip()
    if not signature:
        raise ValueError("updater signature is empty")
    return artifacts[0], signature


def validate_release_assets(root, version):
    expected = {
        "lyrashield-desktop-macos-aarch64": (".dmg", ".app.tar.gz", ".app.tar.gz.sig"),
        "lyrashield-desktop-macos-x86_64": (".dmg", ".app.tar.gz", ".app.tar.gz.sig"),
        "lyrashield-desktop-windows-x86_64": ("-setup.exe", "-setup.exe.sig"),
    }
    names = []
    for directory, suffixes in expected.items():
        files = sorted(path for path in (root / directory).rglob("*") if path.is_file())
        for suffix in suffixes:
            matches = [path for path in files if path.name.endswith(suffix)]
            if len(matches) != 1:
                raise ValueError(
                    "expected exactly one {} in {}".format(suffix, directory)
                )
        if len(files) != len(suffixes):
            raise ValueError("unexpected release asset in {}".format(directory))
        for path in files:
            if version not in path.name:
                raise ValueError("release asset version does not match tag")
            names.append(path.name)
    if len(names) != len(set(names)):
        raise ValueError("duplicate release asset filename")


def build_manifest(root, tag, repository, published_at):
    validate_tag_version(tag, tag.removeprefix("v"))
    validate_release_assets(root, tag.removeprefix("v"))
    pairs = {
        "darwin-aarch64": find_signed_pair(
            root, "lyrashield-desktop-macos-aarch64", ".app.tar.gz"
        ),
        "darwin-x86_64": find_signed_pair(
            root, "lyrashield-desktop-macos-x86_64", ".app.tar.gz"
        ),
        "windows-x86_64": find_signed_pair(
            root, "lyrashield-desktop-windows-x86_64", "-setup.exe"
        ),
    }
    base = "https://github.com/{}/releases/download/{}".format(repository, tag)
    platforms = {}
    for platform, pair in pairs.items():
        artifact, signature = pair
        platforms[platform] = {
            "signature": signature,
            "url": "{}/{}".format(base, urllib.parse.quote(artifact.name)),
        }
    return {
        "version": tag.removeprefix("v"),
        "notes": "LyraShield Local {}".format(tag),
        "pub_date": published_at,
        "platforms": platforms,
    }


def write_checksums(paths, output):
    rows = []
    for path in sorted(paths, key=lambda item: item.name):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append("{}  {}".format(digest, path.name))
    output.write_text("\n".join(rows) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--tag", required=True)
    validate.add_argument("--version", required=True)

    manifest = subparsers.add_parser("manifest")
    manifest.add_argument("--artifacts", type=pathlib.Path, required=True)
    manifest.add_argument("--tag", required=True)
    manifest.add_argument("--repository", required=True)
    manifest.add_argument("--output", type=pathlib.Path, required=True)
    manifest.add_argument("--checksums", type=pathlib.Path, required=True)

    args = parser.parse_args()
    if args.command == "validate":
        validate_tag_version(args.tag, args.version)
        return

    published_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = build_manifest(args.artifacts, args.tag, args.repository, published_at)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    release_files = [path for path in args.artifacts.rglob("*") if path.is_file()]
    release_files.append(args.output)
    write_checksums(release_files, args.checksums)


if __name__ == "__main__":
    main()
