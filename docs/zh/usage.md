# brarchive-extractor 使用手册

[English](../usage.md)

本文档介绍安装、输入输出映射、MCB 还原、JSON 格式化、冲突处理、失败策略和批量模式。brarchive 与 MCB 的二进制细节分别见 [brarchive 文件格式](./brarchive-format.md) 和 [MCB 文件格式](./mcb-format.md)。

项目和 npm 包名为 `brarchive-extractor`，安装后的命令名为 `brax`。

## 安装

运行环境要求 Node.js 20 或更高版本：

```powershell
npm install
npm run build
npm link
```

不执行 `npm link` 时可以直接运行：

```powershell
node .\dist\src\cli.js --help
```

## 基本用法

仅解包单个归档：

```powershell
brax .\entities.brarchive
```

解包并用 BDS schema 还原 MCB：

```powershell
brax .\entities.brarchive --schema .\bds-schema
```

递归处理目录中的全部 `.brarchive`：

```powershell
brax .\input --schema .\bds-schema
```

目录输入会被自动识别，通常不必显式指定 `--directory`。使用 `--no-recursive` 时只处理输入目录第一层的归档和普通文件。

## 输出目录映射

单归档默认输出到归档旁边的 `<归档名>_unpacked`：

```text
C:/packs/entities.brarchive
  -> C:/packs/entities_unpacked/zombie.json
```

目录输入默认输出到输入目录旁边的 `<输入目录名>_unpacked`，不会写入输入树：

```text
test/input/vanilla/__brarchive/entities.brarchive
  -> test/input_unpacked/vanilla/__brarchive/entities/agent.json
```

归档内部条目的相对路径和文件名保持不变。目录输入中的普通文件也按相对路径复制到输出根；其中包括 JSON、NBT、图片和其他非 JSON 文件。`--mcb-only` 模式只保留魔数为 MCB 的归档条目和普通源文件，其余内容全部忽略。

使用 `--output` 可以指定其他输出根：

```powershell
brax .\input --output .\result
```

输出根存在且非空时默认拒绝处理。`--overwrite` 允许使用非空输出根，保留其中的其他内容并覆盖同名文件。`-f` 或 `--force` 会先删除输出根中的全部内容、重新创建输出目录，然后开始处理；删除内容不可恢复。

`--force` 与 `--overwrite`、`--in-place` 互斥。为避免删除输入或正在使用的工作目录，工具还会拒绝清理文件系统根目录、包含输入路径的目录，以及包含当前工作目录的目录。

## 原位写入

`--in-place` 不创建 `_unpacked` 输出根，而是直接写入源结构：

```powershell
brax .\input --in-place --schema .\bds-schema
```

目录输入的输出根就是输入目录。普通 MCB 会在原路径还原为 JSON；使用 `--format-all-json` 时普通 JSON 也会在原路径重写。归档仍按逻辑目录映射，例如 `input/foo.brarchive` 的条目写入 `input/foo/`。

单个 `foo.brarchive` 使用原位模式时写入同级 `foo/` 目录，原 `.brarchive` 文件不会删除。`--in-place` 不能与 `--output`、`--split-archives` 或 `--force` 同时使用。该模式会直接修改数据，运行前应备份输入。

## 合并与拆分归档层级

默认模式把同名归档和目录合并成一棵逻辑树：

```text
foo.brarchive                 -> output/foo/<父归档条目>
foo/child.brarchive           -> output/foo/child/<子归档条目>
```

合法的 Bedrock brarchive 布局通常是互补的：`foo.brarchive` 保存当前层文件，`foo/` 保存更深层的子归档，因此不会产生同名目标。

需要保持容器边界时使用 `--split-archives`。归档扩展名会作为目录名保留：

```text
foo.brarchive                 -> output/foo.brarchive/<父归档条目>
foo/child.brarchive           -> output/foo/child.brarchive/<子归档条目>
```

冲突检测使用当前模式生成的最终目标路径，因此某些默认模式冲突在拆分模式下会自然消失。

## 冲突处理

通常情况下，`__brarchive` 中同名的 `foo.brarchive` 与 `foo/` 是互补的：`foo.brarchive` 保存当前层的直接文件，`foo/` 保存下一级 brarchive。合法数据在恢复逻辑目录树时不会出现同名目标。

如果输入损坏、经过手工修改或混合了不兼容的数据，多个内容可能在当前合并或拆分模式下映射到同一目标。工具会在写文件前预计算这些目标路径，并对这种不合法的重叠执行冲突处理。

遇到冲突时，实时进度会暂停并显示：

```text
Output conflict 1/3 (3 conflicts total)
  Destination: C:\result\foo\same.json
  Existing: ...
  Incoming: ...

  o  overwrite       O  overwrite all remaining
  k  keep existing   K  keep all remaining
  c  coexist         C  coexist for all remaining
```

输入一个字母并回车：

- `o`：当前新文件覆盖现有文件；
- `k`：保留现有文件，跳过当前新文件；
- `c`：两者共存，当前新文件改名为 `name (1).ext`，必要时继续使用 `(2)`、`(3)`；
- `O`、`K`、`C`：对应策略应用到后续所有冲突，不再逐项询问。

交互完成后进度条会恢复。标准输入不是交互式终端时，工具不会猜测策略，而是以 `conflict` 错误退出。程序化调用 `run()` 时可通过 `resolveConflict` 回调提供策略。

如果一个目标同时必须是文件和目录，这不是普通的同名文件冲突，无法通过覆盖策略安全解决，工具会直接报告 `conflict` 错误。

## MCB 和 schema

不提供 `--schema` 时，MCB 按原始字节解包。提供 schema 后，成功还原的 MCB 会在原目标路径写成 JSON；失败时默认保留原始 MCB。

schema 根目录必须包含：

```text
exist.json
contents.json
metadata/json_schemas/
```

这些文件由 [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs) 从 BDS 导出数据生成。`exist.json` 提供导出版本等元数据，`contents.json` 列出导出内容根项；两者也是本工具识别 schema 根目录的必要标记。实际解码规则来自 `metadata/json_schemas` 中的 `$id`、`title`、`x-format-version`、`x-ordinal-index`、`x-underlying-type` 等字段。

只提取和还原 MCB：

```powershell
brax .\input --schema .\bds-schema --mcb-only
```

## JSON 格式

MCB 还原 JSON 默认使用两个空格缩进：

```powershell
brax .\input -s .\bds-schema --json-format pretty
```

压缩成单行：

```powershell
brax .\input -s .\bds-schema --json-format compact
```

`--json-format` 默认只影响 MCB 还原结果。加上 `--format-all-json` 后，归档条目和目录输入中的普通 `.json` 也会被解析并重新序列化。pretty 模式可使用 `--indent-size 0-10` 和 `--indent-char space|tab` 设置缩进。

## 失败策略

默认行为是：

- 解析失败后继续处理；
- 将失败文件原样保留到目标路径；
- 最终退出码为 `2`；
- 简要汇总只显示失败数量，使用 `--list` 查看详情。

`--discard-failed` 不写入当前解析失败的文件。它不会删除由其他输入来源或以前运行产生的文件。`--fail-fast` 会在第一次解析失败后停止，并强制保留触发失败的原文件，因此与 `--discard-failed` 同用时后者无效。

## 进度与结果输出

详细进度默认开启。在交互式终端中，第一行显示当前阶段和文件，第二行显示当前归档或普通源文件批次的进度，第三行显示整个解包任务的总进度。两个进度条都显示百分比和 `当前值/总数`。使用 `--no-verbose` 关闭；重定向输出时实时进度自动禁用，避免日志刷屏。

处理完成后默认只显示一份总体汇总。使用 `--list` 展开普通源文件统计、每个归档结果、失败详情和冲突决策：

```powershell
brax .\input -s .\bds-schema --list
```

使用 `--report` 会在每个归档的输出目录写入 `.brarchive-report.json`。报告属于工具日志，不受 `--json-format` 影响。

## 完整参数

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
-j, --json-format <pretty|compact>
-a, --format-all-json
    --indent-size <0-10>
    --indent-char <space|tab>
-F, --fail-fast
-D, --discard-failed
    --mcb-only
    --split-archives
-i, --in-place
-h, --help
-v, --version
```

退出码：`0` 表示成功，`1` 表示参数、schema、冲突交互或其他致命错误，`2` 表示处理结束但存在条目还原或归档解析失败。
