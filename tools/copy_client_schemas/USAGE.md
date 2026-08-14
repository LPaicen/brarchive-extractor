# Copy Client Schemas

This Windows-only helper finds an installed LeviLauncher Minecraft version, locates the mod whose `manifest.json` name is `LLClientSchemaExporter`, and copies the contents of its `data/<game-version>/` export into `tests/schemas`.

Run it from the `brarchive-extractor` repository root:

```powershell
python -m tools.copy_client_schemas
```

When `--path` is omitted, the tool checks LeviLauncher configuration under `%APPDATA%` and `%LOCALAPPDATA%`, plus predefined `LeviMC` roots under `Program Files`, `Program Files (x86)`, the drive root, and `Games` on each local drive. It does not recursively scan entire drives. The tool then lets you select one of the installed Minecraft versions with the arrow keys and Enter. The path must identify LeviLauncher storage or an installed version, not the directory where MSIXVC packages were downloaded.

## Examples

```powershell
# Use a specific LeviLauncher storage directory
python -m tools.copy_client_schemas --path "E:/Program Files/LeviMC/mc/levilauncher.exe"

# Use a specific installed Minecraft version
python -m tools.copy_client_schemas --path "E:/Program Files/LeviMC/mc/levilauncher.exe/versions/1.26.20.04"

# Copy to a repository-relative destination
python -m tools.copy_client_schemas --output tests/client-schemas

# Copy to an absolute destination
python -m tools.copy_client_schemas --output "D:/MinecraftSchemas/client"

# Clear the selected destination before copying
python -m tools.copy_client_schemas --force

# List all arguments
python -m tools.copy_client_schemas --help
```

## Arguments

```text
-p, --path, --minecraft-path PATH
                            LeviLauncher storage, versions, or installed
                            Minecraft version directory
-o, --output PATH          Copy destination; relative paths use the repository
                            root (default: tests/schemas)
-f, --force               Clear the selected output directory before copying
-h, --help                 Show help and list all arguments
```

## Configuration

The tool reads `config.ini` from this directory on startup:

```ini
[copy_client_schemas]
# Leave values empty to use command-line arguments and interactive discovery.
# This must be a LeviLauncher storage, versions, or installed-version directory.
minecraft_path =

# Relative paths are resolved from the brarchive-extractor repository root.
# Absolute paths are also accepted.
output =
```

Empty values preserve command-line and interactive behavior. Command-line arguments take precedence. Relative `output` values are resolved from the `brarchive-extractor` repository root; absolute paths are used as written.

Without `--force`, existing directories are merged and identical files are skipped. When a different file already occupies the same destination, the tool asks whether to overwrite it, keep it, overwrite all remaining conflicts, or quit.

`-f` and `--force` remove the complete selected output directory after the Minecraft version, exporter mod, source export, and source/destination relationship have been validated. The source export is never considered part of the output. This deletion cannot be undone.
