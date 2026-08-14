# Merge Schemas

This helper merges two schema directory trees. The first directory is the base schema and the second directory is the merging schema whose files take precedence. The complete result is staged and validated before it is kept or installed in place.

Schema identity is evaluated in this order:

- The normalized top-level `$id` is the same. `$id` comparison decodes URI escapes and applies case-insensitive path matching compatible with `brarchive-extractor`.
- They are JSON objects in the same relative directory and have the same non-empty top-level `title`, even when their filenames differ.
- They have the same case-insensitive relative file path.

For a semantic replacement with different filenames, the old base file is removed and the merging schema's filename and content are retained. Files without a readable top-level `$id` or `title`, including non-JSON files, participate only in same-path replacement.

## References and Validation

When a replaced schema changes `$id`, the tool builds an old-to-new ID map and rewrites local `$ref`, `$dynamicRef`, and `$recursiveRef` values throughout the merged result. Rewritten references use the new absolute schema ID and preserve their original fragment.

Before the merge is accepted, the tool checks:

- normalized `$id` values are unique;
- case-insensitive relative paths are unique in each input;
- every local reference resolves to a merged schema;
- JSON Pointer fragments and named anchors exist;
- one merging directory does not contain multiple same-directory schemas with the same title.

References to an absolute external URI are retained but cannot be validated without fetching the remote resource. Their count is shown in the result summary. Schema keyword semantics and JSON Schema dialect compatibility are not evaluated.

Root-level `exist.json`, `contents.json`, and `export-report.json` are removed from the result because their version and inventory describe one source export rather than the combined schema set. Consequently, `brarchive-extractor` reports the merged export version as unknown.

Only JSON files whose references are rewritten are reformatted, using two-space indentation. Other copied files retain their original bytes.

## Usage

Run the tool from the `brarchive-extractor` repository root:

```powershell
python -m tools.merge_schemas BASE_SCHEMA MERGING_SCHEMA
```

By default, both input directories are preserved and the result is written beside `BASE_SCHEMA` as `<BASE_SCHEMA>_merged`. If that automatically selected name already exists, the tool adds ` (1)`, ` (2)`, and so on.

## Examples

```powershell
# Preserve both inputs and create schemas-stable_merged
python -m tools.merge_schemas "D:/schemas-stable" "D:/schemas-client"

# Select a new output directory explicitly
python -m tools.merge_schemas "D:/schemas-stable" "D:/schemas-client" `
  --output "D:/schemas-combined"

# Replace the first directory and delete the second directory after success
python -m tools.merge_schemas "D:/schemas-stable" "D:/schemas-client" --in-place

# List all arguments
python -m tools.merge_schemas --help
```

## Arguments

```text
BASE_SCHEMA                Schema root that receives the merge
MERGING_SCHEMA             Schema root whose files take precedence
-o, --output PATH          New result directory; defaults to
                            <BASE_SCHEMA>_merged beside BASE_SCHEMA
-i, --in-place             Replace BASE_SCHEMA with the merged result and
                            delete MERGING_SCHEMA
-h, --help                 Show help and list all arguments
```

`--output` and `--in-place` cannot be used together. An explicit output directory must not already exist and must be outside both input trees.

The in-place mode stages and validates the complete merged result before replacing `BASE_SCHEMA`. `MERGING_SCHEMA` is deleted only after the replacement succeeds. A validation failure leaves both inputs unchanged. A successful in-place merge is destructive and cannot be undone.
