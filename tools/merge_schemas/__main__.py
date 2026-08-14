#!/usr/bin/env python3
"""Merge two schema trees with path- and title-based replacement."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import posixpath
import shutil
import sys
import tempfile
from typing import NoReturn, Sequence
from urllib.parse import quote, unquote, urldefrag, urljoin, urlsplit, urlunsplit

from tools.prepare_test_data.__main__ import (
    ConflictResolver,
    ToolError,
    copy_entry,
    path_exists,
    remove_path,
)


@dataclass(frozen=True)
class MergeStats:
    copied_files: int
    path_replacements: int
    id_replacements: int
    title_replacements: int
    rewritten_references: int
    validated_references: int
    external_references: int
    removed_metadata_files: int


@dataclass(frozen=True)
class SchemaDocument:
    path: Path
    relative_path: Path
    value: dict[str, object]
    title: str | None
    schema_id: str | None
    canonical_id: str | None


@dataclass(frozen=True)
class ReplacementPlan:
    removed_paths: frozenset[Path]
    id_replacements: dict[str, str]
    path_replacements: int
    semantic_id_replacements: int
    title_replacements: int


@dataclass(frozen=True)
class ReferenceValidation:
    local_references: int
    external_references: int


REFERENCE_KEYS = {"$ref", "$dynamicRef", "$recursiveRef"}
COMPOSITE_METADATA_FILES = {"exist.json", "contents.json", "export-report.json"}


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        add_help=False,
        description=(
            "Merge a second schema tree over a first schema tree. Documents "
            "with the same normalized $id are replaced. Same-directory titles "
            "and same relative file paths provide fallback matching. Local "
            "references are rewritten and validated."
        ),
    )
    parser.add_argument(
        "-h",
        "--help",
        action="help",
        help="show this help message and list all arguments",
    )
    parser.add_argument(
        "base_schema",
        metavar="BASE_SCHEMA",
        help="schema root that receives the merge",
    )
    parser.add_argument(
        "merging_schema",
        metavar="MERGING_SCHEMA",
        help="schema root whose files take precedence",
    )
    parser.add_argument(
        "-o",
        "--output",
        metavar="PATH",
        help=(
            "new merged directory; defaults to <BASE_SCHEMA>_merged beside the "
            "base directory"
        ),
    )
    parser.add_argument(
        "-i",
        "--in-place",
        action="store_true",
        help=(
            "replace BASE_SCHEMA with the merged result and delete "
            "MERGING_SCHEMA"
        ),
    )
    args = parser.parse_args(argv)
    if args.in_place and args.output is not None:
        parser.error("--output cannot be used with --in-place")
    return args


def resolve_schema_root(value: str, label: str) -> Path:
    configured = Path(os.path.expandvars(os.path.expanduser(value)))
    try:
        resolved = configured.resolve(strict=True)
    except OSError as error:
        raise ToolError(f"{label} is unavailable: {configured}: {error}") from error
    if not resolved.is_dir():
        raise ToolError(f"{label} is not a directory: {resolved}")
    return resolved


def paths_overlap(first: Path, second: Path) -> bool:
    return (
        first == second
        or first.is_relative_to(second)
        or second.is_relative_to(first)
    )


def validate_source_roots(base_schema: Path, merging_schema: Path) -> None:
    if paths_overlap(base_schema, merging_schema):
        raise ToolError(
            "BASE_SCHEMA and MERGING_SCHEMA must be separate directory trees"
        )


def default_output_path(base_schema: Path) -> Path:
    stem = f"{base_schema.name}_merged"
    candidate = base_schema.with_name(stem)
    suffix = 1
    while path_exists(candidate):
        candidate = base_schema.with_name(f"{stem} ({suffix})")
        suffix += 1
    return candidate


def resolve_output_path(base_schema: Path, value: str | None) -> Path:
    if value is None:
        return default_output_path(base_schema)
    configured = Path(os.path.expandvars(os.path.expanduser(value)))
    return configured.resolve()


def validate_output_path(
    output: Path,
    base_schema: Path,
    merging_schema: Path,
) -> None:
    if path_exists(output):
        raise ToolError(f"output directory already exists: {output}")
    if paths_overlap(output, base_schema) or paths_overlap(output, merging_schema):
        raise ToolError(
            "output must be outside both input schema directory trees: "
            f"{output}"
        )


def iter_files(root: Path) -> list[Path]:
    try:
        return sorted(
            (path for path in root.rglob("*") if path.is_file()),
            key=lambda path: path.relative_to(root).as_posix().casefold(),
        )
    except OSError as error:
        raise ToolError(f"unable to scan schema directory {root}: {error}") from error


def normalized_parent(relative_path: Path) -> str:
    return relative_path.parent.as_posix().casefold()


def normalized_relative(relative_path: Path) -> str:
    return relative_path.as_posix().casefold()


def canonical_schema_id(value: str, base: str | None = None) -> str:
    document_id, _ = urldefrag(value.replace("\\", "/"))
    resolved = urljoin(base or "", document_id)
    parts = urlsplit(resolved)
    decoded_path = unquote(parts.path).replace("\\", "/")
    normalized_path = posixpath.normpath(decoded_path)
    if normalized_path == ".":
        normalized_path = ""

    if parts.scheme or parts.netloc:
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                normalized_path,
                parts.query,
                "",
            )
        )

    if not normalized_path.startswith("/"):
        normalized_path = f"/{normalized_path}"
    return urlunsplit(("", "", normalized_path.casefold(), parts.query, ""))


def encoded_schema_id(value: str) -> str:
    parts = urlsplit(value)
    encoded_path = quote(
        parts.path,
        safe="/:@-._~!$&'()*+,;=",
    )
    return urlunsplit(
        (parts.scheme, parts.netloc, encoded_path, parts.query, "")
    )


def read_json_object(path: Path) -> dict[str, object] | None:
    if path.suffix.casefold() != ".json":
        return None
    try:
        with path.open("r", encoding="utf-8-sig") as schema_file:
            value = json.load(schema_file)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def load_schema_documents(root: Path, files: Sequence[Path]) -> list[SchemaDocument]:
    documents: list[SchemaDocument] = []
    for path in files:
        value = read_json_object(path)
        if value is None:
            continue
        title_value = value.get("title")
        title = (
            title_value.strip()
            if isinstance(title_value, str) and title_value.strip()
            else None
        )
        id_value = value.get("$id")
        schema_id = (
            id_value.strip()
            if isinstance(id_value, str) and id_value.strip()
            else None
        )
        documents.append(
            SchemaDocument(
                path=path,
                relative_path=path.relative_to(root),
                value=value,
                title=title,
                schema_id=schema_id,
                canonical_id=(
                    canonical_schema_id(schema_id)
                    if schema_id is not None
                    else None
                ),
            )
        )
    return documents


def build_id_index(
    documents: Sequence[SchemaDocument],
    label: str,
) -> dict[str, SchemaDocument]:
    index: dict[str, SchemaDocument] = {}
    for document in documents:
        if document.canonical_id is None:
            continue
        existing = index.get(document.canonical_id)
        if existing is not None:
            raise ToolError(
                f"duplicate normalized $id in {label}: {document.schema_id!r}: "
                f"{existing.path} and {document.path}"
            )
        index[document.canonical_id] = document
    return index


def build_title_index(
    documents: Sequence[SchemaDocument],
) -> dict[tuple[str, str], list[SchemaDocument]]:
    index: dict[tuple[str, str], list[SchemaDocument]] = {}
    for document in documents:
        if document.title is None:
            continue
        key = (normalized_parent(document.relative_path), document.title)
        index.setdefault(key, []).append(document)
    return index


def build_relative_file_index(
    root: Path,
    files: Sequence[Path],
    label: str,
) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for path in files:
        relative_path = path.relative_to(root)
        key = normalized_relative(relative_path)
        existing = index.get(key)
        if existing is not None:
            raise ToolError(
                f"case-insensitive path collision in {label}: "
                f"{existing} and {path}"
            )
        index[key] = path
    return index


def build_replacement_plan(
    base_schema: Path,
    merging_schema: Path,
) -> tuple[ReplacementPlan, list[Path]]:
    base_files = iter_files(base_schema)
    merging_files = iter_files(merging_schema)
    base_documents = load_schema_documents(base_schema, base_files)
    merging_documents = load_schema_documents(merging_schema, merging_files)
    base_by_id = build_id_index(base_documents, "BASE_SCHEMA")
    merging_by_id = build_id_index(merging_documents, "MERGING_SCHEMA")
    base_by_relative = {
        normalized_relative(document.relative_path): document
        for document in base_documents
    }
    merging_by_relative = {
        normalized_relative(document.relative_path): document
        for document in merging_documents
    }
    base_file_paths = build_relative_file_index(
        base_schema,
        base_files,
        "BASE_SCHEMA",
    )
    merging_file_paths = build_relative_file_index(
        merging_schema,
        merging_files,
        "MERGING_SCHEMA",
    )
    path_replacements = len(base_file_paths.keys() & merging_file_paths.keys())

    replacements: dict[str, tuple[int, str, SchemaDocument]] = {}

    def assign(
        base_document: SchemaDocument,
        merging_document: SchemaDocument,
        priority: int,
        reason: str,
    ) -> None:
        key = normalized_relative(base_document.relative_path)
        existing = replacements.get(key)
        if existing is None or priority > existing[0]:
            replacements[key] = (priority, reason, merging_document)

    for relative_path in base_file_paths.keys() & merging_file_paths.keys():
        base_document = base_by_relative.get(relative_path)
        merging_document = merging_by_relative.get(relative_path)
        if base_document is None:
            continue
        if base_document.schema_id is not None and (
            merging_document is None or merging_document.schema_id is None
        ):
            raise ToolError(
                "a same-path replacement would remove a schema $id: "
                f"{base_document.path}"
            )
        if merging_document is not None:
            assign(base_document, merging_document, 1, "path")

    base_titles = build_title_index(base_documents)
    merging_titles = build_title_index(merging_documents)
    for key, values in merging_titles.items():
        if len(values) > 1:
            paths = ", ".join(str(value.path) for value in values)
            raise ToolError(
                "MERGING_SCHEMA has an ambiguous title in one directory: "
                f"{key[1]!r}: {paths}"
            )
        merging_document = values[0]
        for base_document in base_titles.get(key, []):
            assign(base_document, merging_document, 2, "title")

    for schema_id, base_document in base_by_id.items():
        merging_document = merging_by_id.get(schema_id)
        if merging_document is not None:
            assign(base_document, merging_document, 3, "id")

    removed_paths: set[Path] = set()
    id_replacements: dict[str, str] = {}
    id_replacement_count = 0
    title_replacement_count = 0
    for relative_key, (_, reason, merging_document) in replacements.items():
        base_document = base_by_relative[relative_key]
        if normalized_relative(base_document.relative_path) != normalized_relative(
            merging_document.relative_path
        ):
            removed_paths.add(base_document.relative_path)
            if reason == "id":
                id_replacement_count += 1
            elif reason == "title":
                title_replacement_count += 1

        if base_document.canonical_id is None:
            continue
        if merging_document.canonical_id is None:
            raise ToolError(
                "a semantic replacement would remove a schema $id without a "
                f"replacement $id: {base_document.path} -> {merging_document.path}"
            )
        if base_document.canonical_id == merging_document.canonical_id:
            continue
        existing_target = id_replacements.get(base_document.canonical_id)
        if (
            existing_target is not None
            and existing_target != merging_document.canonical_id
        ):
            raise ToolError(
                f"schema $id {base_document.schema_id!r} maps to multiple "
                "replacement IDs"
            )
        id_replacements[base_document.canonical_id] = merging_document.canonical_id

    return (
        ReplacementPlan(
            removed_paths=frozenset(removed_paths),
            id_replacements=id_replacements,
            path_replacements=path_replacements,
            semantic_id_replacements=id_replacement_count,
            title_replacements=title_replacement_count,
        ),
        merging_files,
    )


def resolve_reference_id(reference: str, current_id: str) -> tuple[str, str]:
    reference_part, fragment = urldefrag(reference)
    target = (
        current_id
        if reference_part == ""
        else canonical_schema_id(reference_part, current_id)
    )
    return target, fragment


def rewrite_reference_values(
    value: object,
    current_id: str,
    id_replacements: dict[str, str],
) -> int:
    rewritten = 0
    if isinstance(value, dict):
        for key, child in value.items():
            if key in REFERENCE_KEYS and isinstance(child, str):
                target_id, fragment = resolve_reference_id(child, current_id)
                replacement = id_replacements.get(target_id)
                if replacement is not None:
                    value[key] = encoded_schema_id(replacement) + (
                        f"#{fragment}" if fragment else ""
                    )
                    rewritten += 1
                    child = value[key]
            rewritten += rewrite_reference_values(
                child,
                current_id,
                id_replacements,
            )
    elif isinstance(value, list):
        for child in value:
            rewritten += rewrite_reference_values(
                child,
                current_id,
                id_replacements,
            )
    return rewritten


def schema_content_root(root: Path) -> Path:
    standard = root / "metadata" / "json_schemas"
    return standard if standard.is_dir() else root


def load_output_documents(root: Path) -> list[SchemaDocument]:
    content_root = schema_content_root(root)
    files = [
        path
        for path in iter_files(content_root)
        if path.suffix.casefold() == ".json"
    ]
    documents: list[SchemaDocument] = []
    for path in files:
        try:
            with path.open("r", encoding="utf-8-sig") as schema_file:
                value = json.load(schema_file)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ToolError(f"unable to parse merged schema file {path}: {error}") from error
        if not isinstance(value, dict):
            continue
        id_value = value.get("$id")
        if not isinstance(id_value, str) or not id_value.strip():
            continue
        title_value = value.get("title")
        documents.append(
            SchemaDocument(
                path=path,
                relative_path=path.relative_to(content_root),
                value=value,
                title=(
                    title_value.strip()
                    if isinstance(title_value, str) and title_value.strip()
                    else None
                ),
                schema_id=id_value.strip(),
                canonical_id=canonical_schema_id(id_value.strip()),
            )
        )
    return documents


def rewrite_output_references(
    root: Path,
    id_replacements: dict[str, str],
) -> int:
    if not id_replacements:
        return 0
    rewritten = 0
    for document in load_output_documents(root):
        assert document.canonical_id is not None
        changed = rewrite_reference_values(
            document.value,
            document.canonical_id,
            id_replacements,
        )
        if changed == 0:
            continue
        try:
            document.path.write_text(
                json.dumps(document.value, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError as error:
            raise ToolError(
                f"unable to write rewritten schema references: {document.path}: {error}"
            ) from error
        rewritten += changed
    return rewritten


def resolve_json_pointer(value: object, fragment: str, reference: str) -> None:
    decoded_fragment = unquote(fragment)
    if decoded_fragment == "":
        return
    if not decoded_fragment.startswith("/"):
        if find_anchor(value, decoded_fragment):
            return
        raise ToolError(f"schema anchor does not exist: {reference}")

    current = value
    for encoded_part in decoded_fragment[1:].split("/"):
        part = encoded_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdecimal():
            index = int(part)
            if index >= len(current):
                raise ToolError(f"schema fragment does not exist: {reference}")
            current = current[index]
        else:
            raise ToolError(f"schema fragment does not exist: {reference}")


def find_anchor(value: object, anchor: str) -> bool:
    if isinstance(value, dict):
        if value.get("$anchor") == anchor or value.get("$dynamicAnchor") == anchor:
            return True
        return any(find_anchor(child, anchor) for child in value.values())
    if isinstance(value, list):
        return any(find_anchor(child, anchor) for child in value)
    return False


def iter_references(value: object) -> list[tuple[str, str]]:
    references: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in REFERENCE_KEYS and isinstance(child, str):
                references.append((key, child))
            references.extend(iter_references(child))
    elif isinstance(value, list):
        for child in value:
            references.extend(iter_references(child))
    return references


def validate_schema_graph(root: Path) -> ReferenceValidation:
    documents = load_output_documents(root)
    by_id = build_id_index(documents, "merged result")
    local_references = 0
    external_references = 0
    for document in documents:
        assert document.canonical_id is not None
        for _, reference in iter_references(document.value):
            target_id, fragment = resolve_reference_id(
                reference,
                document.canonical_id,
            )
            target = by_id.get(target_id)
            if target is None:
                if urlsplit(target_id).scheme:
                    external_references += 1
                    continue
                raise ToolError(
                    "referenced schema does not exist in merged result: "
                    f"{reference!r} from {document.path}"
                )
            resolve_json_pointer(target.value, fragment, reference)
            local_references += 1
    return ReferenceValidation(local_references, external_references)


def remove_composite_metadata(root: Path) -> int:
    removed = 0
    for child in root.iterdir():
        if child.name.casefold() not in COMPOSITE_METADATA_FILES:
            continue
        if path_exists(child):
            remove_path(child)
            removed += 1
    return removed


def apply_merging_schema(
    base_schema: Path,
    merging_schema: Path,
    destination: Path,
) -> MergeStats:
    plan, merging_files = build_replacement_plan(base_schema, merging_schema)
    for relative_path in plan.removed_paths:
        target = destination / relative_path
        if path_exists(target):
            remove_path(target)

    resolver = ConflictResolver(overwrite_all=True)
    try:
        for child in merging_schema.iterdir():
            copy_entry(child, destination / child.name, resolver)
    except OSError as error:
        raise ToolError(f"unable to merge schema files: {error}") from error

    removed_metadata = remove_composite_metadata(destination)
    rewritten_references = rewrite_output_references(
        destination,
        plan.id_replacements,
    )
    validation = validate_schema_graph(destination)

    return MergeStats(
        copied_files=len(merging_files),
        path_replacements=plan.path_replacements,
        id_replacements=plan.semantic_id_replacements,
        title_replacements=plan.title_replacements,
        rewritten_references=rewritten_references,
        validated_references=validation.local_references,
        external_references=validation.external_references,
        removed_metadata_files=removed_metadata,
    )


def stage_merged_tree(
    base_schema: Path,
    merging_schema: Path,
    destination: Path,
) -> MergeStats:
    try:
        shutil.copytree(base_schema, destination, symlinks=True)
        return apply_merging_schema(base_schema, merging_schema, destination)
    except Exception:
        if path_exists(destination):
            remove_path(destination)
        raise


def merge_to_new_directory(
    base_schema: Path,
    merging_schema: Path,
    output: Path,
) -> MergeStats:
    validate_output_path(output, base_schema, merging_schema)
    output.parent.mkdir(parents=True, exist_ok=True)
    return stage_merged_tree(base_schema, merging_schema, output)


def merge_in_place(base_schema: Path, merging_schema: Path) -> MergeStats:
    try:
        with tempfile.TemporaryDirectory(
            prefix=f".{base_schema.name}-merge-",
            dir=base_schema.parent,
        ) as temporary:
            temporary_root = Path(temporary)
            staged = temporary_root / "merged"
            backup = temporary_root / "original"
            stats = stage_merged_tree(base_schema, merging_schema, staged)

            try:
                base_schema.rename(backup)
                staged.rename(base_schema)
            except OSError as error:
                if not path_exists(base_schema) and path_exists(backup):
                    backup.rename(base_schema)
                raise ToolError(
                    f"unable to replace base schema directory: {error}"
                ) from error

            try:
                remove_path(merging_schema)
            except OSError as error:
                raise ToolError(
                    "the base schema was merged, but the merging schema could not "
                    f"be deleted: {merging_schema}: {error}"
                ) from error
            return stats
    except OSError as error:
        raise ToolError(f"unable to stage the in-place merge: {error}") from error


def print_summary(
    stats: MergeStats,
    destination: Path,
    *,
    merging_schema_deleted: bool,
) -> None:
    print("Schema merge completed successfully.")
    print(f"Merged files: {stats.copied_files}")
    print(f"Same-path replacements: {stats.path_replacements}")
    print(f"Same-$id replacements: {stats.id_replacements}")
    print(f"Same-title replacements: {stats.title_replacements}")
    print(f"Rewritten references: {stats.rewritten_references}")
    print(f"Validated local references: {stats.validated_references}")
    print(f"Unvalidated external references: {stats.external_references}")
    print(f"Removed composite metadata files: {stats.removed_metadata_files}")
    print(f"Result: {destination}")
    if merging_schema_deleted:
        print("Merging schema directory: deleted")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    base_schema = resolve_schema_root(args.base_schema, "BASE_SCHEMA")
    merging_schema = resolve_schema_root(args.merging_schema, "MERGING_SCHEMA")
    validate_source_roots(base_schema, merging_schema)

    print(f"Base schema: {base_schema}")
    print(f"Merging schema: {merging_schema}")
    if args.in_place:
        print("Mode: in-place")
        stats = merge_in_place(base_schema, merging_schema)
        print_summary(
            stats,
            base_schema,
            merging_schema_deleted=True,
        )
        return 0

    output = resolve_output_path(base_schema, args.output)
    print(f"Mode: new directory ({output})")
    stats = merge_to_new_directory(base_schema, merging_schema, output)
    print_summary(stats, output, merging_schema_deleted=False)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        raise SystemExit(130)
    except ToolError as error:
        fail(str(error))
