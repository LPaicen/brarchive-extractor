# brarchive 文件格式

[English](../brarchive-format.md)

本文描述本工具和当前样本所验证的 Minecraft Bedrock `.brarchive` 二进制布局。所有多字节整数均为小端序。该格式没有在本仓库中依赖官方公开规范，因此版本变化时应以实际文件和游戏实现为准。

## 总体布局

```text
+----------------------+ 0x00
| 固定头，16 字节      |
+----------------------+ 0x10
| 条目记录 0，256 字节 |
+----------------------+
| 条目记录 1，256 字节 |
+----------------------+
| ...                  |
+----------------------+ data_base = 16 + entry_count * 256
| 条目数据区           |
+----------------------+
```

文件由固定头、定长索引表和数据区组成。索引记录中的数据偏移相对于数据区起点，而不是文件起点。

## 文件头

| 文件偏移 | 大小 | 类型 | 含义 |
|---:|---:|---|---|
| `0x00` | 8 | bytes | 魔数 `7D 27 25 B1 A0 52 70 26` |
| `0x08` | 4 | `uint32 LE` | 条目数量 `entry_count` |
| `0x0C` | 4 | `uint32 LE` | brarchive 版本 |

索引表紧跟在文件头后面，共 `entry_count * 256` 字节。

## 256 字节条目记录

每条索引记录从 `record_offset = 16 + index * 256` 开始：

| 记录内偏移 | 大小 | 类型 | 含义 |
|---:|---:|---|---|
| `0x00` | 1 | `uint8` | UTF-8 文件名的字节长度，最大 247 |
| `0x01` | 247 | bytes | 文件名缓冲区；有效部分由长度字段决定，其余为填充 |
| `0xF8` | 4 | `uint32 LE` | 相对于数据区起点的数据偏移 |
| `0xFC` | 4 | `uint32 LE` | 条目数据长度 |

绝对数据位置计算如下：

```text
data_base      = 16 + entry_count * 256
absolute_start = data_base + relative_offset
absolute_end   = absolute_start + length
```

条目数据就是 `[absolute_start, absolute_end)` 范围内的原始字节。当前格式没有在条目表中记录压缩算法、校验和、时间戳或权限；本工具也没有观察到统一的条目级压缩层。

## 路径规则

文件名使用 UTF-8，并可以包含 `/` 形成归档内部子目录。本工具拒绝：

- 空文件名和非法 UTF-8；
- 绝对路径；
- NUL 字符；
- `..` 路径穿越；
- 同一归档内忽略大小写后重复的条目名；
- 指向索引或文件边界之外的数据范围。

## `foo.brarchive` 与 `foo/` 的关系

在 Bedrock 数据中经常同时出现：

```text
foo.brarchive
foo/
  child.brarchive
```

当前样本表明二者不是重复副本，而是同一逻辑资源树的互补分片：

- `foo.brarchive` 保存 `foo` 层级的直接文件；
- `foo/` 保存下一层目录，每个子目录层级继续由子 `.brarchive` 表示；
- 某些父归档的条目数为零，只承担层级占位作用；
- 合并所有层级后才能得到完整目录树。

仓库本地样本包含 115 个归档、2305 个归档条目、958 个普通源文件，以及 23 组同名归档/目录。把两类输入合并进行虚拟解包时，默认模式和拆分模式各得到 3263 个目标文件，两种模式都没有发现精确同名目标或文件/目录冲突。因此合法生成的 brarchive 树原则上不应冲突；工具的交互式冲突检测用于处理损坏、手工修改、不同版本混合或已有输出文件等异常情况。

默认输出模式恢复逻辑树：

```text
foo.brarchive       -> output/foo/<entry>
foo/bar.brarchive   -> output/foo/bar/<entry>
```

`--split-archives` 则保留容器边界：

```text
foo.brarchive       -> output/foo.brarchive/<entry>
foo/bar.brarchive   -> output/foo/bar.brarchive/<entry>
```

`--in-place` 用于恢复源逻辑树。目录输入直接以输入目录为输出根，单个 `foo.brarchive` 则写入同级 `foo/`；原归档不会删除。因为文件路径 `foo.brarchive` 不能同时作为目录使用，`--in-place` 与 `--split-archives` 互斥。

冲突检测始终基于所选模式的最终目标路径执行。

## 解析伪代码

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

解析器必须在执行切片前验证所有乘法、加法和边界，不能信任条目数量、偏移或长度。
