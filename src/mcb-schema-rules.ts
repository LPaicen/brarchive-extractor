export const MCB_MAGIC = 0x42434d7f
export const MAX_CONTAINER_ITEMS = 1_000_000
// SemVersion::fromString("beta") uses 9999.9999.9999-beta internally.
export const BETA_VERSION_COMPONENT = 9999

const TAGGED_VARIANT_TITLES_WITHOUT_ORDINALS = new Set(['particle_appearance_tinting color_data', 'particle_curve'])

const PREFERRED_ONE_OF_TYPES = new Map<string, string>([
  ['crafting catalog item', 'string'],
  ['vectorevents', 'array'],
  ['color_expr', 'array'],
  ['particle_motion_collision_event_vector', 'array'],
  ['vec3', 'array'],
  ['item descriptor', 'object'],
  ['minecraft:icon v1.21.80', 'object'],
  ['trade quantity', 'object'],
  ['minecraft:hand_equipped', 'boolean'],
  ['minecraft:max_stack_size', 'integer'],
])

export function oneOfUsesVariantTag(title: string): boolean {
  return TAGGED_VARIANT_TITLES_WITHOUT_ORDINALS.has(title)
}

export function preferredOneOfType(title: string): string | undefined {
  return PREFERRED_ONE_OF_TYPES.get(title)
}
