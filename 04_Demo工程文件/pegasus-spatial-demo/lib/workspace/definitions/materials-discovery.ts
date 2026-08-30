import { WorkspaceDefinition } from '../../types'

/**
 * Durable workspace for literature-driven materials discovery.
 *
 * Declarations are suggestions for the Agent, not pre-created files. The
 * workspace remains deliberately route-neutral so a later decision between
 * structure-property discovery, simulation, and synthesis does not require a
 * storage migration.
 */
export const materialsDiscoveryWorkspace: WorkspaceDefinition = {
  name: 'materials-discovery',
  description: '材料科学文献调研、证据整理、Research Gap 与可验证假设工作区',
  policy: {
    allowedRoots: ['output', 'analysis', 'notes', 'references', '.sci-pegasus'],
    internalRoot: '.sci-pegasus',
    allowedRootFiles: ['MAP.md'],
    maxFiles: 500,
    maxDepth: 8,
    maxPathLength: 512,
    maxSegmentLength: 128,
    reservedPaths: [
      {
        path: 'MAP.md',
        description: '用户可见研究产物的语义索引',
        resolver: { type: 'field', field: 'output.map' },
      },
      {
        path: 'analysis/research-scope.md',
        description: '最低研究契约：研究问题、目标 tuple、边界、纳入与排除标准',
        resolver: { type: 'field', field: 'analysis.research_scope' },
      },
      {
        path: 'analysis/anchor-reviews.md',
        description: '可选：权威综述候选、Review Card、选择理由与时间 cutoff',
        resolver: { type: 'field', field: 'analysis.anchor_reviews' },
      },
      {
        path: 'analysis/search-frontier.md',
        description: '可选：查询族、引用图扩展、检索覆盖与停止理由',
        resolver: { type: 'field', field: 'analysis.search_frontier' },
      },
      {
        path: 'analysis/literature-map.md',
        description: '可选：文献主题、方法、材料体系与结论的结构化映射',
        resolver: { type: 'field', field: 'analysis.literature_map' },
      },
      {
        path: 'analysis/research-gaps.md',
        description: '可选：Research Gap 状态、反向 novelty 检索及其证据链',
        resolver: { type: 'field', field: 'analysis.research_gaps' },
      },
      {
        path: 'analysis/conflict-matrix.md',
        description: '可选：可比条件归一、Paper × Gap 响应与冲突根因矩阵',
        resolver: { type: 'field', field: 'analysis.conflict_matrix' },
      },
      {
        path: 'analysis/adjacent-literature-map.md',
        description: '可选：R0–R3 相邻文献、八个可迁移轴、transfer bridge 与 analogy break',
        resolver: { type: 'field', field: 'analysis.adjacent_literature_map' },
      },
      {
        path: 'references/evidence-ledger.md',
        description: '最低研究契约：E/C/G/H 引用、全文位置、独立来源链与结论映射',
        resolver: { type: 'field', field: 'references.evidence_ledger' },
      },
      {
        path: 'output/research-report.md',
        description: '最低研究契约：带 as-of date、检索覆盖、限制与停止理由的结构化报告',
        resolver: { type: 'field', field: 'output.research_report' },
      },
      {
        path: 'output/hypotheses.md',
        description: '可选：可证伪科学假设及建议验证路径',
        resolver: { type: 'field', field: 'output.hypotheses' },
      },
      {
        path: '.sci-pegasus/settings/project.md',
        description: '项目内部配置与路线选择',
        resolver: { type: 'field', field: 'settings.research_domain' },
      },
    ],
  },
}
