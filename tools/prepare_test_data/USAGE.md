# Prepare Test Data

This Windows-only helper finds a Minecraft Bedrock installation, copies its vanilla `behavior_packs` and `resource_packs` into `tests/input`, and downloads a GitHub schema repository into `tests/schemas` unless `--no-schema` is used.

Run it from the repository root:

```powershell
python -m tools.prepare_test_data
```

With no source argument, the tool checks registered official AppX packages, LeviLauncher configuration locations, and a small set of predefined installation paths. It does not recursively scan entire drives. Use the arrow keys and Enter to select an installation or exit.

The predefined paths include the Xbox app's `XboxGames/Minecraft for Windows/Content` and `XboxGames/Minecraft Preview for Windows/Content` layouts, plus common LeviLauncher roots under `Program Files/LeviMC`, `Program Files (x86)/LeviMC`, `LeviMC`, and `Games/LeviMC` on each local drive. Paths recorded in LeviLauncher `config.json` files under `%APPDATA%` or `%LOCALAPPDATA%` are also checked.

An explicitly supplied `SOURCE` directory or `--path` remains recursive, but its search is limited to that directory.

## Examples

```powershell
# Official release or preview
python -m tools.prepare_test_data stable
python -m tools.prepare_test_data preview

# Search a specific directory
python -m tools.prepare_test_data --path "D:/Minecraft"

# Copy only Minecraft packs
python -m tools.prepare_test_data preview --no-schema

# Select separate repository-relative destinations
python -m tools.prepare_test_data stable `
  --minecraft-output tests/input `
  --schema-output tests/schemas

# Download schemas from another GitHub repository
python -m tools.prepare_test_data --path "D:/Minecraft" `
  --schema-repository "https://github.com/owner/schema-repository" `
  --branch main

# Clear the selected destinations before copying
python -m tools.prepare_test_data stable --force

# List all arguments
python -m tools.prepare_test_data --help
```

## Arguments

```text
SOURCE                      Official channel (stable/preview) or a directory
                            to search
-p, --path PATH             Directory to search for Minecraft installations
-r, --schema-repository URL,
    --schema-repo URL        GitHub schema repository URL
-b, --branch NAME           Schema repository branch
-m, --minecraft-output PATH Minecraft pack destination; relative paths use the
                            repository root (default: tests/input)
-s, --schema-output PATH    Schema destination; relative paths use the
                            repository root (default: tests/schemas)
-n, --no-schema             Copy Minecraft packs without downloading schemas
-f, --force                 Clear selected destinations before copying
-h, --help                  Show help and list all arguments
```

`--schema-repository` accepts an HTTPS, SSH, or `git@github.com:` repository URL. A custom repository uses the `main` branch when `--branch` is omitted. The built-in `bedrock-apis/bds-docs` source selects `stable` or `preview` from the detected Minecraft channel.

## Configuration

The tool reads `config.ini` from this directory on startup:

```ini
[prepare_test_data]
# Leave values empty to use command-line arguments and interactive discovery.
# May be stable, preview, or a directory path.
minecraft_source =

# Any GitHub repository URL containing the schema files.
schema_repository =

# Leave empty for main when schema_repository is set. The built-in bds-docs
# repository instead selects stable or preview from the Minecraft channel.
schema_branch =

# Relative paths are resolved from the brarchive-extractor repository root.
# Absolute paths are also accepted.
minecraft_output =
schema_output =

# Set to true to copy Minecraft packs without downloading schemas.
no_schema =
```

`minecraft_source` may contain `stable`, `preview`, or a search path. Set `no_schema` to `true` to skip the schema download. Empty values do not override command-line behavior, and command-line arguments take precedence. Relative output paths are resolved from the `brarchive-extractor` repository root; absolute paths are used as written.

## Existing Files

Without `--force`, directories are merged and identical files are skipped. For a different file at the same destination, choose whether to overwrite it, keep it, overwrite all remaining conflicts, or quit.

`-f` and `--force` remove the complete selected destination directories after any requested schema download succeeds, then copy fresh data. With `--no-schema`, only the Minecraft destination is cleared. This deletion cannot be undone.
