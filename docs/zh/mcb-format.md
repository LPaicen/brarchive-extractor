# MCB 文件格式

[English](../mcb-format.md)

MCB 是 Minecraft Bedrock 使用的、由 schema 驱动的二进制文档格式。它既不是压缩后的 JSON，也不是自描述对象流：二进制文件头包含 payload key 和 format version，payload 不保存 JSON 字段名。因此，正确还原必须同时具备原始字节和由 [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs) 导出的兼容 `cereal` schema。

本文描述 `brax` 当前实现的格式，依据包括 Bedrock 读取器逆向分析、BDS schema 元数据以及完整 preview 版资源包和行为包的精确消费测试。没有证据支持的规则会被拒绝，不会通过猜测生成 JSON。

## 文法记号

下文使用二进制伪 BNF。相邻产生式表示字节在流中连续存放；`S`、`P` 和 `T` 是 schema 参数，不是文件内的字节。

```bnf
octet       ::= 一个字节
u8          ::= octet
i8          ::= octet
u16le       ::= octet octet
i16le       ::= octet octet
u32le       ::= octet octet octet octet
i32le       ::= octet octet octet octet
u64le       ::= octet octet octet octet octet octet octet octet
i64le       ::= octet octet octet octet octet octet octet octet
f32le       ::= 4 字节 IEEE-754 binary32，小端
f64le       ::= 8 字节 IEEE-754 binary64，小端
bytes(N)    ::= octet 重复 N 次
value(S)    ::= schema S 选择的产生式
value(S)*N  ::= value(S) 重复 N 次
EOF         ::= 不再剩余任何字节
```

所有多字节定长值均为小端序。

## 完整文件

```bnf
mcb-file      ::= magic format-version payload-key root-payload EOF
magic         ::= %x7F %x4D %x43 %x42
format-version ::= u16le-major u16le-minor u16le-patch string-pre-release string-build-meta
payload-key   ::= string
root-payload  ::= value(select-root(payload-key, format-version))
```

| 偏移 | 大小 | 编码 | 含义 |
|---:|---:|---|---|
| `0x00` | 4 | 固定字节 | `7F 4D 43 42`，作为 `uint32 LE` 时为 `0x42434D7F` |
| `0x04` | 2 | `uint16 LE` | format version major 分量 |
| `0x06` | 2 | `uint16 LE` | format version minor 分量 |
| `0x08` | 2 | `uint16 LE` | format version patch 分量 |
| `0x0A` | 可变 | `string` | 语义版本 pre-release 分量 |
| 后续 | 可变 | `string` | 语义版本 build metadata 分量 |
| 后续 | 可变 | `string` | payload key |
| 后续 | 可变 | schema 决定 | 根 payload |

例如，下面的前缀表示 format version `1.26.10`、payload key `particle_effect`：

```hex
7F 4D 43 42  01 00  1A 00  0A 00 00 00
0F 70 61 72 74 69 63 6C 65 5F 65 66 66 65 63 74
```

此例中，`uint16` patch 后面的两个零字节分别是空的 pre-release 和 build metadata 字符串。旧版解码器把这四个字节整体当作一个 `uint32` patch，因此在普通数字版本上看起来也能正常工作。

Bedrock 的 `SemVersion::fromString` 会把特殊 JSON 值 `beta` 映射为 `9999.9999.9999-beta`。因此，beta MCB 文件头会依次保存三个值为 `9999` 的 `uint16 LE`、字符串 `beta` 和一个空的 build metadata 字符串。`brax` 会在选择 schema 前把这一精确表示还原为 `beta`：

```bnf
beta-format-version ::= u16le(9999) u16le(9999) u16le(9999) string("beta") string("")
```

末尾的 `EOF` 校验很重要。选择错误分支后，解码器仍可能产生表面合理的值，但只要存在尾随字节，就能证明所选 schema 路径没有描述完整 payload。

## 根 Schema 选择

`--schema` 可以指向标准 bds-docs 导出根目录，也可以指向独立的 schema 目录。如果存在下面的约定目录，会优先扫描它：

```text
metadata/json_schemas/
```

否则，`brax` 会递归扫描用户指定的根目录，并要求至少找到一个带 `$id` 的有效 JSON Schema。`exist.json`、`contents.json` 和 `export-report.json` 都是可选元数据。有效的 LLClientSchemaExporter 报告通过 `target_minecraft_version` 提供显示版本，否则由 `exist.json` 的 `version` 提供；`contents.json` 不参与解码。版本元数据缺失或无法读取时显示 `unknown version`。

`brax` 会递归索引带 `$id` 的 JSON schema，规范化 URI 路径，并解析相对 `$ref` 和 JSON Pointer 片段。解析时优先遵循标准的 `$id` 相对引用规则；对于 LLClientSchemaExporter 中标题式 `$id` 与下划线物理文件名不一致的文档，相对引用还可以回退到源 schema 旁的实际文件。查找根 schema 时，首先从同时包含 `format_version` 和 payload key 属性的导出外层 schema 自动建立 payload 绑定；对于 BDS 标题与 payload key 语义不同的情况，再使用游戏文档目录；最后才为未知的新文档尝试精确标题或机械规范化后的标题。因此，只要新导出的外层文档保留标准属性关系，就不需要再补一条硬编码别名。

对于数字版本，优先选择不高于 MCB format version 的最新 `x-format-version`；如果不存在足够旧的版本，则使用最新数字版本继续尝试，并最终通过完整字节消费进行校验。`beta` 等特殊版本必须与 `x-format-version` 精确匹配；缺少 beta schema 时不会改用数字版本 schema。

部分已确认的 payload/title 关系如下：

| MCB payload key | BDS schema 标题 | 还原后的顶层成员 |
|---|---|---|
| `particle_effect` | `particle_effect` | `particle_effect` |
| `minecraft:block` | `BlockDefinitionDocument` | `minecraft:block` |
| `minecraft:biome` | `Biome Definition` | `minecraft:biome` |
| `minecraft:crafting_items_catalog` | `Crafting Catalog Document` | `minecraft:crafting_items_catalog` |
| `minecraft:feature_rules` | `Feature Rule Definition` | `minecraft:feature_rules` |
| `minecraft:voxel_shape` | `VoxelShapeFile` | `minecraft:voxel_shape` |
| `minecraft:item` | `Item Document` | `minecraft:item` |
| `tiers` | `Trade Table` | `tiers` |

文档目录枚举了从带符号教育版客户端中恢复出的 payload key，但它不能替代 BDS 没有导出的 schema 数据。已知 payload 如果没有可用根 schema，仍会报告 `missing-schema`。

解码后的 schema 值会包在原始 MCB payload key 下面。一般文档还会使用 MCB 文件头中记录的版本作为 `format_version`。所选 schema 的版本只决定如何解码 payload，不会替换 MCB 自身记录的版本。`tiers` 是已确认的例外：其根 schema 是数组，源 JSON 结构为 `{ "tiers": [...] }`，没有 `format_version`。

```bnf
normal-root-json ::= {
  "format_version": mcb-header-version,
  payload-key: root-payload
}

trade-root-json ::= { "tiers": root-payload }
```

这个外层结构属于重建元数据；原缩进、注释、属性书写顺序，以及默认值是否曾被显式写出，都无法恢复。

## VarUInt32

```bnf
varuint32 ::= continuation-octet* final-octet
continuation-octet ::= 最高位为 1 的 octet
final-octet        ::= 最高位为 0 的 octet
```

每个字节贡献低 7 位，低有效位组在前：

```text
result = 0
for i in 0 .. 4:
    byte = read_u8()
    result += (byte & 0x7F) << (7 * i)
    if (byte & 0x80) == 0:
        return result
error
```

最多允许 5 个字节，第 5 个字节只能贡献低 4 位。字符串、动态数组、普通映射以及归一化交易项列表的长度或数量都使用这种编码。

## 数值类型

JSON schema 的 `x-underlying-type` 决定实际存储宽度：

```bnf
numeric(uint8)  ::= u8
numeric(int8)   ::= i8
numeric(uint16) ::= u16le
numeric(int16)  ::= i16le
numeric(uint32) ::= u32le
numeric(int32)  ::= i32le
numeric(uint64) ::= u64le
numeric(int64)  ::= i64le
numeric(float)  ::= f32le
numeric(double) ::= f64le
```

| Schema 值 | 字节数 | 说明 |
|---|---:|---|
| `uint8`、`int8` | 1 | 原始整数 |
| `uint16`、`int16` | 2 | 小端 |
| `uint32`、`int32` | 4 | 小端 |
| `uint64`、`int64` | 8 | 小端 |
| `float` | 4 | IEEE-754 binary32 |
| `double` | 8 | IEEE-754 binary64 |

由于 JSON 无法表示非有限数，NaN 和无穷大都会被拒绝。超过 JavaScript 安全整数范围的整数会输出为十进制字符串，避免静默丢失精度。数值 schema 如果没有受支持的 `x-underlying-type`，就无法可靠解码。

## 布尔值

```bnf
boolean ::= %x00 | %x01
```

`00` 表示 `false`，`01` 表示 `true`，其他值均为错误。普通布尔值和可选字段的 presence 标记使用相同编码。

## 字符串与字符串枚举

```bnf
string      ::= varuint32-length utf8-bytes(length)
string-enum ::= string
```

长度表示 UTF-8 字节数，不是 Unicode 字符数，字符串末尾没有 NUL。非法 UTF-8 会被拒绝。当前确认的字符串枚举在 MCB 中没有数字标签，仍按字符串存放；解码后再检查该值是否属于 schema 的 `enum`。

例如：

```hex
0F 70 61 72 74 69 63 6C 65 5F 65 66 66 65 63 74
```

`0F` 是字节长度，后续 15 个字节解码为 `particle_effect`。

## 对象与字段

MCB 不保存对象属性名。属性按照 `x-ordinal-index` 从小到大解码。

```bnf
object(S) ::= field(P0) field(P1) ... field(Pn)
             ; P0..Pn 按 x-ordinal-index 排序

field(required-or-default P) ::= value(P)
field(optional P)            ::= presence(P)
presence(P)                  ::= %x00 | %x01 value(P)
```

当属性名出现在父 schema 的 `required` 数组中，或属性 schema 显式带有 `default` 时，该字段无条件存储；其他属性以一个字节的 presence 标记开始。因此，在这种二进制 schema 中，`default` 表示存储无条件存在，解码器不会凭空插入未存储的默认值。

对象没有字段数量，通常也没有总字节长度。因此，缺失或重复的 ordinal 元数据会直接导致失败：一旦字段顺序选错，后续所有值都会错位。没有属性且没有 `additionalProperties` 的对象消费 0 字节。

## 数组与元组

当前支持三种布局。

元组 schema 直接依次存放每个位置，不带数量：

```bnf
tuple([S0, S1, ... Sn]) ::= value(S0) value(S1) ... value(Sn)
```

当 `minItems` 与 `maxItems` 相等时，数组长度由 schema 固定：

```bnf
fixed-array(S, N) ::= value(S)*N
```

其他同构数组使用 VarUInt32 数量：

```bnf
dynamic-array(S) ::= varuint32-count value(S)*count
```

解码器将容器数量限制为 1,000,000。例如，体素形状的 `boxes` 虽然在 schema 中限制为 1-32 项，仍是动态数组；每个 box 中的 `vec3` 则是恰好三个 float32 的定长数组。

## 映射

没有命名属性、但具有对象类型 `additionalProperties` 的 schema 对象按动态映射存储：

```bnf
map(K, V) ::= varuint32-count map-entry(K, V)*count
map-entry(K, V) ::= map-key(K) value(V)
map-key(string) ::= string
map-key(float)  ::= f32le
map-key(int32)  ::= i32le
```

键类型由 `x-key-underlying-type` 选择，默认是 `string`。重复键会被拒绝，否则还原为 JSON 对象时会丢弃数据。

`Item Descriptor` 是归一化映射存储的例子。下面字节表示只有一项的 descriptor：

```hex
01                         ; map 数量
04 6E 61 6D 65             ; 键 "name"
15 6D 69 6E 65 ... 62 6F 78 ; 值 "minecraft:shulker_box"
```

## `cereal::ComponentStorage`

由 `cereal::ComponentStorage` 承载、schema 属性均为 `minecraft:icon` 之类组件名且没有 ordinal 的对象，使用 `cereal::internal::ComponentStorageCompositeSchema` 所处理的条目编码：

```bnf
component-storage(S) ::= u32le-count component-entry(S)*count
component-entry(S)   ::= u32le-component-id value(component-schema(component-id))
```

component ID 是完整组件名 UTF-8 字节的 32 位 FNV-1a：

```text
hash = 0x811C9DC5
for byte in utf8(component_name):
    hash = hash XOR byte
    hash = (hash * 0x01000193) modulo 2^32
```

组件 payload 没有长度字段。必须先由 component ID 找到组件 schema，才能知道下一个值的偏移。未知 component ID、重复组件或 ID 碰撞都会报错，不能直接跳过。

## `oneOf`：Tagged Variant

tagged variant 使用一个字节的 tag：

```bnf
tagged-one-of(S) ::= u8-tag value(branch(S, tag))
```

当分支带有 `x-ordinal-index` 时，tag 选择对应 ordinal。以下已确认 schema 类型的导出分支缺少 ordinal，但字节中仍有从 0 开始的 tag：

| Schema 标题 | Tag 行为 |
|---|---|
| `particle_curve` | `0` 选择 linear，`1` 选择 bezier-chain |
| `particle_appearance_tinting color_data` | 从 0 开始的分支索引 |

粒子曲线边界处的样本字节如下：

```hex
00 06 6C 69 6E 65 61 72 ...
```

`00` 选择 linear 分支；`06 "linear"` 是该分支的第一个字段。如果把 `00` 当作字符串或 presence 的一部分，后续曲线数据就会整体错位。

## `oneOf`：归一化表示

部分 `oneOf` 只描述 JSON 可接受的多种写法，并不表示二进制存在多个布局。编译后的 C++ 值只有一种归一化表示，也没有 variant tag。`brax` 根据完整样本确认了以下规则：

| Schema 标题 | 选择的二进制产生式 | 还原表示 |
|---|---|---|
| `Molang String` | `string` 分支 | 字符串 |
| `Crafting Catalog Item` | 引用的 `string` 分支 | 字符串 |
| `VectorEvents` | 数组分支 | 数组 |
| `color_expr` | 数组分支 | 数组 |
| `particle_motion_collision_event_vector` | 数组分支 | 数组 |
| `vec3` | 定长数组分支 | `[x, y, z]` |
| `minecraft:icon v1.21.80` | 对象/映射分支 | 对象 |
| `Item Descriptor` | 对象/映射分支 | 对象 |
| `Trade Quantity` | 对象分支 | `{min, max}` |
| `minecraft:hand_equipped` | 布尔分支 | 布尔值 |
| `minecraft:max_stack_size` | 整数分支 | 整数 |

它们的文法就是直接读取已确认分支，不带前置 tag：

```bnf
normalized-one-of(S) ::= value(confirmed-normalized-branch(S))
```

例如，`minecraft:max_stack_size` 的值 64 是 `40 00`（`int16 LE`），而不是 `tag + 40 00`；`vec3` 同样是连续三个 float32，既没有分支 tag，也没有数组数量。

### 交易项列表

`TradeItemList` 有独立的归一化容器布局：

```bnf
trade-item-list ::= varuint32-count value(TradeItem)*count
```

这里的 count 不是 `oneOf` tag。count 为 1 时还原为直接 `TradeItem` 分支，其他数量还原为 `{ "choice": [...] }`。wandering trader 样本中的 `3`、`4`、`8`、`9` 因而是候选项数量，不是未知 variant tag。

## 已确认的文档 Payload

上述通用规则组合成当前完整 preview 包中的几种 payload key。

### 粒子效果

```bnf
particle-effect ::= object(Particle_Effect_Data)
components      ::= component-storage(ParticleComponents)
curves          ::= map(string, particle_curve)
```

粒子同时使用 ordinal 对象、component ID、Molang 值、映射、数组、带标签曲线和归一化 JSON 表示。当前 200 个粒子 MCB 样本均精确消费至 EOF。

### 体素形状

```bnf
voxel-shape-file ::= description shape
description      ::= string-identifier
shape            ::= dynamic-array(Box)
Box              ::= vec3-min vec3-max
vec3             ::= f32le f32le f32le
```

实际字段由 `VoxelShapeFile`、`Description`、`Shape` 和 `Box` schema 提供。通过 `minecraft:voxel_shape` 到 `VoxelShapeFile` 的根别名，当前 218 个样本全部成功解码。

### 物品

```bnf
item-document ::= description component-storage(ItemComponents)
description   ::= 按 schema ordinal 排列的物品描述字段
```

物品组件还使用归一化的 `icon`、`hand_equipped`、`max_stack_size` 和 `Item Descriptor`。当前 23 个物品 MCB 样本均精确解码。

### 合成物品目录

```bnf
crafting-catalog ::= dynamic-array(CraftingCatalogCategory)
CraftingCatalogCategory ::= string-category-name dynamic-array(CraftingCatalogGroup)
CraftingCatalogGroup ::= boolean-has-group-identifier
                         CraftingCatalogGroupIcon? dynamic-array(CraftingCatalogItem)
CraftingCatalogGroupIcon ::= string-name boolean-has-icon CraftingCatalogItem?
CraftingCatalogItem ::= string-item-identifier
```

导出的 `Crafting Catalog Item` schema 在 JSON 中允许字符串或 `{ "name": string }`。编译样本直接使用归一化后的字符串分支，没有 `oneOf` tag。当前 25 个 `minecraft:crafting_items_catalog` 样本均完整消费到 payload 末尾。

### 交易表

```bnf
trade-table ::= dynamic-array(TradeTier)
TradeTier   ::= dynamic-array(TradeGroup) u32le-total-exp
TradeGroup  ::= i32le-num-to-select dynamic-array(Trade)
Trade       ::= dynamic-array(TradeItemList-wants)
                dynamic-array(TradeItemList-gives)
                u32le-trader-exp i32le-max-uses boolean-reward-exp i32le-weight
```

精确字段顺序由 `x-ordinal-index` 决定，上面的展开式列出了当前 schema 字段。`Trade Quantity` 存储为两个 `uint32 LE`（先 `min`，后 `max`），`TradeItemList` 以候选数量开始。当前 22 个 `tiers` 样本全部成功解码，且不会补入 `format_version`。

## 当前包中的战利品表不是 MCB

当前样本中，`loot_tables` 路径下共有 126 份 brarchive 报告，每份都是 `mcbEntries = 0`。其中 payload 是普通 JSON，通过非 MCB 路径复制或格式化。战利品表 JSON 通常没有 `format_version`，但这不需要另一套 MCB 解码规则，因为这些样本根本不会进入 MCB 解码器。

此前看起来相近的失败实际是村民交易表。其 payload key 为 `tiers`；旧解码器不知道 `Trade Table` 根别名，也不支持数组根，所以才会失败。

## 已知缺失 Schema：Camera Entity

当前仍有一个样本被有意保留为未还原状态：

```text
resource_packs/vanilla/__brarchive/cameras.brarchive :: death.json
payload key：minecraft:camera_entity
```

其 payload 以标识符 `minecraft:death_camera` 开始，随后是值为 13 的 `uint32 LE` 组件数量，以及各 component ID 和对应 payload。BDS 导出中存在 `CameraDefinitions.json` 及各组件 schema，但不存在描述 description 字段、组件容器、根标题和输出外层结构的 `minecraft:camera_entity` 根 schema。

这些字节很像常见的 `description + components` 文档，但自行合成根 schema 超出了导出 schema 契约，只能算推测。因此 `brax` 会报告 `missing-schema` 并保留原 MCB。未来 BDS 导出若包含根 schema，或通过游戏注册代码独立确认该根结构，就可以在不降低校验强度的前提下支持它。

## 失败边界

解码器区分以下重要类别：

| 失败 | 含义 |
|---|---|
| `invalid-mcb` | 魔数或基本文件身份错误 |
| `missing-schema` | 根、`$ref`、component ID 或 schema 片段缺失 |
| `unsupported-schema` | 元数据存在，但不能确定受支持的二进制产生式 |
| `decode-error` | 字节违反所选产生式、UTF-8、边界、布尔、枚举或数量规则 |
| `trailing-data` | 局部解码成功，但没有消费完整 payload |

除非用户明确要求丢弃失败文件，否则所有类别的正确回退都是保留原 MCB。输出部分或猜测的 JSON 会掩盖 schema 确定性真正结束的位置。

## 当前样本覆盖情况

使用当前完整 preview 版行为包和资源包：

| Payload key | MCB 文件 | 成功还原 | 剩余失败 |
|---|---:|---:|---:|
| `particle_effect` | 212 | 212 | 0 |
| `minecraft:voxel_shape` | 218 | 218 | 0 |
| `minecraft:item` | 23 | 23 | 0 |
| `tiers` | 22 | 22 | 0 |
| `minecraft:crafting_items_catalog` | 25 | 25 | 0 |
| `minecraft:camera_entity` | 1 | 0 | 1 个缺失根 schema |
| **总计** | **501** | **500** | **1** |

“成功”表示 schema 驱动的解码器精确到达 EOF，并且结果能够序列化为 JSON；它不表示原始格式、注释或显式默认值选择能够恢复。
