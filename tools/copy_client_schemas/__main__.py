#!/usr/bin/env python3
"""Copy schemas exported by LLClientSchemaExporter from LeviLauncher."""

from __future__ import annotations

import argparse
import configparser
from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys
from typing import NoReturn, Sequence

from tools.prepare_test_data.__main__ import (
    ConflictResolver,
    SelectionCancelled,
    ToolError,
    clear_output_targets,
    choose_menu,
    copy_entry,
    levi_storage_roots,
    normalized_path,
    read_json_object,
    version_key,
)


MOD_NAME = "LLClientSchemaExporter"
NUMERIC_VERSION_PATTERN = re.compile(r"^\d+(?:\.\d+)+$")


@dataclass(frozen=True)
class ToolConfig:
    minecraft_path: str = ""
    output: str = ""


@dataclass(frozen=True)
class LeviVersion:
    path: Path
    name: str
    game_version: str

    def menu_label(self) -> str:
        version = self.game_version or "unknown version"
        return f"{self.name} ({version}) - {self.path}"


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        add_help=False,
        description=(
            "Find LLClientSchemaExporter in a LeviLauncher Minecraft version "
            "and copy its exported schemas into tests/schemas."
        ),
    )
    parser.add_argument(
        "-h",
        "--help",
        action="help",
        help="show this help message and list all arguments",
    )
    parser.add_argument(
        "-p",
        "--path",
        "--minecraft-path",
        metavar="PATH",
        help=(
            "LeviLauncher storage, versions, or Minecraft version directory; "
            "do not specify an MSIXVC download directory"
        ),
    )
    parser.add_argument(
        "-o",
        "--output",
        metavar="PATH",
        help=(
            "copy destination, relative to the repository root unless absolute "
            "(default: tests/schemas)"
        ),
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="clear the selected output directory before copying",
    )
    return parser.parse_args(argv)


def load_config(path: Path) -> ToolConfig:
    if not path.is_file():
        return ToolConfig()

    parser = configparser.ConfigParser(interpolation=None)
    try:
        with path.open("r", encoding="utf-8-sig") as config_file:
            parser.read_file(config_file)
    except (OSError, configparser.Error) as error:
        raise ToolError(f"unable to read configuration file {path}: {error}") from error

    section_name = "copy_client_schemas"
    if not parser.has_section(section_name):
        raise ToolError(f"configuration file {path} is missing [{section_name}]")
    section = parser[section_name]
    return ToolConfig(
        minecraft_path=section.get("minecraft_path", "").strip(),
        output=section.get("output", "").strip(),
    )


def apply_config(args: argparse.Namespace, config: ToolConfig) -> argparse.Namespace:
    if args.path is None and config.minecraft_path:
        args.path = config.minecraft_path
    if args.output is None and config.output:
        args.output = config.output
    return args


def is_version_directory(path: Path) -> bool:
    return (path / "version.json").is_file() or (path / "mods").is_dir()


def version_from_directory(path: Path) -> LeviVersion:
    metadata = read_json_object(path / "version.json") or {}
    name = str(metadata.get("name", "")).strip() or path.name
    game_version = str(metadata.get("gameVersion", "")).strip() or path.name
    return LeviVersion(path.resolve(), name, game_version)


def version_directories_from_root(root: Path) -> list[Path]:
    candidates: list[Path] = []
    if is_version_directory(root):
        candidates.append(root)

    versions_roots = [root] if root.name.casefold() == "versions" else []
    versions_roots.append(root / "versions")
    for versions_root in versions_roots:
        try:
            children = list(versions_root.iterdir())
        except OSError:
            continue
        candidates.extend(
            child for child in children if child.is_dir() and is_version_directory(child)
        )
    return candidates


def discover_versions(search_path: str | None) -> list[LeviVersion]:
    roots: Sequence[Path]
    if search_path:
        configured = Path(os.path.expandvars(os.path.expanduser(search_path)))
        try:
            roots = [configured.resolve(strict=True)]
        except OSError as error:
            raise ToolError(
                f"LeviLauncher Minecraft path is unavailable: {configured}: {error}"
            ) from error
        if not roots[0].is_dir():
            raise ToolError(f"LeviLauncher Minecraft path is not a directory: {roots[0]}")
    else:
        roots = sorted(levi_storage_roots(), key=lambda item: str(item).casefold())

    unique: dict[str, LeviVersion] = {}
    for root in roots:
        for version_directory in version_directories_from_root(root):
            version = version_from_directory(version_directory)
            unique[normalized_path(version.path)] = version

    versions = sorted(
        unique.values(),
        key=lambda item: (
            tuple(-part for part in version_key(item.game_version)),
            str(item.path).casefold(),
        ),
    )
    if versions:
        return versions

    if search_path:
        raise ToolError(
            "no LeviLauncher Minecraft versions were found at the specified path; "
            "specify the LeviLauncher storage/version directory, not an MSIXVC "
            "download directory"
        )
    raise ToolError(
        "no LeviLauncher Minecraft versions were found automatically; use --path"
    )


def select_version(versions: Sequence[LeviVersion]) -> LeviVersion:
    if len(versions) == 1:
        return versions[0]
    return choose_menu(
        "Select a LeviLauncher Minecraft version (Up/Down, Enter):",
        [(version.menu_label(), version) for version in versions],
    )


def find_exporter_mod(version: LeviVersion) -> Path:
    mods_root = version.path / "mods"
    if not mods_root.is_dir():
        raise ToolError(f"selected Minecraft version has no mods directory: {mods_root}")

    matches: list[Path] = []
    try:
        manifests = sorted(mods_root.rglob("manifest.json"), key=str)
    except OSError as error:
        raise ToolError(f"unable to scan {mods_root}: {error}") from error

    for manifest in manifests:
        metadata = read_json_object(manifest)
        if metadata is not None and metadata.get("name") == MOD_NAME:
            matches.append(manifest.parent.resolve())

    if not matches:
        raise ToolError(
            f"no mod with manifest name '{MOD_NAME}' was found under {mods_root}"
        )
    if len(matches) == 1:
        return matches[0]
    return choose_menu(
        f"Select a {MOD_NAME} installation (Up/Down, Enter):",
        [(str(match), match) for match in matches],
    )


def select_export_directory(mod_root: Path, game_version: str) -> Path:
    data_root = mod_root / "data"
    if not data_root.is_dir():
        raise ToolError(f"{MOD_NAME} has no data directory: {data_root}")

    try:
        candidates = sorted(
            (entry.resolve() for entry in data_root.iterdir() if entry.is_dir()),
            key=lambda item: tuple(-part for part in version_key(item.name)),
        )
    except OSError as error:
        raise ToolError(f"unable to read exporter data directory {data_root}: {error}") from error

    exact = [
        candidate
        for candidate in candidates
        if candidate.name == game_version
        or (
            NUMERIC_VERSION_PATTERN.fullmatch(candidate.name) is not None
            and NUMERIC_VERSION_PATTERN.fullmatch(game_version) is not None
            and version_key(candidate.name) == version_key(game_version)
        )
    ]
    if exact:
        return exact[0]
    if not candidates:
        raise ToolError(f"no versioned schema exports were found under {data_root}")
    if len(candidates) == 1:
        return candidates[0]
    return choose_menu(
        "The matching game-version export was not found. Select an export (Up/Down, Enter):",
        [(candidate.name, candidate) for candidate in candidates],
    )


def resolve_output_path(repository_root: Path, value: str | None) -> Path:
    configured = Path(os.path.expandvars(os.path.expanduser(value or "tests/schemas")))
    if not configured.is_absolute():
        configured = repository_root / configured
    return configured.resolve()


def validate_copy_paths(source: Path, destination: Path) -> None:
    if (
        destination == source
        or destination.is_relative_to(source)
        or source.is_relative_to(destination)
    ):
        raise ToolError(
            "destination and exporter data must not contain one another: "
            f"{destination}"
        )


def prepare_destination(
    repository_root: Path,
    source: Path,
    destination: Path,
    *,
    force: bool,
) -> None:
    validate_copy_paths(source, destination)
    if force:
        clear_output_targets(repository_root, [destination])


def copy_export(source: Path, destination: Path) -> None:
    validate_copy_paths(source, destination)
    resolver = ConflictResolver(
        noninteractive_hint="run interactively or use --force"
    )
    try:
        children = list(source.iterdir())
        for child in children:
            copy_entry(child, destination / child.name, resolver)
    except OSError as error:
        raise ToolError(f"unable to copy client schemas: {error}") from error


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if os.name != "nt":
        raise ToolError("this tool supports Windows only")

    config_path = Path(__file__).with_name("config.ini")
    args = apply_config(args, load_config(config_path))
    version = select_version(discover_versions(args.path))
    mod_root = find_exporter_mod(version)
    source = select_export_directory(mod_root, version.game_version)
    repository_root = Path(__file__).resolve().parents[2]
    destination = resolve_output_path(repository_root, args.output)

    print(f"Selected Minecraft: {version.menu_label()}")
    print(f"Exporter mod: {mod_root}")
    print(f"Schema export: {source}")
    prepare_destination(
        repository_root,
        source,
        destination,
        force=args.force,
    )
    print(f"Copying schemas -> {destination}")
    copy_export(source, destination)
    print("Client schema copy completed successfully.")
    print(f"Schemas: {destination}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SelectionCancelled:
        print("Cancelled.")
        raise SystemExit(0)
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        raise SystemExit(130)
    except ToolError as error:
        fail(str(error))
