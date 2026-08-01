# MCB 文件格式

[English](../mcb-format.md)

MCB 是 Minecraft Bedrock 使用的 schema 驱动二进制文档。固定文件头只描述版本和文档类型；后续 payload 没有自描述字段名，必须使用与版本、文档类型匹配的 BDS JSON schema 才能解释。

本文记录当前工具通过逆向分析和样本回归实现的结构。不同游戏版本或文档类型可能引入尚未覆盖的编码规则，因此未知构造必须失败并保留原始数据，不能猜测性输出 JSON。

## 固定文件头

所有固定宽度整数均为小端序：

| 偏移 | 大小 | 类型 | 含义 |
|---:|---:|---|---|
| `0x00` | 4 | `uint32 LE` | 魔数 `0x42434D7F`；文件字节为 `7F 4D 43 42` |
| `0x04` | 2 | `uint16 LE` | major 版本 |
| `0x06` | 2 | `uint16 LE` | minor 版本 |
| `0x08` | 4 | `uint32 LE` | patch 版本 |
| `0x0C` | 变长 | string | 文档类型 |
| 后续 | 变长 | schema payload | 根对象二进制数据 |

版本字符串按 `major.minor.patch` 组合。文档类型通常类似 `particle_effect` 或 `minecraft:voxel_shape`，用于匹配 schema 的 `title`。

## VarUInt32

动态长度和容器数量使用无符号 LEB128 风格的 `VarUInt32`：每个字节低 7 位保存数据，最高位表示后面仍有字节，最多 5 字节。

```text
result = 0
for i in 0 .. 4:
    byte = read_u8()
    result += (byte & 0x7F) << (7 * i)
    if (byte & 0x80) == 0:
        return result
error
```

第 5 字节不能使用超过 uint32 范围的高位。

## 字符串

字符串布局为：

```text
VarUInt32 utf8_byte_length
byte[utf8_byte_length] utf8_data
```

字符串没有 NUL 终止符。长度是 UTF-8 字节数，不是 Unicode 字符数。非法 UTF-8 被视为解码失败。

## schema 选择

schema 根目录由 [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs) 生成，必须包含：

```text
exist.json
contents.json
metadata/json_schemas/
```

`exist.json` 通常包含 BDS 导出版本和 build version。`contents.json` 描述导出内容根项；工具要求二者同时存在，以避免误把任意 schema 子目录当成导出根。

工具递归加载 `metadata/json_schemas` 中带 `$id` 的 schema，并执行：

1. 用 MCB 文档类型匹配 schema `title`；
2. 读取 `x-format-version`；
3. 如果有多个数值版本，优先选择不高于 MCB 头版本的最新版本；
4. 使用 `$ref` 和 JSON Pointer 解析引用；
5. 使用 `x-ordinal-index`、`x-underlying-type` 等扩展解释 payload。

## 对象字段

对象的 JSON 属性名不会写入 MCB。字段按 `x-ordinal-index` 从小到大排列。重复 ordinal 或缺少必要 ordinal 时无法可靠解码。

字段存在规则：

- `required` 字段无条件出现；
- schema 中显式带 `default` 的字段无条件出现；
- 其他字段前置一个 `uint8` presence 标记：`0` 表示缺失，`1` 表示后接字段值；
- presence 不是 0 或 1 时视为损坏数据。

对象本身通常没有总长度，因此字段顺序错误会导致后续所有字节错位。

## 数值

数值宽度由 `x-underlying-type` 决定。当前实现支持：

| underlying type | 编码 |
|---|---|
| `uint8` / `int8` | 1 字节 |
| `uint16` / `int16` | 2 字节，小端 |
| `uint32` / `int32` | 4 字节，小端 |
| `uint64` / `int64` | 8 字节，小端 |
| `float` | IEEE-754 float32，小端 |
| `double` | IEEE-754 float64，小端 |

超出 JavaScript 安全整数范围的 64 位整数以十进制字符串输出。NaN 和 Infinity 被拒绝。

## 布尔值和枚举

布尔值是一个字节，只接受 `0` 或 `1`。当前样本中的字符串枚举仍按普通 MCB 字符串保存，并在读取后检查是否属于 schema `enum`。

## 数组

数组有三种已知形式：

- tuple：schema `items` 是数组，按 schema 中的项目依次读取，不保存数量；
- 定长数组：`minItems == maxItems`，数量由 schema 决定，不保存数量；
- 动态数组：先读取 `VarUInt32 count`，随后读取 `count` 个相同 item。

工具对容器数量设置上限，避免损坏数据导致无限循环或过量内存使用。

## map

动态 map 先读取 `VarUInt32 count`，随后重复读取 key 和 value。当前 key 支持：

- `string`：MCB 字符串；
- `float`：float32；
- `int32`：小端 int32。

value 使用 `additionalProperties` 对应的 schema。重复 key 被视为解码错误。

## oneOf 和 variant

真正的二进制 variant 通常先保存一个 `uint8` tag。tag 对应 oneOf 分支的 `x-ordinal-index`；缺少显式 ordinal 时，部分已确认类型按分支索引处理。

某些 `oneOf` 只表示 JSON 文本允许多种写法，内部二进制已经规范化。例如 Molang 字符串、颜色表达式和特定向量类型可能不保存 variant tag，而是始终按已确认的内部表示读取。无法从 schema 或已确认规则判断分支时，工具必须报告 `unsupported-schema`。

## 组件表

组件存储不是普通 ordinal 对象。当前已确认布局为：

```text
uint32_le component_count
repeat component_count times:
    uint32_le component_name_hash
    component_payload
```

hash 是组件完整名称 UTF-8 字节的 32 位 FNV-1a。工具根据 schema 中所有组件名预计算 hash，再用 hash 找到对应 schema。未知 hash、重复组件或 FNV-1a 碰撞都会失败。

## 根对象和尾部校验

解码完成后，根值必须是 JSON 对象，并且读取位置必须恰好等于 MCB 文件长度。任何剩余字节都会产生 `trailing-data`；这通常表示 schema 版本不匹配、字段顺序错误或存在尚未实现的编码规则。

还原 JSON 会添加顶层 `format_version`，其值优先使用所选 schema 的 `x-format-version`。MCB 不保留原 JSON 的缩进、注释、属性书写顺序，也不能区分源文件显式写出的默认值与编译阶段补入的默认值，因此结果是语义还原，不保证逐字复原。

## 最小解析流程

```text
assert read_u32le() == 0x42434D7F
major         = read_u16le()
minor         = read_u16le()
patch         = read_u32le()
document_type = read_string()
schema        = select_schema(document_type, major.minor.patch)
value         = decode_node(schema)
assert reader_offset == file_length
```

缺少 schema、遇到未知组件或不支持的 schema 构造时，正确行为是保留原始 MCB 并报告原因。
