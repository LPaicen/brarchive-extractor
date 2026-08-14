#!/usr/bin/env python3
"""Prepare local Minecraft Bedrock packs and JSON schemas for tests."""

from __future__ import annotations

import argparse
import configparser
import ctypes
import filecmp
import json
import os
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from typing import NoReturn, Sequence, TypeVar
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ElementTree
from zipfile import BadZipFile, ZipFile


DEFAULT_SCHEMA_REPOSITORY = "https://github.com/bedrock-apis/bds-docs"
DEFAULT_BRANCHES = {"stable": "stable", "preview": "preview"}
OFFICIAL_PACKAGE_CHANNELS = {
    "microsoft.minecraftuwp": "stable",
    "microsoft.minecraftwindowsbeta": "preview",
}
PACK_DIRECTORIES = ("behavior_packs", "resource_packs")
LEVI_STORAGE_RELATIVE_PATHS = (
    Path("Program Files/LeviMC/mc/levilauncher.exe"),
    Path("Program Files (x86)/LeviMC/mc/levilauncher.exe"),
    Path("LeviMC/mc/levilauncher.exe"),
    Path("Games/LeviMC/mc/levilauncher.exe"),
)
PRESET_INSTALLATION_RELATIVE_PATHS = (
    (Path("XboxGames/Minecraft for Windows/Content"), "stable"),
    (Path("XboxGames/Minecraft Preview for Windows/Content"), "preview"),
    (Path("Program Files/ModifiableWindowsApps/Minecraft for Windows"), "stable"),
    (
        Path("Program Files/ModifiableWindowsApps/Minecraft Preview for Windows"),
        "preview",
    ),
)
SCAN_SKIP_DIRECTORIES = {
    "$recycle.bin",
    ".git",
    "node_modules",
    "recovery",
    "system volume information",
    "windows",
}
GITHUB_COMPONENT_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


class ToolError(RuntimeError):
    """An expected error that can be shown without a traceback."""


class SelectionCancelled(RuntimeError):
    """The user exited an interactive selection menu."""


@dataclass(frozen=True)
class ToolConfig:
    minecraft_source: str = ""
    schema_repository: str = ""
    schema_branch: str = ""
    minecraft_output: str = ""
    schema_output: str = ""
    no_schema: str = ""


@dataclass(frozen=True)
class SchemaSource:
    repository: str
    branch: str


@dataclass(frozen=True)
class MinecraftInstallation:
    name: str
    source: str
    version: str
    channel: str | None
    install_location: Path
    data_directory: Path
    package_full_name: str = ""

    def menu_label(self) -> str:
        channel = self.channel or "unknown channel"
        version = self.version or "unknown version"
        return (
            f"[{self.source}; {channel}] {self.name} {version} - "
            f"{self.install_location}"
        )


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        add_help=False,
        description=(
            "Find a Minecraft Bedrock installation, copy its vanilla packs into "
            "tests/input, and download a schema repository into "
            "tests/schemas. Existing destination pack and schema directories "
            "are merged unless --force is used."
        ),
        epilog=(
            "SOURCE may be 'stable', 'preview', or a directory to search. Omit "
            "SOURCE to check registered packages and common installation paths, "
            "then choose interactively. Use --path when a directory is literally "
            "named 'stable' or 'preview'."
        ),
    )
    parser.add_argument(
        "-h",
        "--help",
        action="help",
        help="show this help message and list all arguments",
    )
    parser.add_argument(
        "source",
        nargs="?",
        metavar="SOURCE",
        help="official channel (stable/preview) or a directory to search",
    )
    parser.add_argument(
        "-p",
        "--path",
        metavar="PATH",
        help="directory to search for Minecraft Bedrock installations",
    )
    parser.add_argument(
        "-r",
        "--schema-repository",
        "--schema-repo",
        metavar="URL",
        help=(
            "GitHub schema repository URL (default: bedrock-apis/bds-docs)"
        ),
    )
    parser.add_argument(
        "-b",
        "--branch",
        metavar="NAME",
        help=(
            "schema repository branch; defaults to main for a custom repository"
        ),
    )
    parser.add_argument(
        "-m",
        "--minecraft-output",
        metavar="PATH",
        help="Minecraft pack destination (default: tests/input)",
    )
    parser.add_argument(
        "-s",
        "--schema-output",
        metavar="PATH",
        help="schema destination (default: tests/schemas)",
    )
    parser.add_argument(
        "-n",
        "--no-schema",
        action="store_true",
        default=None,
        help="copy Minecraft packs without downloading schemas",
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="clear the selected destination directories before copying",
    )
    args = parser.parse_args(argv)
    if args.source is not None and args.path is not None:
        parser.error("SOURCE and --path cannot be used together")
    return args


def load_config(path: Path) -> ToolConfig:
    if not path.is_file():
        return ToolConfig()

    parser = configparser.ConfigParser(interpolation=None)
    try:
        with path.open("r", encoding="utf-8-sig") as config_file:
            parser.read_file(config_file)
    except (OSError, configparser.Error) as error:
        raise ToolError(f"unable to read configuration file {path}: {error}") from error

    section_name = "prepare_test_data"
    if not parser.has_section(section_name):
        raise ToolError(
            f"configuration file {path} is missing [{section_name}]"
        )
    section = parser[section_name]
    return ToolConfig(
        minecraft_source=section.get("minecraft_source", "").strip(),
        schema_repository=section.get("schema_repository", "").strip(),
        schema_branch=section.get("schema_branch", "").strip(),
        minecraft_output=section.get("minecraft_output", "").strip(),
        schema_output=section.get("schema_output", "").strip(),
        no_schema=section.get("no_schema", "").strip(),
    )


def apply_config(args: argparse.Namespace, config: ToolConfig) -> argparse.Namespace:
    if args.source is None and args.path is None and config.minecraft_source:
        args.source = config.minecraft_source
    if args.schema_repository is None and config.schema_repository:
        args.schema_repository = config.schema_repository
    if args.branch is None and config.schema_branch:
        args.branch = config.schema_branch
    if args.minecraft_output is None and config.minecraft_output:
        args.minecraft_output = config.minecraft_output
    if args.schema_output is None and config.schema_output:
        args.schema_output = config.schema_output
    if args.no_schema is None:
        normalized = config.no_schema.casefold()
        valid_boolean_values = {
            "1",
            "true",
            "yes",
            "on",
            "0",
            "false",
            "no",
            "off",
        }
        if normalized and normalized not in valid_boolean_values:
            raise ToolError(
                "configuration value no_schema must be true or false"
            )
        args.no_schema = normalized in {"1", "true", "yes", "on"}
    return args


def run_powershell(script: str) -> subprocess.CompletedProcess[str]:
    executables = ("powershell.exe", "pwsh.exe")
    last_error: OSError | None = None

    for executable in executables:
        try:
            return subprocess.run(
                [
                    executable,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as error:
            last_error = error

    detail = f": {last_error}" if last_error else ""
    raise ToolError(f"PowerShell is required to locate official Minecraft{detail}")


def query_minecraft_packages() -> list[dict[str, str]]:
    script = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$packages = @(
    Get-AppxPackage -Name '*Minecraft*' -ErrorAction SilentlyContinue |
        Where-Object { $_.InstallLocation } |
        Select-Object Name, PackageFullName, InstallLocation,
            @{Name='Version'; Expression={$_.Version.ToString()}}
)
ConvertTo-Json -InputObject $packages -Compress
""".strip()
    result = run_powershell(script)
    if result.returncode != 0:
        detail = result.stderr.strip() or "Get-AppxPackage failed"
        raise ToolError(f"unable to query installed AppX packages: {detail}")

    output = result.stdout.lstrip("\ufeff").strip()
    if not output:
        return []

    try:
        packages = json.loads(output)
    except json.JSONDecodeError as error:
        raise ToolError(f"PowerShell returned invalid package data: {error}") from error

    if isinstance(packages, dict):
        packages = [packages]
    if not isinstance(packages, list):
        raise ToolError("PowerShell returned an unexpected package list")

    return [package for package in packages if isinstance(package, dict)]


def has_pack_directories(data_directory: Path) -> bool:
    return all((data_directory / name).is_dir() for name in PACK_DIRECTORIES)


def read_json_object(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def read_appx_identity(install_location: Path) -> tuple[str, str] | None:
    manifest = install_location / "AppxManifest.xml"
    try:
        root = ElementTree.parse(manifest).getroot()
    except (OSError, ElementTree.ParseError):
        return None

    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1].casefold() == "identity":
            return element.attrib.get("Name", ""), element.attrib.get("Version", "")
    return None


def channel_from_type(value: object) -> str | None:
    normalized = str(value).strip().casefold()
    if normalized in {"release", "stable"}:
        return "stable"
    if normalized in {"beta", "preview"}:
        return "preview"
    return None


def infer_installation(
    data_directory: Path,
    *,
    source: str,
    name: str | None = None,
    version: str | None = None,
    channel: str | None = None,
    package_full_name: str = "",
) -> MinecraftInstallation:
    data_directory = data_directory.resolve()
    install_location = data_directory.parent
    detected_name = name or install_location.name or "Minecraft Bedrock"
    detected_source = source
    detected_version = version or ""
    detected_channel = channel

    metadata = read_json_object(install_location / "version.json")
    if metadata is not None:
        metadata_name = str(metadata.get("name", "")).strip()
        metadata_version = str(metadata.get("gameVersion", "")).strip()
        detected_name = metadata_name or detected_name
        detected_version = metadata_version or detected_version
        detected_channel = channel_from_type(metadata.get("type")) or detected_channel
        if source in {"Discovered", "Official AppX"}:
            detected_source = "LeviLauncher"

    identity = read_appx_identity(install_location)
    if identity is not None:
        identity_name, identity_version = identity
        detected_name = identity_name or detected_name
        detected_version = identity_version or detected_version
        detected_channel = (
            OFFICIAL_PACKAGE_CHANNELS.get(identity_name.casefold()) or detected_channel
        )

    if detected_channel is None:
        path_hint = str(install_location).casefold()
        if "preview" in path_hint or "windowsbeta" in path_hint:
            detected_channel = "preview"

    return MinecraftInstallation(
        name=detected_name,
        source=detected_source,
        version=detected_version or "unknown",
        channel=detected_channel,
        install_location=install_location,
        data_directory=data_directory,
        package_full_name=package_full_name,
    )


def discover_official_installations(
    packages: Sequence[dict[str, str]], channel: str | None = None
) -> list[MinecraftInstallation]:
    installations: list[MinecraftInstallation] = []
    for package in packages:
        package_name = str(package.get("Name", "")).strip()
        detected_channel = OFFICIAL_PACKAGE_CHANNELS.get(package_name.casefold())
        if detected_channel is None or (channel and detected_channel != channel):
            continue

        install_location = Path(str(package.get("InstallLocation", "")).strip())
        data_directory = install_location / "data"
        if not has_pack_directories(data_directory):
            continue

        installation = infer_installation(
            data_directory,
            source="Official AppX",
            name=(
                "Minecraft for Windows"
                if detected_channel == "stable"
                else "Minecraft Preview"
            ),
            version=str(package.get("Version", "unknown")),
            channel=detected_channel,
            package_full_name=str(package.get("PackageFullName", package_name)),
        )
        if channel is None or installation.source == "Official AppX":
            installations.append(installation)
    return installations


def levi_storage_roots() -> set[Path]:
    roots: set[Path] = set()
    config_directories: set[Path] = set()

    for environment_name in ("APPDATA", "LOCALAPPDATA"):
        value = os.environ.get(environment_name)
        if not value:
            continue
        application_data = Path(value)
        config_directories.add(application_data / "levilauncher.exe")
        try:
            for child in application_data.iterdir():
                if child.is_dir() and "levilauncher" in child.name.casefold():
                    config_directories.add(child)
        except OSError:
            pass

    for drive_root in local_drive_roots():
        for relative_path in LEVI_STORAGE_RELATIVE_PATHS:
            config_directories.add(drive_root / relative_path)

    for config_directory in config_directories:
        if config_directory.is_dir():
            roots.add(config_directory)
        config = read_json_object(config_directory / "config.json")
        if config is None:
            continue
        base_root = str(config.get("base_root", "")).strip()
        if base_root:
            roots.add(Path(os.path.expandvars(os.path.expanduser(base_root))))

    return roots


def discover_levilauncher_installations() -> list[MinecraftInstallation]:
    installations: list[MinecraftInstallation] = []
    for storage_root in levi_storage_roots():
        versions_root = storage_root / "versions"
        try:
            version_directories = [entry for entry in versions_root.iterdir() if entry.is_dir()]
        except OSError:
            continue

        for version_directory in version_directories:
            data_directory = version_directory / "data"
            if has_pack_directories(data_directory):
                installations.append(
                    infer_installation(data_directory, source="LeviLauncher")
                )
    return installations


def is_reparse_directory(entry: os.DirEntry[str]) -> bool:
    try:
        attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attributes & 0x400)


def direct_data_directory(path: Path) -> Path | None:
    nested = path / "data"
    if has_pack_directories(nested):
        return nested
    if has_pack_directories(path):
        return path
    return None


def scan_search_root(search_root: Path) -> list[MinecraftInstallation]:
    try:
        search_root = search_root.expanduser().resolve(strict=True)
    except OSError as error:
        raise ToolError(f"search path is unavailable: {search_root}: {error}") from error
    if not search_root.is_dir():
        raise ToolError(f"search path is not a directory: {search_root}")

    direct = direct_data_directory(search_root)
    if direct is not None:
        return [infer_installation(direct, source="Custom path")]

    installations: list[MinecraftInstallation] = []
    stack = [search_root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue

        for entry in entries:
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if not is_directory or entry.is_symlink() or is_reparse_directory(entry):
                continue

            lowered_name = entry.name.casefold()
            child = Path(entry.path)
            if lowered_name == "data" and has_pack_directories(child):
                installations.append(infer_installation(child, source="Discovered"))
                continue
            if lowered_name in SCAN_SKIP_DIRECTORIES:
                continue
            stack.append(child)

    return installations


def local_drive_roots() -> list[Path]:
    drive_mask = ctypes.windll.kernel32.GetLogicalDrives()
    roots: list[Path] = []
    for index in range(26):
        if not drive_mask & (1 << index):
            continue
        root = f"{chr(ord('A') + index)}:\\"
        drive_type = ctypes.windll.kernel32.GetDriveTypeW(root)
        if drive_type in {2, 3}:
            roots.append(Path(root))
    return roots


def discover_preset_installations() -> list[MinecraftInstallation]:
    installations: list[MinecraftInstallation] = []
    for drive_root in local_drive_roots():
        for relative_path, channel in PRESET_INSTALLATION_RELATIVE_PATHS:
            install_location = drive_root / relative_path
            data_directory = direct_data_directory(install_location)
            if data_directory is None:
                continue
            installations.append(
                infer_installation(
                    data_directory,
                    source="Preset path",
                    name=(
                        "Minecraft for Windows"
                        if channel == "stable"
                        else "Minecraft Preview"
                    ),
                    channel=channel,
                )
            )
    return installations


def normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def installation_quality(installation: MinecraftInstallation) -> tuple[int, int, int]:
    source_scores = {
        "Official AppX": 4,
        "LeviLauncher": 3,
        "Preset path": 2,
        "Custom path": 1,
    }
    return (
        source_scores.get(installation.source, 0),
        int(installation.channel is not None),
        int(installation.version != "unknown"),
    )


def deduplicate_installations(
    installations: Sequence[MinecraftInstallation],
) -> list[MinecraftInstallation]:
    unique: dict[str, MinecraftInstallation] = {}
    for installation in installations:
        key = normalized_path(installation.data_directory)
        existing = unique.get(key)
        if existing is None or installation_quality(installation) > installation_quality(
            existing
        ):
            unique[key] = installation

    return sorted(
        unique.values(),
        key=lambda item: (
            item.source,
            item.channel or "",
            tuple(-part for part in version_key(item.version)),
            str(item.install_location).casefold(),
        ),
    )


def discover_known_installations(
    packages: Sequence[dict[str, str]],
) -> list[MinecraftInstallation]:
    installations = discover_official_installations(packages)
    installations.extend(discover_levilauncher_installations())
    installations.extend(discover_preset_installations())
    return deduplicate_installations(installations)


def version_key(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for component in version.split("."):
        try:
            parts.append(int(component))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def enable_virtual_terminal() -> bool:
    standard_output_handle = -11
    virtual_terminal_processing = 0x0004
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.GetStdHandle(standard_output_handle)
    mode = ctypes.c_uint()
    if handle in (0, -1) or not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        return False
    return bool(kernel32.SetConsoleMode(handle, mode.value | virtual_terminal_processing))


T = TypeVar("T")


def choose_menu(title: str, options: Sequence[tuple[str, T]]) -> T:
    if not options:
        raise ToolError("interactive selection has no options")
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ToolError(
            "interactive selection requires a terminal; specify an exact path or "
            "channel and, when needed, an explicit schema branch"
        )

    import msvcrt

    entries: list[tuple[str, T | None]] = [*options, ("Exit", None)]
    selected = 0
    use_ansi = enable_virtual_terminal()
    width = max(40, shutil.get_terminal_size((120, 24)).columns)

    def render(first: bool) -> None:
        if not first:
            if use_ansi:
                sys.stdout.write(f"\x1b[{len(entries)}F")
            else:
                os.system("cls")
                print(title)
        for index, (label, _) in enumerate(entries):
            marker = ">" if index == selected else " "
            available = max(10, width - 4)
            shown = label if len(label) <= available else f"{label[:available - 3]}..."
            prefix = "\x1b[36m" if use_ansi and index == selected else ""
            suffix = "\x1b[0m" if prefix else ""
            clear_line = "\x1b[2K" if use_ansi else ""
            sys.stdout.write(f"{clear_line}{prefix}{marker} {shown}{suffix}\n")
        sys.stdout.flush()

    print(title)
    render(True)
    while True:
        key = msvcrt.getwch()
        if key in {"\x00", "\xe0"}:
            key = msvcrt.getwch()
            if key == "H":
                selected = (selected - 1) % len(entries)
                render(False)
            elif key == "P":
                selected = (selected + 1) % len(entries)
                render(False)
            continue
        if key == "\r":
            value = entries[selected][1]
            print()
            if value is None:
                raise SelectionCancelled
            return value
        if key in {"\x1b", "q", "Q"}:
            print()
            raise SelectionCancelled


def choose_installation(
    installations: Sequence[MinecraftInstallation],
) -> MinecraftInstallation:
    return choose_menu(
        "Select a Minecraft Bedrock installation (Up/Down, Enter):",
        [(installation.menu_label(), installation) for installation in installations],
    )


def validate_branch(branch: str) -> str:
    branch = branch.strip()
    components = branch.replace("\\", "/").split("/")
    if (
        not branch
        or branch.startswith(("/", "-"))
        or branch.endswith(("/", "."))
        or any(component in {"", ".", ".."} for component in components)
        or ".." in branch
        or "@{" in branch
    ):
        raise ToolError(f"invalid schema branch name: {branch!r}")
    return branch


def normalize_github_repository(repository: str) -> str:
    value = repository.strip().rstrip("/")
    if value.startswith("git@github.com:"):
        repository_path = value.removeprefix("git@github.com:")
    else:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https", "ssh"}:
            raise ToolError(
                f"schema repository must be a GitHub URL: {repository!r}"
            )
        if (parsed.hostname or "").casefold() not in {"github.com", "www.github.com"}:
            raise ToolError(
                f"schema repository must be hosted on github.com: {repository!r}"
            )
        repository_path = parsed.path.strip("/")

    if repository_path.endswith(".git"):
        repository_path = repository_path[:-4]
    components = repository_path.split("/")
    if len(components) != 2 or not all(
        GITHUB_COMPONENT_PATTERN.fullmatch(component) for component in components
    ):
        raise ToolError(
            f"schema repository URL must identify owner/repository: {repository!r}"
        )
    return f"https://github.com/{components[0]}/{components[1]}"


def choose_default_schema_branch(installation: MinecraftInstallation) -> str:
    if installation.channel in DEFAULT_BRANCHES:
        return DEFAULT_BRANCHES[installation.channel]
    return choose_menu(
        "The Minecraft channel could not be detected. Select a schema branch:",
        [
            ("stable - latest stable schema export", "stable"),
            ("preview - latest preview schema export", "preview"),
        ],
    )


def resolve_schema_source(
    installation: MinecraftInstallation,
    repository: str | None,
    branch: str | None,
) -> SchemaSource:
    has_custom_repository = bool(repository and repository.strip())
    normalized_repository = normalize_github_repository(
        repository if has_custom_repository else DEFAULT_SCHEMA_REPOSITORY
    )
    if branch and branch.strip():
        selected_branch = validate_branch(branch)
    elif has_custom_repository:
        selected_branch = "main"
    else:
        selected_branch = choose_default_schema_branch(installation)
    return SchemaSource(normalized_repository, selected_branch)


def resolve_installation(args: argparse.Namespace) -> MinecraftInstallation:
    selector = args.source

    if args.path is not None:
        selector = args.path

    if selector is None:
        packages = query_minecraft_packages()
        installations = discover_known_installations(packages)
        if not installations:
            raise ToolError("no Minecraft Bedrock installations were found")
        return choose_installation(installations)

    lowered_selector = selector.casefold()
    if args.path is None and lowered_selector in DEFAULT_BRANCHES:
        packages = query_minecraft_packages()
        installations = deduplicate_installations(
            discover_official_installations(packages, lowered_selector)
        )
        if not installations:
            expected = next(
                name
                for name, channel in OFFICIAL_PACKAGE_CHANNELS.items()
                if channel == lowered_selector
            )
            raise ToolError(
                f"official Minecraft Bedrock {lowered_selector} was not found "
                f"(expected AppX package '{expected}')"
            )
        return max(installations, key=lambda item: version_key(item.version))

    installations = deduplicate_installations(scan_search_root(Path(selector)))
    if not installations:
        raise ToolError(f"no Minecraft Bedrock installations were found under {selector}")
    if len(installations) == 1:
        return replace(installations[0], source="Custom path")
    return choose_installation(installations)


def safe_extract_zip(archive_path: Path, destination: Path) -> Path:
    with ZipFile(archive_path) as archive:
        roots: set[str] = set()
        for member in archive.infolist():
            member_path = PurePosixPath(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ToolError(
                    f"downloaded schema archive contains an unsafe path: "
                    f"{member.filename}"
                )
            if member_path.parts:
                roots.add(member_path.parts[0])

        if len(roots) != 1:
            raise ToolError("downloaded schema archive has an unexpected layout")
        archive.extractall(destination)

    root = destination / next(iter(roots))
    if not root.is_dir():
        raise ToolError("downloaded schema archive has no root directory")
    return root


def download_schema_repository(
    schema_source: SchemaSource, temporary_directory: Path
) -> Path:
    encoded_branch = quote(schema_source.branch, safe="/")
    url = f"{schema_source.repository}/archive/refs/heads/{encoded_branch}.zip"
    archive_path = temporary_directory / "schema-repository.zip"
    extract_directory = temporary_directory / "schema-repository"
    extract_directory.mkdir()

    print(
        f"Downloading schema repository {schema_source.repository} "
        f"branch '{schema_source.branch}'..."
    )
    request = Request(url, headers={"User-Agent": "brarchive-extractor-test-data"})
    try:
        with urlopen(request, timeout=120) as response, archive_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        root = safe_extract_zip(archive_path, extract_directory)
    except HTTPError as error:
        if error.code == 404:
            raise ToolError(
                f"schema branch '{schema_source.branch}' was not found in "
                f"{schema_source.repository}"
            ) from error
        raise ToolError(
            f"GitHub returned HTTP {error.code} for branch "
            f"'{schema_source.branch}'"
        ) from error
    except URLError as error:
        raise ToolError(f"unable to download schema repository: {error.reason}") from error
    except BadZipFile as error:
        raise ToolError("GitHub returned an invalid schema ZIP archive") from error
    except OSError as error:
        raise ToolError(f"unable to store the schema download: {error}") from error

    print(f"Downloaded schema repository from {url}")
    return root


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


@dataclass
class ConflictResolver:
    overwrite_all: bool = False
    noninteractive_hint: str = "run interactively or use --force"

    def should_overwrite(self, source: Path, destination: Path) -> bool:
        if self.overwrite_all:
            return True
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ToolError(
                f"copy conflict at {destination}; {self.noninteractive_hint}"
            )

        print("Copy conflict:")
        print(f"  Source:      {source}")
        print(f"  Destination: {destination}")
        while True:
            answer = input(
                "Overwrite? [y]es, [n]o, [a]ll remaining, [q]uit: "
            ).strip().casefold()
            if answer in {"y", "yes"}:
                return True
            if answer in {"n", "no"}:
                return False
            if answer in {"a", "all"}:
                self.overwrite_all = True
                return True
            if answer in {"q", "quit"}:
                raise SelectionCancelled


def path_exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def files_are_identical(source: Path, destination: Path) -> bool:
    if source.is_symlink() or destination.is_symlink():
        return False
    if not source.is_file() or not destination.is_file():
        return False
    try:
        return filecmp.cmp(source, destination, shallow=False)
    except OSError:
        return False


def copy_entry(
    source: Path,
    destination: Path,
    conflict_resolver: ConflictResolver,
) -> None:
    source_is_directory = source.is_dir() and not source.is_symlink()
    destination_exists = path_exists(destination)

    if source_is_directory and destination_exists:
        if destination.is_dir() and not destination.is_symlink():
            for child in source.iterdir():
                copy_entry(child, destination / child.name, conflict_resolver)
            return
    elif not source_is_directory and destination_exists:
        if files_are_identical(source, destination):
            return

    if destination_exists:
        if not conflict_resolver.should_overwrite(source, destination):
            return
        remove_path(destination)

    destination.parent.mkdir(parents=True, exist_ok=True)
    if source_is_directory:
        shutil.copytree(source, destination)
    else:
        shutil.copy2(source, destination)


def copy_tree(
    source: Path,
    destination: Path,
    conflict_resolver: ConflictResolver,
) -> None:
    copy_entry(source, destination, conflict_resolver)


def resolve_output_path(
    repository_root: Path,
    value: str | None,
    default: str,
) -> Path:
    configured = Path(os.path.expandvars(os.path.expanduser(value or default)))
    if not configured.is_absolute():
        configured = repository_root / configured
    return configured.resolve()


def clear_output_targets(repository_root: Path, targets: Sequence[Path]) -> None:
    repository_root = repository_root.resolve()
    home_directory = Path.home().resolve()
    unique_targets = {target.resolve() for target in targets}

    for target in sorted(unique_targets, key=str):
        filesystem_root = Path(target.anchor)
        if (
            target == filesystem_root
            or target == home_directory
            or home_directory.is_relative_to(target)
            or repository_root == target
            or repository_root.is_relative_to(target)
        ):
            raise ToolError(f"refusing to clear unsafe target: {target}")
        if path_exists(target):
            print(f"Clearing {target}")
            remove_path(target)


def copy_minecraft_packs(
    installation: MinecraftInstallation,
    input_root: Path,
    conflict_resolver: ConflictResolver,
) -> None:
    for directory in PACK_DIRECTORIES:
        source = installation.data_directory / directory
        destination = input_root / directory
        print(f"Copying {source} -> {destination}")
        try:
            copy_tree(source, destination, conflict_resolver)
        except OSError as error:
            raise ToolError(f"unable to copy {directory}: {error}") from error


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if os.name != "nt":
        raise ToolError("this tool supports Windows only")

    config_path = Path(__file__).with_name("config.ini")
    args = apply_config(args, load_config(config_path))
    installation = resolve_installation(args)
    repository_root = Path(__file__).resolve().parents[2]
    input_root = resolve_output_path(
        repository_root, args.minecraft_output, "tests/input"
    )
    schema_root = resolve_output_path(
        repository_root, args.schema_output, "tests/schemas"
    )

    print(f"Selected Minecraft: {installation.menu_label()}")
    schema_source = None
    if not args.no_schema:
        schema_source = resolve_schema_source(
            installation, args.schema_repository, args.branch
        )
        print(f"Selected schema repository: {schema_source.repository}")
        print(f"Selected schema branch: {schema_source.branch}")

    with tempfile.TemporaryDirectory(prefix="brax-test-data-") as temporary:
        downloaded_schema_root = None
        if schema_source is not None:
            downloaded_schema_root = download_schema_repository(
                schema_source, Path(temporary)
            )
        if args.force:
            targets = [input_root]
            if downloaded_schema_root is not None:
                targets.append(schema_root)
            clear_output_targets(repository_root, targets)
        conflict_resolver = ConflictResolver()
        copy_minecraft_packs(installation, input_root, conflict_resolver)
        if downloaded_schema_root is not None:
            print(f"Installing schema repository -> {schema_root}")
            try:
                copy_tree(downloaded_schema_root, schema_root, conflict_resolver)
            except OSError as error:
                raise ToolError(f"unable to install schemas: {error}") from error

    print("Test data preparation completed successfully.")
    print(f"Minecraft packs: {input_root}")
    if schema_source is not None:
        print(f"Schema repository: {schema_source.repository}")
        print(f"Schema branch: {schema_source.branch}")
        print(f"Schemas: {schema_root}")
    else:
        print("Schemas: skipped")
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
