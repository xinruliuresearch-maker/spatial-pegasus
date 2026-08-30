import { ToolSchema } from '../types'

/** Wildcard delegation never expands to these capabilities. Root may grant them explicitly. */
export const EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'GenerateImage',
  'CreateObject3D',
  'CreateWorld3D',
  'CreateSpatialScene',
  'SetSceneEnvironment',
  'SetSceneWorld',
  'AddSceneTerrain',
  'AddSceneObject',
  'TransformSceneObject',
  'RemoveSceneObject',
  'ApplySceneSpec',
  'RestoreSpatialScene',
  'SetSceneViewpoint',
  'FocusSceneObject',
  'CaptureSceneView',
  'QuerySceneSurface',
])
/** @deprecated Use EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES. */
export const ROOT_ONLY_SPATIAL_TOOL_NAMES = EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES

const MATERIAL_RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ArxivSearchPapers',
  'ArxivFetchPaper',
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseFetchPaper',
  'SciverseListRelations',
  'SearchDocument',
])

const allToolSchemas: ToolSchema[] = [
  {
    name: 'Read',
    description: `Read a text, raster, or document entry from the workspace, or a reference file exposed by a loaded Skill.

Text is returned with 1-based line numbers. Raster files are returned as media. PDF documents return metadata and workspace paths only. Papers acquired with ArxivFetchPaper or SciverseFetchPaper are materialized automatically; use the returned full text or SearchDocument to inspect their contents. Use offset and limit to read a section of a long text file.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          description: 'Workspace file path or loaded Skill reference path.',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description:
            'Line number to start reading from (1-based). Only provide if the file is too large to read at once.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum number of lines to read. Only provide if the file is too large to read at once.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description:
      'Create or completely overwrite a text file in the workspace. Use Edit for a targeted change to an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          description: 'Workspace file path to write to.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description:
      'Replace an exact string in an existing text file. Without replace_all, old_string must occur exactly once. With replace_all, every occurrence is replaced.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          description: 'Workspace file path to edit.',
        },
        old_string: {
          type: 'string',
          minLength: 1,
          description: 'Exact text to replace. Do not include line-number prefixes from Read output.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement string (must be different from old_string).',
        },
        replace_all: {
          type: 'boolean',
          description:
            'Replace all occurrences of old_string (default false). Useful for renaming variables or strings across the file.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'GenerateImage',
    description: `Generate a new image or edit one existing Workspace image and publish the result to the Workspace.

Use this when a requested spatial outcome benefits from a visual reference, or when the user explicitly asks for an image. Providing input_image_path edits/derives from that image; omitting it generates from text. Root owns it by default and may explicitly delegate it to a Member; wildcard delegation never grants it. Never pass a remote URL: input images must be authorized Workspace paths.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description: 'Complete visual brief. Include composition, materials, lighting, camera, and constraints that must remain unchanged.',
        },
        output_path: {
          type: 'string',
          pattern: '^output/spatial/images/[a-zA-Z0-9][a-zA-Z0-9._/-]*\\.(png|jpg|jpeg|webp)$',
          description: 'Workspace destination under output/spatial/images/.',
        },
        input_image_path: {
          type: 'string',
          minLength: 1,
          description: 'Optional authorized Workspace image path used as the edit/reference source.',
        },
        aspect_ratio: {
          type: 'string',
          pattern: '^[0-9]+(?:\\.[0-9]+)?:[0-9]+(?:\\.[0-9]+)?$',
          maxLength: 32,
          description: 'Optional positive width:height ratio, for example 2:1, 16:9, or 2.39:1. Omit when preserving an input image composition matters more.',
        },
      },
      required: ['prompt', 'output_path'],
    },
  },
  {
    name: 'CreateObject3D',
    description: `Queue one durable Lux3D object build and return immediately with its persistent Job identity.

The normal path is one clean canonical reference image. At least one of prompt or reference_image_paths is required; both may be provided. Use 2–4 ordered references only as an explicit recovery path after a real single-view result exposes unacceptable hidden-side ambiguity, or when the user specifically requests multi-view reconstruction. The build publishes a standalone editable GLB, optional high-quality PLY and manifest. A prepared result means the local durable queue accepted the request, not that Lux3D has accepted it yet. Continue independent work; a terminal completion reminder is delivered automatically. Root owns it by default and may explicitly delegate it; wildcard delegation never grants it.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Object design, material, geometry, and view-independent constraints.' },
        reference_image_paths: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
          description: 'Ordered authorized Workspace image paths. For multiple views, put the canonical/main view first. Arbitrary URLs are forbidden.',
        },
        output_path_prefix: {
          type: 'string',
          pattern: '^output/spatial/objects/[a-zA-Z0-9][a-zA-Z0-9._/-]*$',
          description: 'Build directory. The published model is <prefix>/model.glb and metadata is <prefix>/manifest.json.',
        },
      },
      required: ['output_path_prefix'],
      // Keep cross-field requirements in the runtime validator. Some
      // Anthropic-compatible relays reject top-level JSON Schema combinators.
    },
  },
  {
    name: 'CreateWorld3D',
    description: `Queue one durable Aholo World generation and return immediately with its persistent Job identity.

At least one of prompt or source_image_path is required; both may be provided. A prepared result means the local durable queue accepted the request, not that Aholo has accepted it yet. Continue independent work; a terminal completion reminder is delivered automatically. The build publishes a manifest, preview when available, and an Aholo opening link. Root owns it by default and may explicitly delegate it; wildcard delegation never grants it.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'World description including spatial layout, atmosphere, camera intent, and exclusions.' },
        source_image_path: {
          type: 'string',
          minLength: 1,
          description: 'Optional authorized Workspace scene image. Arbitrary URLs are forbidden.',
        },
        output_path_prefix: {
          type: 'string',
          pattern: '^output/spatial/worlds/[a-zA-Z0-9][a-zA-Z0-9._/-]*$',
          description: 'Build directory. The published world record is <prefix>/manifest.json.',
        },
      },
      required: ['output_path_prefix'],
      // Cross-field validation remains authoritative in executeCreateWorld3D.
    },
  },
  {
    name: 'CreateSpatialScene',
    description: 'Create a versioned editable Scene, optionally from one already-published World Job. Revision identities are managed automatically.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      world_job_id: { type: 'string', minLength: 1, maxLength: 160 },
    }, required: ['title'] },
  },
  {
    name: 'SetSceneEnvironment',
    description: 'Set an authorized Workspace image as the Scene equirectangular panorama environment. This is the normal far-field sky and horizon layer; it does not create geometry or a walkable surface.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 },
      image_path: { type: 'string', minLength: 1, description: 'Authorized Workspace panorama image path. Prefer a seamless 2:1 equirectangular image.' },
      yaw_deg: { type: 'number', description: 'Optional horizontal panorama rotation in degrees.' },
      exposure: { type: 'number', exclusiveMinimum: 0, maximum: 8 },
      observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'image_path'] },
  },
  {
    name: 'SetSceneWorld',
    description: 'Replace the whole immutable 3DGS World background of a Scene with one published World Job. This does not locally edit 3DGS semantics.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, world_job_id: { type: 'string', minLength: 1, maxLength: 160 }, observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'world_job_id'] },
  },
  {
    name: 'AddSceneObject',
    description: 'Add the published standalone GLB from an Object Job to a Scene using an absolute three-axis transform.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, object_job_id: { type: 'string', minLength: 1, maxLength: 160 }, label: { type: 'string', maxLength: 160 },
      position: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      rotation_deg: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      scale: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', exclusiveMinimum: 0 } },
      observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'object_job_id'] },
  },
  {
    name: 'AddSceneTerrain',
    description: 'Add a published Lux GLB as a terrain, foundation, road, plaza, mountain or other large editable Scene module. Terrain remains an ordinary transformable Lux asset but is eligible for real mesh surface queries.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, object_job_id: { type: 'string', minLength: 1, maxLength: 160 }, label: { type: 'string', maxLength: 160 },
      position: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      rotation_deg: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      scale: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', exclusiveMinimum: 0 } },
      observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'object_job_id'] },
  },
  {
    name: 'TransformSceneObject',
    description: 'Set an existing object instance to absolute position, Euler XYZ rotation in degrees, and/or positive XYZ scale. At least one of position, rotation_deg, or scale is required. Inspect first; do not use vague relative motion.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, instance_id: { type: 'string', minLength: 1, maxLength: 160 },
      position: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, rotation_deg: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, scale: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', exclusiveMinimum: 0 } }, observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'instance_id'] },
  },
  {
    name: 'RemoveSceneObject',
    description: 'Remove one GLB object instance from the current Scene and create a new automatic revision.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, instance_id: { type: 'string', minLength: 1, maxLength: 160 }, observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'instance_id'] },
  },
  {
    name: 'ApplySceneSpec',
    description: `Compile and atomically apply one declarative Scene JSON file from the Workspace.

Use this as the default authoring interface for multi-object layout. Each node uses exactly one published object_job_id or a procedural proxy (box, cylinder, or arch with dimensions, colour and material semantics). Maintain stable semantic node keys and absolute positions/rotations. Published objects use explicit scale or one target fit dimension; proxies use explicit dimensions and do not require a Job. The nodes array is the complete desired object set: omitted nodes are removed. One successful apply creates exactly one automatic revision. The JSON's expected_scene_version provides optimistic locking; inspect and update the file after scene_changed.`,
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 },
      spec_path: { type: 'string', pattern: '^output/spatial/scenes/[a-zA-Z0-9][a-zA-Z0-9._/-]*\\.json$', description: 'Authorized Workspace JSON file containing schema_version, scene_id, expected_scene_version, optional environment, and the complete nodes array.' },
      observation_id: { type: 'string', maxLength: 160 },
    }, required: ['scene_id', 'spec_path'] },
  },
  {
    name: 'InspectSpatialScene',
    description: 'Read the current or historical Scene snapshot, including frozen World, object instances, transforms and optional immutable history.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, revision_version: { type: 'integer', minimum: 1 }, include_history: { type: 'boolean' },
    }, required: ['scene_id'] },
  },
  {
    name: 'RestoreSpatialScene',
    description: 'Clone a historical Scene version into a new current revision. History is never overwritten or rewound.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, revision_version: { type: 'integer', minimum: 1 },
    }, required: ['scene_id', 'revision_version'] },
  },
  {
    name: 'SetSceneViewpoint',
    description: 'Set the persistent Agent camera without changing the user camera.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, position: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, target: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, up: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, fov_deg: { type: 'number', minimum: 20, maximum: 100 },
    }, required: ['scene_id', 'position', 'target'] },
  },
  {
    name: 'FocusSceneObject',
    description: 'Compute and persist an Agent viewpoint that frames one Scene object. It never hijacks the user camera.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, instance_id: { type: 'string', minLength: 1, maxLength: 160 }, framing: { type: 'string', enum: ['close', 'medium', 'wide'] },
    }, required: ['scene_id', 'instance_id'] },
  },
  {
    name: 'CaptureSceneView',
    description: 'Ask an active browser Stage to render the real Scene from the Agent camera and return the captured PNG as model-visible media. Returns viewer_unavailable when no Stage is open.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 }, note: { type: 'string', maxLength: 1000 },
    }, required: ['scene_id'] },
  },
  {
    name: 'QuerySceneSurface',
    description: 'Raycast downward against one loaded Lux terrain GLB in the active browser Stage and return the real mesh hit point. Use the returned absolute point when placing another object; never guess terrain height from image appearance or bounds.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      scene_id: { type: 'string', minLength: 1, maxLength: 160 },
      terrain_instance_id: { type: 'string', minLength: 1, maxLength: 160 },
      horizontal: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: 'Two coordinates on the terrain horizontal plane: X/Y for Z-up Scenes, X/Z for legacy Y-up Scenes.' },
      cast_height: { type: 'number', exclusiveMinimum: 0, description: 'Optional origin along the Scene up axis. Defaults to a safely high value.' },
    }, required: ['scene_id', 'terrain_instance_id', 'horizontal'] },
  },
  {
    name: 'GetSpatialJob',
    description: 'Read one durable Lux3D object or Aholo world Job snapshot by job_id. This tool does not accept GenerateImage receipt IDs (`spimg_*`); the GenerateImage ToolResult is the authoritative image status. This does not submit work or poll repeatedly.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string', minLength: 1, maxLength: 160 },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'WaitSpatialJob',
    description: 'Diagnostic-only bounded wait for one known spatial Job. Normal creation must continue other work and rely on the automatic terminal reminder instead of polling with this tool.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string', minLength: 1, maxLength: 160 },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Bounded wait, default 30000 ms.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'InspectSpatialArtifact',
    description: 'Inspect one published spatial artifact and its observable manifest, hashes, Workspace paths, and lightweight provenance relations. Never infers hidden geometry or physical correctness.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifact_id: { type: 'string', minLength: 1, maxLength: 160 },
      },
      required: ['artifact_id'],
    },
  },
  {
    name: 'Glob',
    description:
      'Find existing workspace files whose paths match a glob pattern. Returns workspace-relative paths and file metadata.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description:
            'The glob pattern to match files against (e.g., "analysis/*.md", "output/*", "**/*.md").',
        },
        root: {
          type: 'string',
          enum: ['output', 'analysis', 'notes', 'references', '.sci-pegasus'],
          description: 'Optional root in which to apply the pattern.',
        },
        kind: {
          type: 'string',
          enum: ['text', 'raster', 'document', 'all'],
          description: 'Filter by stored file kind (default all).',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum returned files (default 100, hard maximum 500).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description:
      'Search existing workspace text files for a literal string or regular expression. Returns matching lines and optional surrounding context; raster files are skipped.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description:
            'The text or regex pattern to search for in file contents.',
        },
        path: {
          type: 'string',
          description:
            'Optional: limit search to a specific workspace file path or glob.',
        },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as literal text instead of a regular expression.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Use case-sensitive matching (default false).',
        },
        context_lines: {
          type: 'integer',
          minimum: 0,
          maximum: 3,
          description: 'Context lines before and after each match (0-3, default 0).',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum matching lines returned (default 50, hard maximum 200).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Skill',
    description:
      'Load an available Skill into the current conversation. Skills provide specialized instructions, workflows, and domain knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: 'Name of the available Skill to load.',
        },
        args: {
          type: 'string',
          description: 'Optional arguments passed to the Skill.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'WebSearch',
    description:
      'Search the web for current or externally sourced information. Returns result titles, URLs, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description:
            'A precise search query describing the information or source needed.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ArxivSearchPapers',
    description: `Search arXiv for paper-level preprint metadata and save an immutable search audit record in the workspace.

Use for: discovering arXiv papers by keywords, authors, categories, dates, or recency.
Not for: searching passages inside full text, querying Sciverse metadata/evidence, or downloading a paper.
Returns: normalized paper records, an audit record_path, and next_cursor when more results are available.
Next: pass papers[].ref.sourceId as arxiv_id to ArxivFetchPaper; use the next_cursor for another bounded page.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'arXiv keyword/query expression. Keep one call focused on one retrieval intent.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum paper records to return (default 10).',
        },
        cursor: {
          type: 'string',
          maxLength: 2000,
          description: 'next_cursor from a previous ArxivSearchPapers result.',
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'newest', 'oldest'],
          description: 'Paper ordering (default relevance).',
        },
        filters: {
          type: 'object',
          description: 'Optional arXiv-native paper filters. Fields are combined with the query.',
          properties: {
            authors: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', minLength: 1, maxLength: 200 },
              description: 'Author names; any supplied author may match.',
            },
            categories: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', minLength: 1, maxLength: 200 },
              description: 'arXiv categories such as cond-mat.mtrl-sci or physics.chem-ph.',
            },
            published_from: {
              type: 'string',
              description: 'Inclusive publication date lower bound in ISO date form.',
            },
            published_to: {
              type: 'string',
              description: 'Inclusive publication date upper bound in ISO date form.',
            },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ArxivFetchPaper',
    description: `Download one arXiv paper, save its metadata, provenance, and original PDF, parse the PDF locally, and return bounded full text in the same call.

Use for: materializing a known arXiv paper returned by ArxivSearchPapers.
Not for: arbitrary URLs, Sciverse doc_id values, paper discovery, or scientific interpretation.
Returns: durable workspace paths for the PDF and parsed text, parser provenance, and full_text (possibly truncated inline, never truncated on disk).
Next: use SearchDocument to locate passages, then Read the returned full_text_path for precise surrounding text.`,
    input_schema: {
      type: 'object',
      properties: {
        arxiv_id: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'arXiv identifier from ArxivSearchPapers papers[].ref.sourceId; do not pass a URL.',
        },
        version: {
          type: 'string',
          maxLength: 100,
          description: 'Optional arXiv version such as v2. Omit to use the version encoded in arxiv_id or the provider default.',
        },
        search_record_path: {
          type: 'string',
          pattern: '^references/searches/search-[a-z0-9_-]+\\.json$',
          description: 'Optional immutable ArxivSearchPapers audit record to verify and link in provenance.',
        },
      },
      required: ['arxiv_id'],
    },
  },
  {
    name: 'SciverseSearchPapers',
    description: `Run structured-field and/or BM25 keyword discovery over Sciverse paper metadata, and save an immutable audit record.

Use for: identifying papers by title, author, venue, year, subject, DOI-like catalog fields, or explicit sorting/boosting.
Not for: natural-language passage evidence (use SciverseSearchEvidence), full-text acquisition, or arXiv-only discovery.
Returns: normalized paper records. ref.uniqueId is only for SciverseListRelations; ref.documentId is the doc_id and appears only when full text is fetchable.
Next: pass ref.documentId to SciverseFetchPaper (never ref.uniqueId), pass ref.uniqueId to SciverseListRelations, or collect documentId values into SciverseSearchEvidence filters.doc_id for hard-scoped evidence search.

At least one of query, title_contains, abstract_contains, authors, years, journals, subjects, or filters_advanced is required at runtime.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 4096,
          description: 'Optional keyword/BM25 query across searchable metadata. May be omitted for a purely structured search.',
        },
        title_contains: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'Text that must occur in the title field.',
        },
        abstract_contains: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'Text that must occur in the abstract field.',
        },
        authors: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'Author names; mapped to Sciverse author filtering.',
        },
        year_from: {
          type: 'integer',
          minimum: 0,
          description: 'Inclusive publication year lower bound.',
        },
        year_to: {
          type: 'integer',
          minimum: 0,
          description: 'Inclusive publication year upper bound.',
        },
        journals: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'Normalized journal or conference venue names; any supplied venue may match.',
        },
        subjects: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'Subject labels such as materials science, chemistry, or physics.',
        },
        filters_advanced: {
          type: 'array',
          maxItems: 50,
          description: 'Advanced Sciverse catalog filters. Use only when the friendly fields above are insufficient.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1, maxLength: 200 },
              operator: {
                type: 'string',
                enum: [
                  'FILTER_OP_EQ',
                  'FILTER_OP_NE',
                  'FILTER_OP_GT',
                  'FILTER_OP_GTE',
                  'FILTER_OP_LT',
                  'FILTER_OP_LTE',
                  'FILTER_OP_IN',
                  'FILTER_OP_NIN',
                  'FILTER_OP_CONTAINS',
                  'FILTER_OP_MATCH',
                  'FILTER_OP_MATCH_PHRASE',
                ],
                description: 'Catalog filter operator (default FILTER_OP_EQ).',
              },
              value: { description: 'Value appropriate for the selected catalog field and operator.' },
            },
            required: ['field', 'value'],
          },
        },
        sort_advanced: {
          type: 'array',
          maxItems: 10,
          description: 'Advanced sorting by Sciverse catalog fields. Avoid combining explicit sorting with a relevance query unless intentional.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1, maxLength: 200 },
              order: { type: 'string', enum: ['SORT_ORDER_DESC', 'SORT_ORDER_ASC'] },
            },
            required: ['field', 'order'],
          },
        },
        sort_by_year: {
          type: 'string',
          enum: ['desc', 'asc', 'none'],
          default: 'desc',
          description: 'Convenience publication-year sort (default desc). Use none to preserve relevance ranking for a query.',
        },
        freshness_boost: {
          type: 'string',
          enum: ['NONE', 'MILD', 'STRONG'],
          description: 'Relevance-preserving preference for recent papers; applies to query searches without explicit sorting.',
        },
        impact_boost: {
          type: 'string',
          enum: ['NONE', 'MILD', 'STRONG'],
          description: 'Relevance-preserving preference for influential papers; applies to query searches without explicit sorting.',
        },
        language_affinity: {
          type: 'string',
          enum: ['NONE', 'MILD', 'STRONG'],
          description: 'Prefer, but do not require, results in the detected query language.',
        },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'Page number for shallow pagination (default 1).',
        },
        page_size: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum paper records in this page (default 10).',
        },
        cursor: {
          type: 'string',
          maxLength: 2000,
          description: 'next_cursor from a prior SciverseSearchPapers call for deep pagination.',
        },
      },
    },
  },
  {
    name: 'SciverseSearchEvidence',
    description: `Run natural-language chunk retrieval over Sciverse full text for RAG evidence, and save an immutable audit record.

Use for: finding citation-grade passages that address a scientific question, optionally within a known candidate doc_id set.
Not for: exact paper/DOI/author listing (use SciverseSearchPapers), downloading full text, or deciding whether a claim is true from retrieval score alone.
Returns: evidence hits with chunk text, chunk_id, doc_id, title, score, UTF-8 byte offset, and available page/metadata fields.
Next: inspect promising hits, then pass hit.documentId/doc_id to SciverseFetchPaper and use SearchDocument/Read for durable surrounding context. Every evidence filter except doc_id is soft when chunk metadata is missing; filters.doc_id is the only hard scope. To search only a candidate set, pass its document IDs there instead of globally searching and intersecting afterward.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'Natural-language evidence question; focused queries usually retrieve better chunks.',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum evidence hits requested (default 10, hard maximum 100).',
        },
        mode: {
          type: 'string',
          enum: ['fast', 'balanced', 'quality'],
          description: 'fast=keyword retrieval; balanced=hybrid retrieval (default); quality=query expansion plus hybrid retrieval.',
        },
        source_types: {
          type: 'array',
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', enum: ['web', 'pdf'] },
          description: 'Optional source representations to search.',
        },
        filters: {
          type: 'object',
          description: 'Recall-time filters. Different fields combine with AND; array values within one field use OR. All fields except doc_id are soft filters when chunk metadata is missing.',
          properties: {
            lang: { description: 'Language code such as en or zh; scalar or array.' },
            metadata_type: { description: 'Single resource type such as paper or ebook.' },
            author: { description: 'Author name or array of names.' },
            publication_venue_name_unified: { description: 'Normalized journal or conference venue name.' },
            publication_venue_type: { description: 'Venue type such as journal, conference, repository, or book series.' },
            publication_published_year: { description: 'Year scalar, [min,max], or {gte,lte} range.' },
            publication_published_date: { description: 'YYYY[-MM[-DD]] scalar or range.' },
            citation_count: { description: 'Citation-count scalar or numeric range.' },
            influential_citation_count: { description: 'Influential-citation scalar or numeric range.' },
            title: { description: 'Exact title filter; use SciverseSearchPapers for general title discovery.' },
            topics: { description: 'Topic filter object with optional logic and dimensions.' },
            doc_id: {
              oneOf: [
                { type: 'string', pattern: '^[a-f0-9]{64}$' },
                {
                  type: 'array',
                  maxItems: 1000,
                  uniqueItems: true,
                  items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                },
              ],
              description: 'Hard scope: one 64-character lowercase hexadecimal SHA-256 doc_id, or an array of at most 1000 such values from SciverseSearchPapers. An empty array intentionally returns no hits.',
            },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'SciverseFetchPaper',
    description: `Fetch one Sciverse full-text document by doc_id, save its metadata, provenance, and normalized Markdown in the workspace, and return bounded full text in the same call.

Use for: materializing a Sciverse result whose ref.documentId/content access is available.
Not for: unique_id values, arXiv IDs, metadata-only records, paper discovery, or scientific interpretation.
Returns: durable workspace paths and full_text (possibly truncated inline, never truncated on disk).
Next: use SearchDocument to locate passages, then Read the returned full_text_path for exact context.`,
    input_schema: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          description: 'Sciverse full-text document ID: a 64-character lowercase hexadecimal SHA-256 from ref.documentId or an evidence hit. Do not pass unique_id.',
        },
        search_record_path: {
          type: 'string',
          pattern: '^references/searches/search-[a-z0-9_-]+\\.json$',
          description: 'Optional immutable Sciverse search/evidence audit record to verify and link in provenance.',
        },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'SciverseListRelations',
    description: `List one Sciverse paper's citation graph relations with pagination and save an immutable audit record.

Use for: REFERENCES (works this paper cites), CITATIONS (works that cite this paper), or RELATED_WORKS expansion.
Not for: doc_id input, passage evidence, full-text fetching, or arXiv-only graph expansion.
Returns: related item IDs, ID types, titles, counts, and pagination metadata.
Next: paginate when needed, then resolve promising relation IDs through SciverseSearchPapers. Always use the paper's unique_id, never its doc_id.`,
    input_schema: {
      type: 'object',
      properties: {
        unique_id: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'Sciverse metadata identity from SciverseSearchPapers ref.uniqueId; do not pass doc_id.',
        },
        relation: {
          type: 'string',
          enum: ['CITATIONS', 'REFERENCES', 'RELATED_WORKS'],
          description: 'CITATIONS=who cites this paper; REFERENCES=what this paper cites; RELATED_WORKS=provider-linked related papers.',
        },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'Page number (default 1).',
        },
        page_size: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Relations per page (default 25).',
        },
      },
      required: ['unique_id', 'relation'],
    },
  },
  {
    name: 'SearchDocument',
    description:
      'Run a bounded literal search over already materialized provider or locally parsed full text in the workspace. Returns locations and excerpts only; it does not infer evidence relationships, validate claims, find gaps, or launch follow-up searches.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Literal text to locate.',
        },
        document_paths: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', minLength: 1 },
          description: 'Optional paper directories or concrete parsed/full-text paths. Omit to search all available literature text.',
        },
        case_sensitive: { type: 'boolean' },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum returned matches (default 20).',
        },
        context_chars: {
          type: 'integer',
          minimum: 40,
          maximum: 1000,
          description: 'Approximate surrounding characters per match (default 260).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'Agent',
    description: `Create a durable project-scoped peer Agent and send its first prompt. Root only.

Use this when a substantial, independent line of work benefits from its own persistent identity and context. Give every Agent a unique human-readable name, a short 3-5 word description, and a complete prompt. The Agent uses the same model family and loop as Root, runs asynchronously, and automatically returns one natural-language reply when its turn ends.

Do not use this for a trivial operation that can be completed directly, and do not create a replacement to continue prior work. A finished turn leaves the Agent idle with its history preserved; use SendMessage with its name to wake and continue it. You are automatically notified of replies, blockers, and failures, so never poll or wait for an Agent. An Agent becomes completed only when Root explicitly closes it with ManageAgent.`,
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Unique human-readable Agent name inside this project; use this name with SendMessage and TaskCreate.',
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'A short 3-5 word description of what this Agent will do.',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description: 'Complete, self-contained first message for the Agent. State the outcome, context, constraints, and whether it may write files.',
        },
        refs: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Optional workspace/evidence/paper/task/url references attached to the first message. A referenced private Agent path grants this Agent read access to that exact path.',
        },
        role: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Optional durable functional role; defaults to description.',
        },
        instructions: {
          type: 'string',
          minLength: 1,
          maxLength: 12000,
          description: 'Optional durable identity-level operating instructions that should apply on every future turn. Do not repeat the one-off prompt here.',
        },
        allowed_tools: {
          type: 'array',
          maxItems: 40,
          items: { type: 'string', minLength: 1 },
          description: 'Optional explicit generic-tool allowlist. Omit to inherit all available generic tools; Root-only tools, AskUserQuestion, Workspace ACLs, and team authority remain server-enforced.',
        },
        can_delegate_tasks: {
          type: 'boolean',
          description: 'Whether this Agent may create or reassign formal shared tasks. It can always message peers.',
        },
        budget: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional bounded token/cost/tool/download budget delegated by Root.',
          properties: {
            max_tokens: { type: 'integer', minimum: 0 },
            max_cost_usd: { type: 'number', minimum: 0 },
            max_tool_calls: { type: 'integer', minimum: 0 },
            max_download_bytes: { type: 'integer', minimum: 0 },
          },
        },
      },
      required: ['name', 'description', 'prompt'],
    },
  },
  {
    name: 'SendMessage',
    description: `Send a durable natural-language message to another Agent by its human-readable name.

Use this for ordinary delegation, follow-up questions, evidence requests, peer review, corrections, progress updates, and continuing an existing Agent. Every direct message automatically wakes an idle recipient with its full prior context. Replies and other relevant updates are delivered automatically; do not inspect an inbox, poll, sleep, or use a wait tool.

Do not create a new Agent merely to continue an existing one, do not address Agents by internal UUID, and do not send structured status payloads when TaskUpdate can record formal task state. Plain assistant text is not delivered to peers: call SendMessage whenever another Agent must receive something. The summary is only a concise notification preview; put the complete instruction in message. When source material already exists in the Workspace, attach its path in refs and send only the instruction or delta—do not paste the file body into the message.`,
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Recipient Agent name. Use the human-readable project name, never an internal UUID. Root may use "*" only when every active teammate genuinely needs the same message.',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
          description: 'Complete natural-language message delivered to the recipient.',
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Optional 5-10 word preview for supervision and notifications; it does not replace message.',
        },
        task_id: {
          type: 'string',
          minLength: 1,
          description: 'Optional formal Task ID to associate with this message.',
        },
        refs: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Optional workspace/evidence/paper/task/url references attached to this message. A referenced private Agent path grants the recipient read access to that exact path.',
        },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'TaskCreate',
    description: `Create a durable formal work item and assign it directly to an existing Agent by name.

Use this when work needs explicit ownership, acceptance criteria, dependencies, a separate budget, or durable progress tracking. Check TaskList first to avoid duplicates. The owner executes one Run at a time and additional Tasks queue automatically.

Do not create a Task for a simple question, correction, or conversational follow-up; use SendMessage instead. Task completion does not close its owner: after a turn the Agent becomes idle and can be continued with SendMessage. Root may create Tasks freely; another Agent needs an explicit delegation grant.`,
    input_schema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
          description: 'Brief, actionable task title.',
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description: 'Complete objective and requirements another Agent can execute autonomously.',
        },
        owner: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Human-readable name of the Agent responsible for this Task.',
        },
        acceptance_criteria: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1 },
        },
        context_refs: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Workspace paths or explicit evidence/paper/task/message/url references.',
        },
        blocked_by: {
          type: 'array',
          maxItems: 32,
          items: { type: 'string', minLength: 1 },
          description: 'Task IDs that must be accepted before this Task can run.',
        },
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            max_tokens: { type: 'integer', minimum: 0 },
            max_cost_usd: { type: 'number', minimum: 0 },
            max_tool_calls: { type: 'integer', minimum: 0 },
            max_download_bytes: { type: 'integer', minimum: 0 },
          },
        },
      },
      required: ['subject', 'description', 'owner'],
    },
  },
  {
    name: 'TaskUpdate',
    description: `Update one existing formal Task.

Use this to record a meaningful status or requirement change. Read the latest state with TaskGet first. An ordinary Agent may update only the status of its own assigned Task. Root or an Agent with task-delegation authority may also change its subject, description, acceptance criteria, owner, and dependencies; only Root may accept a submitted Task.

Do not use this to communicate prose to another Agent (use SendMessage), to wait for work, to submit a separate result object, or to close an Agent. A member's final natural-language reply is captured automatically as its immutable turn result, and the Agent then becomes idle.`,
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, description: 'Task ID returned by TaskCreate, TaskList, or TaskGet.' },
        status: {
          type: 'string',
          enum: ['queued', 'waiting', 'accepted', 'rework', 'cancelled'],
          description: 'Optional durable Task status. running, submitted, and failed are runtime-owned; only Root may set accepted. Task status never changes Agent lifecycle state.',
        },
        subject: { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string', minLength: 1, maxLength: 20000 },
        owner: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Optional new owner by human-readable Agent name; requires task-delegation authority.',
        },
        blocked_by: {
          type: 'array',
          maxItems: 32,
          items: { type: 'string', minLength: 1 },
          description: 'Replacement dependency list; requires task-delegation authority.',
        },
        acceptance_criteria: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'TaskList',
    description: `List the Team's Agents, formal Tasks, recent bounded turn-result summaries, and compact pending Workspace publication changes. Recent results preserve a recovery path for taskless conversations; pending changes include the result and proposal IDs needed by Root to call ReviewWorkspaceChanges.

Use this before creating duplicate Tasks, when coordinating available work, or when checking overall formal progress. Use TaskGet for one Task's full objective, criteria, references, results, and proposals.

Do not poll TaskList for Agent replies or completion notifications. Messages and turn results arrive automatically, and Agents return to idle after each turn.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'TaskGet',
    description: `Retrieve one formal Task's complete current state, owner, dependencies, context references, results, publication proposals, and full durable message bodies visible to the caller.

Use this before TaskUpdate, when detailed requirements are needed, or when an automatic mailbox notification says a large message body was retained under this task. Use TaskList for a compact overview and SendMessage for conversational follow-up. This is a state read, not a polling mechanism; Agent replies and important updates are delivered automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1 },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ReviewWorkspaceChanges',
    description: `Review public Workspace publication proposals produced by an Agent. Root only.

Use this only for the public-write safety boundary: independently accept, reject, retarget, or request changes for each proposed file. Accepting or retargeting uses revision CAS and may report a conflict that must be reviewed again. The Agent's natural-language reply is already delivered and does not need separate approval.

Do not use this to wait for Agents, accept an ordinary message, or close an Agent. request_changes sends the associated formal Task back for rework when one exists; an Agent otherwise remains idle and can be continued with SendMessage.`,
    input_schema: {
      type: 'object',
      properties: {
        result_id: { type: 'string', minLength: 1 },
        feedback: { type: 'string', maxLength: 16000 },
        file_reviews: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              proposal_item_id: { type: 'string', minLength: 1 },
              action: { type: 'string', enum: ['accept', 'reject', 'retarget', 'request_changes'] },
              target_path: { type: 'string' },
              expected_target_revision: {
                type: 'integer',
                minimum: 0,
                description: 'CAS guard for an existing public target. Omit only when the reviewed target must not exist.',
              },
              reason: { type: 'string', maxLength: 4000 },
            },
            required: ['proposal_item_id', 'action'],
          },
        },
      },
      required: ['result_id', 'file_reviews'],
    },
  },
  {
    name: 'ManageAgent',
    description: `Control the lifecycle of a durable Agent. Root only.

Use interrupt to stop current work and pause the Agent, close only when the persistent collaboration window is no longer needed, and reopen to preserve history while starting a new generation. A reopened or idle Agent can receive a new SendMessage and continue from its retained context.

Do not close an Agent merely because it answered or finished one Task. A natural turn ending automatically releases its Run and leaves the Agent idle; this is the normal waiting state and consumes no execution slot. Replies and failures are delivered automatically, so ManageAgent is not a wait or polling tool.`,
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Human-readable Agent name. Internal UUIDs are not part of the model-facing interface.',
        },
        action: { type: 'string', enum: ['interrupt', 'close', 'reopen'] },
        reason: { type: 'string', maxLength: 4000 },
        task: {
          type: 'object',
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 20000 },
            acceptance_criteria: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
            context_refs: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1 } },
          },
          required: ['objective'],
        },
      },
      required: ['name', 'action'],
    },
  },
  {
    name: 'AskUserQuestion',
    description:
      'Ask the user 1-4 structured questions and pause until they answer. Each question may be single-select or multi-select. Call this tool alone in a response.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: 'Unique stable identifier for this question.' },
              header: { type: 'string', minLength: 1, maxLength: 12, description: 'Short label, at most 12 characters.' },
              question: { type: 'string', minLength: 1, description: 'Clear decision question.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', minLength: 1 },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean' },
              required: { type: 'boolean', default: true, description: 'Whether an answer is required.' },
              allow_custom: { type: 'boolean', default: true, description: 'Whether the user may enter a custom answer.' },
            },
            required: ['id', 'header', 'question', 'options', 'multi_select'],
          },
        },
      },
      required: ['questions'],
    },
  },
]

/**
 * Public tools for new model requests. Capability filtering happens through
 * this one function so the main request, compaction fork and token accounting
 * share an identical tool prefix.
 */
export const toolSchemas: ToolSchema[] = allToolSchemas

export function getToolSchemasForCapabilities(options: {
  supportsVision: boolean
  includeRecallHistory?: boolean
  allowedTools?: readonly string[]
  allowAskUser?: boolean
  isRoot?: boolean
  projectTemplateId?: string
}): ToolSchema[] {
  const schemas = options.includeRecallHistory ? [...toolSchemas, recallHistoryToolSchema] : toolSchemas
  const allowed = options.allowedTools ? new Set(options.allowedTools) : null
  return schemas.filter(schema => (
    (options.allowAskUser !== false || schema.name !== 'AskUserQuestion')
    && (
      options.isRoot !== false
      || !EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES.has(schema.name)
      || Boolean(allowed?.has(schema.name))
    )
    && (
      options.projectTemplateId !== 'spatial-creation'
      || !MATERIAL_RESEARCH_TOOL_NAMES.has(schema.name)
    )
    && (!allowed || allowed.has(schema.name))
  ))
}

export const recallHistoryToolSchema: ToolSchema = {
  name: 'RecallHistory',
  description:
    'Search the current user’s past projects, decisions, and deliverables by natural-language query or known history references. Returns summaries or detailed records. Use only when the current request depends on past work.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Natural-language history query.' },
      refs: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1 },
        description: 'Known history references to retrieve exactly.',
      },
      depth: {
        type: 'string',
        enum: ['summary', 'detail'],
        description: 'Return summaries or detailed events, decisions, and deliverables. Defaults to summary.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum records to return. Defaults to 4.' },
    },
  },
}
