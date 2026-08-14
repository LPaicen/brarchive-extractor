<div align="center">
  <h1>brarchive-extractor</h1>
  <p>
    <a href="https://github.com/LPaicen/brarchive-extractor"><img src="https://img.shields.io/badge/GitHub-LPaicen%2Fbrarchive--extractor-181717?logo=github" alt="GitHub 仓库"></a>
    <a href="https://github.com/LPaicen/brarchive-extractor/releases"><img src="https://img.shields.io/github/package-json/v/LPaicen/brarchive-extractor?label=version" alt="版本"></a>
    <a href="https://github.com/LPaicen/brarchive-extractor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/LPaicen/brarchive-extractor" alt="许可证"></a>
  </p>
  <p>
    <a href="./README.md">English</a> | <a href="./README.zh.md">简体中文</a>
  </p>
</div>

`brarchive-extractor` 是一个用于 Minecraft Bedrock 资源的 TypeScript 命令行工具。它可以解包单个或批量 `.brarchive` 文件，并可使用 [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs) 生成的 schema 将 MCB 二进制文档还原为 JSON。

安装后使用简短命令 `brax` 调用工具。

工具会检查归档边界、路径穿越、输出冲突和 MCB 尾部数据。MCB 还原失败时默认保留原始二进制并继续处理；控制台和报告中的运行信息统一使用英文。

## 安装

需要 Node.js 20 或更高版本：

```powershell
npm install
npm run build
npm link
```

## 基本使用

只解包单个归档：

```powershell
brax .\entities.brarchive
```

使用 BDS schema 还原 MCB：

```powershell
brax .\entities.brarchive --schema .\bds-schema
```

递归处理整个目录：

```powershell
brax .\input --schema .\bds-schema
```

默认结果写入输入旁边的 `<输入名>_unpacked`。可以使用 `--output` 指定输出根，或使用 `--in-place` 直接写入源结构：

```powershell
brax .\input --in-place --schema .\bds-schema
```

`--in-place` 会直接修改源目录中的普通 MCB/JSON，并把归档内容写入对应的逻辑目录。单个 `foo.brarchive` 会写入同级 `foo/`，原归档仍保留。该参数不能与 `--output`、`--split-archives` 或 `--force` 同用，使用前应备份输入。

输出目录非空时，使用 `--overwrite` 保留目录中的其他内容并覆盖同名文件；使用 `-f` 或 `--force` 会先清空整个输出目录再开始处理。清空操作不可恢复，且 `--force` 不能与 `--overwrite` 同用。

目录输入中的普通文件会原样复制，`--format-all-json` 除外；`--mcb-only` 会忽略所有非 MCB 内容。`--no-empty-dirs` 会省略没有任何解包文件的归档输出目录，报告不能使空目录被保留。使用 `--split-archives` 可分别保存 `foo.brarchive/` 与同级 `foo/` 的内容。

## Schema

`--schema` 可以指向标准 bds-docs 导出根目录，也可以指向任意包含 JSON Schema 的目录。存在 `metadata/json_schemas/` 时会优先扫描该目录，否则递归扫描用户指定的目录。schema 的最低要求只是至少存在一个带 `$id` 的有效 JSON 文件。

## 冲突

通常情况下，`__brarchive` 中同名的 `foo.brarchive` 与 `foo/` 是互补的：归档保存当前层的直接文件，目录保存下一级 brarchive，因此不会产生冲突。如果输入不合法，合并后有多个内容占用同一目标，工具会暂停处理并显示来源及冲突总数。

输入 `o`、`k`、`c` 分别表示覆盖、保留已有文件、以 `name (1).ext` 共存；使用大写 `O`、`K`、`C` 会把策略应用到后续全部冲突。非交互式终端遇到未处理冲突时会报错退出。

## 命令参数

```text
-d, --directory          将输入作为目录处理
-r, --recursive          递归扫描目录（默认）
    --no-recursive       只扫描输入目录第一层
-s, --schema <path>      bds-docs 导出或递归 schema 目录
-o, --output <path>      指定输出根目录
-w, --overwrite          覆盖输出目录中的同名旧文件
-f, --force              先清空整个输出目录
-p, --report             为每个归档生成 .brarchive-report.json
    --verbose            显示状态和进度条（默认）
    --no-verbose         关闭状态和进度条
-l, --list               仅列出失败详情
-L, --list-all           列出归档结果、失败和冲突详情
-j, --json-format <mode> restored MCB JSON 使用 pretty 或 compact
-J, --format-all-json    格式化普通 .json 文件并保留注释
    --indent-size <0-10> pretty JSON 的缩进宽度（默认 2）
    --indent-char <value> 使用 space 或 tab 缩进（默认 space）
-F, --fail-fast          第一次解析失败后停止
-D, --discard-failed     不写出解析失败文件；与 --fail-fast 同用时无效
    --mcb-only           只提取并还原 MCB
    --no-empty-dirs      不生成没有解包文件的目录
    --split-archives     分开保存同名归档和目录
-i, --in-place           直接写入源结构
-h, --help               显示帮助
-v, --version            显示版本
```

## 文档

- [完整使用手册](./docs/zh/usage.md)
- [brarchive 文件结构](./docs/zh/brarchive-format.md)
- [MCB 文件结构](./docs/zh/mcb-format.md)

## 测试

```powershell
npm test
```

本地测试数据目录 `test/input/` 和 `test/bds-schema/` 已被 Git 忽略。
