# MCB File Format

[Simplified Chinese](./zh/mcb-format.md)

MCB is Minecraft Bedrock's schema-driven binary document format. It is neither compressed JSON nor a self-describing object stream: the binary header contains a payload key and format version, while the payload stores values without JSON field names. Correct restoration therefore requires both the bytes and a compatible `cereal` schema exported by [bedrock-apis/bds-docs](https://github.com/bedrock-apis/bds-docs).

This document describes the format implemented by `brax`, based on Bedrock reader reverse engineering, BDS schema metadata, and exact-consumption tests against the bundled preview resource and behavior packs. Rules that are not supported by evidence are rejected instead of guessed.

## Grammar Notation

The grammar below is a binary pseudo-BNF. Concatenation means that values are adjacent in the byte stream. `S`, `P`, and `T` are schema parameters rather than stored bytes.

```bnf
octet       ::= one byte
u8          ::= octet
i8          ::= octet
u16le       ::= octet octet
i16le       ::= octet octet
u32le       ::= octet octet octet octet
i32le       ::= octet octet octet octet
u64le       ::= octet octet octet octet octet octet octet octet
i64le       ::= octet octet octet octet octet octet octet octet
f32le       ::= four-byte IEEE-754 binary32, little-endian
f64le       ::= eight-byte IEEE-754 binary64, little-endian
bytes(N)    ::= octet repeated N times
value(S)    ::= the production selected by schema S
value(S)*N  ::= value(S) repeated N times
EOF         ::= no bytes remain
```

All fixed-width multi-byte values are little-endian.

## Complete File

```bnf
mcb-file      ::= magic format-version payload-key root-payload EOF
magic         ::= %x7F %x4D %x43 %x42
format-version ::= u16le-major u16le-minor u16le-patch string-pre-release string-build-meta
payload-key   ::= string
root-payload  ::= value(select-root(payload-key, format-version))
```

| Offset | Size | Encoding | Meaning |
|---:|---:|---|---|
| `0x00` | 4 | literal bytes | `7F 4D 43 42`, or `0x42434D7F` as a `uint32 LE` |
| `0x04` | 2 | `uint16 LE` | format version major component |
| `0x06` | 2 | `uint16 LE` | format version minor component |
| `0x08` | 2 | `uint16 LE` | format version patch component |
| `0x0A` | variable | `string` | semantic-version pre-release component |
| following | variable | `string` | semantic-version build metadata component |
| following | variable | `string` | payload key |
| following | variable | schema-defined | root payload |

For example, the prefix below represents format version `1.26.10` and payload key `particle_effect`:

```hex
7F 4D 43 42  01 00  1A 00  0A 00 00 00
0F 70 61 72 74 69 63 6C 65 5F 65 66 66 65 63 74
```

The two zero bytes after the `uint16` patch in this example are the empty pre-release and build-metadata strings. This made older decoders appear to work when they treated those four bytes as one `uint32` patch value.

Bedrock's `SemVersion::fromString` maps the special JSON value `beta` to `9999.9999.9999-beta`. Consequently, a beta MCB header stores three `uint16 LE` values equal to `9999`, followed by the string `beta` and an empty build-metadata string. `brax` normalizes that exact representation back to `beta` before selecting a schema:

```bnf
beta-format-version ::= u16le(9999) u16le(9999) u16le(9999) string("beta") string("")
```

The final `EOF` check is important. A decoder can produce plausible values after choosing a wrong branch, but any trailing bytes prove that the selected schema path did not describe the complete payload.

## Schema Root Selection

`--schema` may point to a standard bds-docs export root or a standalone schema directory. If the conventional directory below exists, it is preferred:

```text
metadata/json_schemas/
```

Otherwise, `brax` recursively scans the supplied root. At least one valid JSON Schema with `$id` must be found. `exist.json`, `contents.json`, and `export-report.json` are optional metadata. A valid LLClientSchemaExporter report supplies `target_minecraft_version` for display; otherwise `exist.json` supplies its `version`. `contents.json` is not used for decoding. Missing or unreadable version metadata is displayed as `unknown version`.

`brax` recursively indexes JSON schemas with `$id`, normalizes URI paths, and resolves relative `$ref` and JSON Pointer fragments. Standard `$id`-relative resolution is attempted first. For LLClientSchemaExporter documents whose title-based `$id` differs from their underscore-based physical filename, a relative reference can fall back to the referenced file beside the source schema. Root lookup first derives payload bindings from exported envelope schemas whose properties contain `format_version` and a payload key. It then uses the game payload catalog for cases where the BDS title is semantically different, and finally tries exact or mechanically normalized titles for previously unknown document types. This lets a newly exported envelope document work without another hard-coded alias.

For numeric versions, it chooses the newest `x-format-version` not newer than the MCB format version. If none is old enough, it uses the newest numeric candidate so that an incomplete export can still be tested and then validated by exact byte consumption. Special versions such as `beta` require an exact `x-format-version` match; a numeric schema is not substituted for a missing beta schema.

Representative confirmed payload/title relationships include:

| MCB payload key | BDS schema title | Restored top-level member |
|---|---|---|
| `particle_effect` | `particle_effect` | `particle_effect` |
| `minecraft:block` | `BlockDefinitionDocument` | `minecraft:block` |
| `minecraft:biome` | `Biome Definition` | `minecraft:biome` |
| `minecraft:crafting_items_catalog` | `Crafting Catalog Document` | `minecraft:crafting_items_catalog` |
| `minecraft:feature_rules` | `Feature Rule Definition` | `minecraft:feature_rules` |
| `minecraft:voxel_shape` | `VoxelShapeFile` | `minecraft:voxel_shape` |
| `minecraft:item` | `Item Document` | `minecraft:item` |
| `tiers` | `Trade Table` | `tiers` |

The catalog enumerates the payload keys recovered from the symbolized Education client, but it cannot replace schema data that BDS did not export. A known payload with no usable root schema still reports `missing-schema`.

The decoded schema value is wrapped under the original MCB payload key. Documents normally also receive `format_version` from the MCB header. The selected schema version controls how the payload is decoded but does not replace the version stored in the MCB. `tiers` is a confirmed exception: its root schema is an array and the source JSON is `{ "tiers": [...] }` without `format_version`.

```bnf
normal-root-json ::= {
  "format_version": mcb-header-version,
  payload-key: root-payload
}

trade-root-json ::= { "tiers": root-payload }
```

The wrapper is reconstructed metadata; indentation, comments, original property-writing order, and whether a default was explicitly written cannot be recovered.

## VarUInt32

```bnf
varuint32 ::= continuation-octet* final-octet
continuation-octet ::= octet with bit 7 set
final-octet        ::= octet with bit 7 clear
```

Each byte contributes its low seven bits, least-significant group first:

```text
result = 0
for i in 0 .. 4:
    byte = read_u8()
    result += (byte & 0x7F) << (7 * i)
    if (byte & 0x80) == 0:
        return result
error
```

At most five bytes are accepted, and the fifth byte may only contribute the low four bits. Strings, dynamic arrays, ordinary maps, and normalized trade item lists use this encoding for their lengths or counts.

## Numeric Types

The JSON schema keyword `x-underlying-type` selects the stored width:

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

| Schema value | Bytes | Notes |
|---|---:|---|
| `uint8`, `int8` | 1 | raw integer |
| `uint16`, `int16` | 2 | little-endian |
| `uint32`, `int32` | 4 | little-endian |
| `uint64`, `int64` | 8 | little-endian |
| `float` | 4 | IEEE-754 binary32 |
| `double` | 8 | IEEE-754 binary64 |

Non-finite floats are rejected because JSON cannot represent them. Integers outside JavaScript's safe integer range are emitted as decimal strings rather than silently losing precision. A numeric schema without a supported `x-underlying-type` is not decodable.

## Booleans

```bnf
boolean ::= %x00 | %x01
```

`00` is `false` and `01` is `true`. Other byte values are errors. The same encoding is used for ordinary boolean values and optional-field presence markers.

## Strings and String Enums

```bnf
string      ::= varuint32-length utf8-bytes(length)
string-enum ::= string
```

The length counts UTF-8 bytes, not Unicode characters, and there is no trailing NUL. Invalid UTF-8 is rejected. String enums have no numeric tag in the confirmed schemas: they remain strings in MCB and are validated against the schema's `enum` after decoding.

Example:

```hex
0F 70 61 72 74 69 63 6C 65 5F 65 66 66 65 63 74
```

`0F` is the byte length and the following 15 bytes decode to `particle_effect`.

## Objects and Fields

Object property names are absent from MCB. Properties are decoded in ascending `x-ordinal-index` order.

```bnf
object(S) ::= field(P0) field(P1) ... field(Pn)
             ; P0..Pn sorted by x-ordinal-index

field(required-or-default P) ::= value(P)
field(optional P)            ::= presence(P)
presence(P)                  ::= %x00 | %x01 value(P)
```

A property is unconditional when its name appears in the parent schema's `required` array or the property schema contains an explicit `default`. Every other property has a one-byte presence marker. In this binary schema, `default` therefore means that storage is unconditional; the decoder does not synthesize a missing default value.

Objects have no field count and usually no byte length. Missing or duplicate ordinal metadata is therefore fatal: choosing the wrong order misaligns every following value. A schema object with no properties and no `additionalProperties` consumes zero bytes.

## Arrays and Tuples

Three layouts are supported.

Tuple schemas store each position directly and have no count:

```bnf
tuple([S0, S1, ... Sn]) ::= value(S0) value(S1) ... value(Sn)
```

Fixed arrays are identified by equal `minItems` and `maxItems`:

```bnf
fixed-array(S, N) ::= value(S)*N
```

Other homogeneous arrays store a VarUInt32 count:

```bnf
dynamic-array(S) ::= varuint32-count value(S)*count
```

The decoder limits counts to 1,000,000 items. For example, voxel-shape `boxes` is dynamic even though the schema constrains it to 1-32 entries, while each `vec3` inside a box is a fixed array of exactly three float32 values.

## Maps

A schema object with no named properties and an object-valued `additionalProperties` is stored as a dynamic map:

```bnf
map(K, V) ::= varuint32-count map-entry(K, V)*count
map-entry(K, V) ::= map-key(K) value(V)
map-key(string) ::= string
map-key(float)  ::= f32le
map-key(int32)  ::= i32le
```

The key encoding is selected by `x-key-underlying-type`, defaulting to `string`. Duplicate keys are rejected because JSON object restoration would otherwise discard data.

An `Item Descriptor` demonstrates normalized map storage. The bytes below are a one-entry descriptor:

```hex
01                         ; map count
04 6E 61 6D 65             ; key "name"
15 6D 69 6E 65 ... 62 6F 78 ; value "minecraft:shulker_box"
```

## `cereal::ComponentStorage`

Objects backed by `cereal::ComponentStorage`, whose schema properties are component names such as `minecraft:icon` and have no ordinals, use the entry encoding handled by `cereal::internal::ComponentStorageCompositeSchema`:

```bnf
component-storage(S) ::= u32le-count component-entry(S)*count
component-entry(S)   ::= u32le-component-id value(component-schema(component-id))
```

The component ID is 32-bit FNV-1a over the UTF-8 bytes of the complete component name:

```text
hash = 0x811C9DC5
for byte in utf8(component_name):
    hash = hash XOR byte
    hash = (hash * 0x01000193) modulo 2^32
```

There is no component payload length. The component ID must resolve to a component schema before the next offset can be known. Unknown component IDs, duplicate components, or an ID collision are reported instead of skipped.

## `oneOf`: Tagged Variants

A tagged variant stores a one-byte tag:

```bnf
tagged-one-of(S) ::= u8-tag value(branch(S, tag))
```

When branches have `x-ordinal-index`, the tag selects that ordinal. Confirmed schema types whose exported branches omit ordinals but whose bytes still contain a zero-based tag are:

| Schema title | Tag behavior |
|---|---|
| `particle_curve` | `0` selects linear, `1` selects bezier-chain |
| `particle_appearance_tinting color_data` | zero-based branch index |

At a particle-curve boundary, the sample bytes begin:

```hex
00 06 6C 69 6E 65 61 72 ...
```

`00` selects the linear branch; `06 "linear"` is the first field of that branch. Treating `00` as part of a string or presence marker would misalign the curve.

## `oneOf`: Normalized Representations

Some `oneOf` schemas describe alternative JSON spellings, not alternative binary layouts. The compiled C++ value has one normalized representation and no variant tag. `brax` uses the following fixture-confirmed rules:

| Schema title | Binary production selected | Restored representation |
|---|---|---|
| `Molang String` | `string` branch | string |
| `Crafting Catalog Item` | referenced `string` branch | string |
| `VectorEvents` | array branch | array |
| `color_expr` | array branch | array |
| `particle_motion_collision_event_vector` | array branch | array |
| `vec3` | fixed array branch | `[x, y, z]` |
| `minecraft:icon v1.21.80` | object/map branch | object |
| `Item Descriptor` | object/map branch | object |
| `Trade Quantity` | object branch | `{min, max}` |
| `minecraft:hand_equipped` | boolean branch | boolean |
| `minecraft:max_stack_size` | integer branch | integer |

Their grammar is simply the selected branch, with no leading tag:

```bnf
normalized-one-of(S) ::= value(confirmed-normalized-branch(S))
```

For example, a `minecraft:max_stack_size` value of 64 is `40 00` (`int16 LE`), not `tag + 40 00`. Likewise, a `vec3` is three adjacent float32 values with neither a branch tag nor an array count.

### Trade Item Lists

`TradeItemList` has its own normalized container layout:

```bnf
trade-item-list ::= varuint32-count value(TradeItem)*count
```

The count is not a `oneOf` tag. A count of one restores the direct `TradeItem` branch; any other count restores `{ "choice": [...] }`. Counts of `3`, `4`, `8`, and `9` in wandering-trader samples are therefore candidate-list sizes, not unknown variant tags.

## Confirmed Document Payloads

The generic rules compose into the payload keys present in the current full preview packs.

### Particle Effects

```bnf
particle-effect ::= object(Particle_Effect_Data)
components      ::= component-storage(ParticleComponents)
curves          ::= map(string, particle_curve)
```

Particles exercise ordinal objects, component IDs, Molang values, maps, arrays, tagged curves, and normalized JSON representations. All 200 current particle MCB samples consume exactly to EOF.

### Voxel Shapes

```bnf
voxel-shape-file ::= description shape
description      ::= string-identifier
shape            ::= dynamic-array(Box)
Box              ::= vec3-min vec3-max
vec3             ::= f32le f32le f32le
```

The actual fields are supplied by `VoxelShapeFile`, `Description`, `Shape`, and `Box` schemas. All 218 samples decode with the `minecraft:voxel_shape` to `VoxelShapeFile` root alias.

### Items

```bnf
item-document ::= description component-storage(ItemComponents)
description   ::= schema-ordered item description fields
```

Item components add normalized `icon`, `hand_equipped`, `max_stack_size`, and `Item Descriptor` values. All 23 current item MCB samples decode exactly.

### Crafting Item Catalogs

```bnf
crafting-catalog ::= dynamic-array(CraftingCatalogCategory)
CraftingCatalogCategory ::= string-category-name dynamic-array(CraftingCatalogGroup)
CraftingCatalogGroup ::= boolean-has-group-identifier
                         CraftingCatalogGroupIcon? dynamic-array(CraftingCatalogItem)
CraftingCatalogGroupIcon ::= string-name boolean-has-icon CraftingCatalogItem?
CraftingCatalogItem ::= string-item-identifier
```

The exported `Crafting Catalog Item` schema accepts either a string or `{ "name": string }` in JSON. The compiled samples use the normalized string branch directly, with no `oneOf` tag. All 25 current `minecraft:crafting_items_catalog` samples consume the complete payload.

### Trade Tables

```bnf
trade-table ::= dynamic-array(TradeTier)
TradeTier   ::= dynamic-array(TradeGroup) u32le-total-exp
TradeGroup  ::= i32le-num-to-select dynamic-array(Trade)
Trade       ::= dynamic-array(TradeItemList-wants)
                dynamic-array(TradeItemList-gives)
                u32le-trader-exp i32le-max-uses boolean-reward-exp i32le-weight
```

The precise field order comes from `x-ordinal-index`; the expanded production above names the current schema fields. `Trade Quantity` is stored as two `uint32 LE` values (`min`, then `max`), and `TradeItemList` begins with a candidate count. All 22 current `tiers` samples decode without adding `format_version`.

## Loot Tables Are Not MCB in the Current Packs

The current fixture set contains 126 brarchive reports under `loot_tables`; every one reports `mcbEntries = 0`. Their payloads are ordinary JSON and are copied or formatted through the non-MCB path. Loot-table JSON commonly has no `format_version`, but that does not require a different MCB decoder because these samples never enter MCB decoding.

The similarly named failures seen before this analysis were villager trade tables. Their payload key is `tiers`, and the old decoder failed because it did not know the `Trade Table` root alias or array-root layout.

## Known Missing Schema: Camera Entity

One current sample remains intentionally unrestored:

```text
resource_packs/vanilla/__brarchive/cameras.brarchive :: death.json
payload key: minecraft:camera_entity
```

Its payload begins with the identifier `minecraft:death_camera`, followed by a `uint32 LE` component count of 13 and component IDs with their payloads. The BDS export contains `CameraDefinitions.json` and individual component schemas, but no root schema for `minecraft:camera_entity` describing its description field, component container, root title, and output wrapper.

Those bytes strongly suggest a familiar `description + components` document, but synthesizing that root would be an inference outside the exported schema contract. `brax` therefore reports `missing-schema` and preserves the original MCB. A future BDS export containing the root schema, or independently confirmed game schema registration, can make this case decodable without weakening validation.

## Failure Boundaries

The decoder distinguishes these important classes:

| Failure | Meaning |
|---|---|
| `invalid-mcb` | magic or basic file identity is wrong |
| `missing-schema` | root, `$ref`, component ID, or schema fragment is unavailable |
| `unsupported-schema` | metadata exists but does not determine a supported binary production |
| `decode-error` | bytes violate the selected production, UTF-8, bounds, boolean, enum, or count rules |
| `trailing-data` | decoding succeeded locally but did not consume the complete payload |

The correct fallback for every class is to keep the original MCB unless the user explicitly requests failed files to be discarded. Producing partial or guessed JSON would hide the exact point where schema certainty ended.

## Current Fixture Coverage

With the current full preview behavior and resource packs:

| Payload key | MCB files | Restored | Remaining failure |
|---|---:|---:|---:|
| `particle_effect` | 212 | 212 | 0 |
| `minecraft:voxel_shape` | 218 | 218 | 0 |
| `minecraft:item` | 23 | 23 | 0 |
| `tiers` | 22 | 22 | 0 |
| `minecraft:crafting_items_catalog` | 25 | 25 | 0 |
| `minecraft:camera_entity` | 1 | 0 | 1 missing root schema |
| **Total** | **501** | **500** | **1** |

Success means the schema-directed decoder reached EOF exactly and the restored value could be serialized as JSON. It does not mean that original formatting, comments, or explicit-default choices were recoverable.
