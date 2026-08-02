# brarchive-extractor Usage Guide

[Simplified Chinese](./zh/usage.md)

This guide covers installation, input and output mapping, MCB restoration, JSON formatting, conflict handling, failure policies, and batch operation. See the [brarchive file format](./brarchive-format.md) and [MCB file format](./mcb-format.md) documents for binary details.

The project and npm package are named `brarchive-extractor`; the installed command is `brax`.

## Installation

Node.js 20 or newer is required:

```powershell
npm install
npm run build
npm link
```

Without `npm link`, run the built entry point directly:

```powershell
node .\dist\src\cli.js --help
```

## Basic Usage

Extract one archive without changing MCB payloads:

```powershell
brax .\entities.brarchive
```

Extract and restore MCB payloads with exported BDS schemas:

```powershell
brax .\entities.brarchive --schema .\bds-schema
```

Recursively process all `.brarchive` files in a directory:

```powershell
brax .\input --schema .\bds-schema
```

A directory input is detected automatically, so `--directory` is normally unnecessary. `--no-recursive` limits processing to archives and ordinary files directly under the input directory.

## Output Mapping

A single archive normally writes to `<archive-name>_unpacked` beside the archive:

```text
C:/packs/entities.brarchive
  -> C:/packs/entities_unpacked/zombie.json
```

A directory input normally writes to one sibling `<directory-name>_unpacked` root and never writes generated files into the input tree:

```text
test/input/vanilla/__brarchive/entities.brarchive
  -> test/input_unpacked/vanilla/__brarchive/entities/agent.json
```

Archive entry paths and names remain unchanged. Ordinary files in a directory input, including JSON, NBT, images, and other binary files, are copied using the same relative paths. `--mcb-only` keeps only archive entries and ordinary source files whose magic identifies them as MCB.

`--no-empty-dirs` omits archive output directories when no entry is actually written. This includes structurally empty archives, archives emptied by `--mcb-only`, and archives whose only failed entries are removed by `--discard-failed`. Empty source directories are also omitted. A `--report` file is metadata rather than extracted content, so neither the report nor its directory is written for an otherwise empty archive.

Select another output root with `--output`:

```powershell
brax .\input --output .\result
```

A non-empty output root is rejected by default. `--overwrite` permits using it, preserves unrelated content, and replaces matching files. `-f` or `--force` deletes all content under the output root, recreates the directory, and then starts processing. Deleted content cannot be recovered.

`--force` is mutually exclusive with `--overwrite` and `--in-place`. To avoid deleting input or an active working tree, the tool also refuses to clear a filesystem root, a directory containing the input path, or a directory containing the current working directory.

## In-Place Output

`--in-place` writes directly into the source layout instead of creating an `_unpacked` root:

```powershell
brax .\input --in-place --schema .\bds-schema
```

For a directory input, the input directory is also the output root. Ordinary MCB files are restored at their original paths, and ordinary JSON is rewritten there when `--format-all-json` is enabled. Archive entries still use logical directory mapping, so entries from `input/foo.brarchive` are written under `input/foo/`.

For a single `foo.brarchive`, in-place output is the sibling `foo/` directory. The original `.brarchive` is preserved. `--in-place` cannot be combined with `--output`, `--split-archives`, or `--force`. Because this mode can modify source files, back up the input first.

## Merged and Split Archive Layouts

The default mode merges a same-named archive and directory into one logical tree:

```text
foo.brarchive                 -> output/foo/<parent archive entry>
foo/child.brarchive           -> output/foo/child/<child archive entry>
```

A valid Bedrock brarchive layout is normally complementary: `foo.brarchive` contains files for the current level, while `foo/` contains deeper child archives.

Use `--split-archives` to preserve container boundaries and retain the archive extension as a directory name:

```text
foo.brarchive                 -> output/foo.brarchive/<parent archive entry>
foo/child.brarchive           -> output/foo/child.brarchive/<child archive entry>
```

Conflict detection operates on the final paths for the selected mode, so a merged-mode collision may disappear in split mode.

## Conflict Handling

Normally, a same-named `foo.brarchive` and `foo/` under `__brarchive` are complementary: `foo.brarchive` stores direct files for the current level, while `foo/` stores child brarchives. Valid data therefore has no duplicate target after the logical directory tree is restored.

Damaged, manually modified, or incompatible mixed input can cause multiple contents to map to one target in the selected merged or split mode. The tool plans every destination before writing and applies conflict handling to this invalid overlap.

At a conflict, live progress pauses and the terminal displays:

```text
Output conflict 1/3 (3 conflicts total)
  Destination: C:\result\foo\same.json
  Existing: ...
  Incoming: ...

  o  overwrite       O  overwrite all remaining
  k  keep existing   K  keep all remaining
  c  coexist         C  coexist for all remaining
```

Enter one letter and press Enter:

- `o`: overwrite the existing file for this conflict.
- `k`: keep the existing file and skip the incoming file.
- `c`: keep both and rename the incoming file to `name (1).ext`, incrementing the number as needed.
- `O`, `K`, or `C`: apply the corresponding action to every remaining conflict.

Progress resumes after the decision. If standard input is not an interactive terminal, the tool exits with a `conflict` error rather than guessing. Programmatic callers can provide the `resolveConflict` callback to `run()`.

A destination that must be both a file and a directory is a structural conflict and cannot be resolved by an overwrite choice. The tool reports it as a fatal `conflict` error.

## MCB and Schema Data

Without `--schema`, MCB entries are extracted as their original bytes. With a schema export, successful MCB restorations are written as JSON at the original target path; failures preserve the original MCB by default.

The schema root must contain:

```text
exist.json
contents.json
metadata/json_schemas/
```

These files are generated by [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs) from BDS data. `exist.json` provides export metadata such as version information, and `contents.json` lists exported root content. Both files are required markers for recognizing a schema root. Actual decoding rules come from fields such as `$id`, `title`, `x-format-version`, `x-ordinal-index`, and `x-underlying-type` under `metadata/json_schemas`.

Extract and restore MCB content only:

```powershell
brax .\input --schema .\bds-schema --mcb-only
```

## JSON Formatting

Restored MCB JSON uses two-space indentation by default:

```powershell
brax .\input -s .\bds-schema --json-format pretty
```

Write compact JSON without removable structural whitespace or a trailing newline:

```powershell
brax .\input -s .\bds-schema --json-format compact
```

`--json-format` normally affects only restored MCB output. With `--format-all-json`, ordinary `.json` archive entries and directory source files are also validated and formatted using the selected mode. JavaScript-style line comments (`//`) and block comments (`/* ... */`) are accepted and preserved. Compact mode retains a newline after a line comment when another token follows because removing it would comment out the remaining JSON. Trailing commas and other invalid JSON syntax are still rejected. In pretty mode, configure indentation with `--indent-size 0-10` and `--indent-char space|tab`.

## Failure Policies

By default, the tool:

- continues after a file fails to parse;
- preserves the failed file at its target path using the original bytes;
- classifies the result as incomplete and exits with status `2` after an entry-level issue;
- shows only a concise issue count unless `--list` is used.

`--discard-failed` does not write the current failed file. It never deletes files produced by another input or an earlier run. `--fail-fast` stops after the first parsing failure and always preserves the file that triggered the stop, so `--discard-failed` has no effect when both options are used.

## Progress, Results, and Reports

Detailed progress is enabled by default. In an interactive terminal, the first line shows the current stage and file, the second line tracks the current archive or source-file batch, and the third line tracks the entire extraction task. Both progress bars show a percentage and `current/total`. Use `--no-verbose` to disable them. Redirected output automatically disables live progress to avoid repeated log lines.

The default final output is one concise summary. Use `--list` to show only archive and entry failure details:

```powershell
brax .\input -s .\bds-schema --list
```

Use `--list-all` to include ordinary source-file statistics, every archive result, failure details, and conflict decisions:

```powershell
brax .\input -s .\bds-schema --list-all
```

An archive whose container was unpacked but whose MCB restoration or ordinary JSON formatting had errors is shown as `[INCOMPLETE]`, not `[FAILED]`. `[FAILED]` is reserved for an archive container that could not be parsed. In directory mode the overall result is `[FAILED]` only when every archive fails to unpack; one or more successfully unpacked archives make a mixed result `[INCOMPLETE]`.

`--report` writes `.brarchive-report.json` in each non-empty archive output directory. Report files are logs and are always readable JSON regardless of `--json-format`. With `--no-empty-dirs`, a report is not written for an archive that produced no extracted files.

## Complete Option List

```text
-d, --directory
-r, --recursive
    --no-recursive
-s, --schema <path>
-o, --output <path>
-w, --overwrite
-f, --force
-p, --report
    --verbose
    --no-verbose
-l, --list
-L, --list-all
-j, --json-format <pretty|compact>
-J, --format-all-json
    --indent-size <0-10>
    --indent-char <space|tab>
-F, --fail-fast
-D, --discard-failed
    --mcb-only
    --no-empty-dirs
    --split-archives
-i, --in-place
-h, --help
-v, --version
```

Exit status `0` means complete success. Status `1` means an option, schema, conflict interaction, or other fatal error, or that every input archive failed to unpack. Status `2` means processing was incomplete because of entry-level issues, a partial archive failure, or `--fail-fast`, but not every archive failed to unpack.
