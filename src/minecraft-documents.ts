export interface MinecraftDocumentType {
  payloadKey: string
  schemaTitles: readonly string[]
  includesFormatVersion?: boolean
}

// Payload keys are taken from MinecraftDocumentInput call sites in the symbolized
// Education client. Schema titles are the corresponding names exported by BDS.
export const MINECRAFT_DOCUMENT_TYPES: readonly MinecraftDocumentType[] = [
  { payloadKey: 'minecraft:camera_entity', schemaTitles: [] },
  { payloadKey: 'minecraft:cubemap_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:water_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:shadow_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:block_culling_rules', schemaTitles: ['Block Culling'] },
  { payloadKey: 'particle_effect', schemaTitles: [] },
  { payloadKey: 'minecraft:atmosphere_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:color_grading_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:lighting_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:pbr_fallback_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:client_biome', schemaTitles: ['Client Biome Definition'] },
  { payloadKey: 'minecraft:fog_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:ui-root', schemaTitles: [] },
  { payloadKey: 'minecraft:ui-composition', schemaTitles: [] },
  {
    payloadKey: 'minecraft:aim_assist_categories',
    schemaTitles: ['CameraAimAssistCategoriesDefinition'],
  },
  { payloadKey: 'minecraft:camera_custom_splines', schemaTitles: ['CameraSplineFile'] },
  { payloadKey: 'minecraft:pack_settings', schemaTitles: [] },
  { payloadKey: 'minecraft:spawn_rules', schemaTitles: ['Spawn Rules'] },
  { payloadKey: 'minecraft:item', schemaTitles: ['Item Document', 'Item Document (Beta)'] },
  { payloadKey: 'tiers', schemaTitles: ['Trade Table'], includesFormatVersion: false },
  { payloadKey: 'minecraft:crafting_items_catalog', schemaTitles: ['Crafting Catalog Document'] },
  { payloadKey: 'minecraft:biome', schemaTitles: ['Biome Definition'] },
  {
    payloadKey: 'minecraft:camera_preset',
    schemaTitles: ['Camera Preset', 'Camera Preset v1.21.80', 'Camera Preset v1.26.50'],
  },
  { payloadKey: 'minecraft:dimension', schemaTitles: ['Dimension'] },
  { payloadKey: 'minecraft:feature_rules', schemaTitles: ['Feature Rule Definition'] },
  { payloadKey: 'minecraft:block', schemaTitles: ['BlockDefinitionDocument'] },
  { payloadKey: 'minecraft:voxel_shape', schemaTitles: ['VoxelShapeFile'] },
  {
    payloadKey: 'minecraft:processor_list',
    schemaTitles: [
      'Rules used by Jigsaw Structures to determine which blocks to modify or replace when placing a Structure Template in the world.',
    ],
  },
  {
    payloadKey: 'minecraft:template_pool',
    schemaTitles: [
      'Used to pair block rules with Structure Templates and to randomly place Structure Templates using a weighted list.',
    ],
  },
  { payloadKey: 'minecraft:jigsaw', schemaTitles: ['JigsawStructure'] },
  {
    payloadKey: 'minecraft:structure_set',
    schemaTitles: [
      'A Jigsaw Structure Set is a collection of Jigsaw Structures that are placed according to a set of rules.',
    ],
  },

  // These BDS-exported document roots are loaded through shared helpers rather
  // than a direct MinecraftDocumentInput constructor at the inspected call site.
  { payloadKey: 'minecraft:entity', schemaTitles: ['Actor Document'] },
  { payloadKey: 'minecraft:client_entity', schemaTitles: ['Atomic Client Entity Document'] },
  { payloadKey: 'minecraft:aim_assist_preset', schemaTitles: ['CameraAimAssistPresetDefinition'] },
  {
    payloadKey: 'minecraft:jigsaw_structure_metadata',
    schemaTitles: ['Jigsaw Structure Metadata Registry'],
  },
  { payloadKey: 'sound_definitions', schemaTitles: ['Server Sound Definition Document'] },
  { payloadKey: 'minecraft:poi_block', schemaTitles: [] },
  { payloadKey: 'minecraft:poi_tag', schemaTitles: [] },
]

function normalizePayloadKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

const DOCUMENT_TYPES_BY_PAYLOAD_KEY = new Map(
  MINECRAFT_DOCUMENT_TYPES.map(document => [normalizePayloadKey(document.payloadKey), document]),
)

export function minecraftDocumentType(payloadKey: string): MinecraftDocumentType | undefined {
  return DOCUMENT_TYPES_BY_PAYLOAD_KEY.get(normalizePayloadKey(payloadKey))
}

export function schemaTitleCandidates(payloadKey: string): string[] {
  const normalized = normalizePayloadKey(payloadKey)
  const localName = normalized.includes(':') ? normalized.slice(normalized.indexOf(':') + 1) : normalized
  const words = localName.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\s+/g, ' ').trim()
  const configured = minecraftDocumentType(normalized)?.schemaTitles ?? []
  const inferred = configured.length === 0 ? [words, `${words} document`, `${words} file`] : []
  return [...new Set([normalized, ...configured, ...inferred])]
}

export function documentIncludesFormatVersion(payloadKey: string): boolean {
  return minecraftDocumentType(payloadKey)?.includesFormatVersion ?? true
}
