# brarchive File Format

[Simplified Chinese](./zh/brarchive-format.md)

This document describes the Minecraft Bedrock `.brarchive` binary layout verified by this tool and the current fixture set. All multibyte integers are little-endian. This repository does not rely on an official public specification for the format, so version changes must be checked against actual files and game behavior.

## Overall Layout

```text
+----------------------+ 0x00
| Fixed header, 16 B   |
+----------------------+ 0x10
| Entry record 0, 256 B|
+----------------------+
| Entry record 1, 256 B|
+----------------------+
| ...                  |
+----------------------+ data_base = 16 + entry_count * 256
| Entry data region    |
+----------------------+
```

The file contains a fixed header, a fixed-width index table, and a data region. Data offsets in index records are relative to the start of the data region, not to the beginning of the file.

## File Header

| File offset | Size | Type | Meaning |
|---:|---:|---|---|
| `0x00` | 8 | bytes | Magic `7D 27 25 B1 A0 52 70 26` |
| `0x08` | 4 | `uint32 LE` | Number of entries, `entry_count` |
| `0x0C` | 4 | `uint32 LE` | brarchive version |

The index table immediately follows the header and occupies `entry_count * 256` bytes.

## 256-Byte Entry Record

Each record starts at `record_offset = 16 + index * 256`:

| Record offset | Size | Type | Meaning |
|---:|---:|---|---|
| `0x00` | 1 | `uint8` | UTF-8 byte length of the file name, at most 247 |
| `0x01` | 247 | bytes | File-name buffer; only the prefix selected by the length is significant |
| `0xF8` | 4 | `uint32 LE` | Data offset relative to the start of the data region |
| `0xFC` | 4 | `uint32 LE` | Entry data length |

The absolute payload range is calculated as:

```text
data_base      = 16 + entry_count * 256
absolute_start = data_base + relative_offset
absolute_end   = absolute_start + length
```

The bytes in `[absolute_start, absolute_end)` are the unmodified entry payload. The current record format does not contain an entry compression algorithm, checksum, timestamp, or permission data, and the tool has not observed a uniform entry-level compression layer.

## Path Rules

The file name is UTF-8 and may contain `/` to represent subdirectories. The extractor rejects:

- empty names and invalid UTF-8;
- absolute paths;
- NUL characters;
- `..` path traversal;
- duplicate names within one archive after case-insensitive comparison;
- data ranges outside the archive data region or file bounds.

## Relationship Between `foo.brarchive` and `foo/`

Bedrock data commonly contains both:

```text
foo.brarchive
foo/
  child.brarchive
```

Current fixtures show that these are complementary fragments of one logical resource tree, not duplicate copies:

- `foo.brarchive` stores direct files for the `foo` level.
- `foo/` stores the next directory level, with child levels represented by child `.brarchive` files.
- Some parent archives contain no entries and only establish a hierarchy level.
- The complete directory tree appears only after all levels are merged.

The local fixture set contains 115 archives, 2,305 archive entries, 958 ordinary source files, and 23 same-named archive/directory pairs. Virtual extraction produces 3,263 targets in either merged or split mode. Neither mode has an exact-name collision or a file/directory conflict in the fixture set. Valid generated brarchive trees should therefore normally be conflict-free; interactive conflict handling protects against damaged archives, manual changes, mixed versions, and existing output files.

The default output mode restores the logical tree:

```text
foo.brarchive       -> output/foo/<entry>
foo/bar.brarchive   -> output/foo/bar/<entry>
```

`--split-archives` preserves container boundaries:

```text
foo.brarchive       -> output/foo.brarchive/<entry>
foo/bar.brarchive   -> output/foo/bar.brarchive/<entry>
```

`--in-place` restores the source-side logical tree. A directory input uses itself as the output root, while a single `foo.brarchive` writes into its sibling `foo/` directory. The archive is not deleted. Because a file path named `foo.brarchive` cannot also be an output directory, `--in-place` and `--split-archives` are mutually exclusive.

Conflict detection always operates on the final target paths for the selected mode.

## Parsing Pseudocode

```text
assert file[0:8] == magic
entry_count = u32le(file, 8)
version     = u32le(file, 12)
data_base   = 16 + entry_count * 256

for i in 0 .. entry_count-1:
    record        = 16 + i * 256
    name_length   = u8(file, record)
    name          = utf8(file[record+1 : record+1+name_length])
    relative      = u32le(file, record+248)
    length        = u32le(file, record+252)
    payload       = file[data_base+relative : data_base+relative+length]
```

A parser must validate every multiplication, addition, and boundary before slicing. Entry counts, offsets, and lengths cannot be trusted.
