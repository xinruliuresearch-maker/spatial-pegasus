# Research strategy evaluation

These files are definitions and deterministic contracts only. No model, Agent,
Sciverse, arXiv, or other live literature call is made by the verifier. There
are currently no behavioral results, pass rates, or measured improvements.

- `experiment-manifest.json` defines the paired `no_skill` versus complete
  `candidate` comparison. The candidate means all six research Skills plus the
  `materials-discovery@1` Project Guide; the baseline contains neither layer.
- `trigger-cases.json` defines positive and negative orchestration triggers and
  requires `Skill(research-orchestration)` to precede the first substantive
  literature retrieval. `tool-trace-grader.ts` grades an eventual runtime trace
  deterministically; the verifier currently exercises it only with synthetic
  traces.

- `evals.json` is the offline output-eval set. Its fixture packs cover review
  updates, conflict calibration, hybrid/adjacent discovery, source
  independence, honest negative results, version deduplication, and untrusted
  source text.
- `session-scenarios.json` checks multi-turn evidence revision, analogy
  boundary refinement, late prompt injection, and a hostile member mailbox
  message in a persistent session.
- `live-cases.json` defines one battery, catalysis, and semiconductor task. It
  requires both the real Sciverse/arXiv-enabled project runtime and network
  access, so it must not run in CI.

Before any baseline/candidate model run, first use an `--estimate-only` mode
with an external output workspace. Report configurations, cases, repetitions,
maximum Agent turns, expected model calls, literature API calls, and likely
Sciverse/arXiv downloads. Run only after the user approves exact model/CLI-turn,
API-call, and download limits. The integrated harness must install exactly the
configuration declared in `experiment-manifest.json`; a single-Skill runner is
not equivalent to the complete candidate.

The required future comparison is `no_skill` versus `candidate`. Use at least
one independent repeat before claiming stable improvement. Keep quality,
runtime reliability, token cost, and literature API usage as separate results.
The live set's machine-readable policy sets `ci_allowed` to false and requires
cost estimation plus explicit user approval. Do not weaken those fields in an
ad hoc runner.

Run the current contract-only check with:

```bash
npm run research-strategy:contracts
```

A passing result means that fixtures, manifests, trace-grader examples, Skill
references, prompt contracts, and live isolation declarations are well formed.
It does not mean that a model followed the strategy.
