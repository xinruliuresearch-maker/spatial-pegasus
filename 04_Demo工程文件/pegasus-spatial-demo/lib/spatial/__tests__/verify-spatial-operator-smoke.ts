import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  operatorSmokeBudgetKey,
  operatorSmokeBudgetSlotFilter,
  operatorSmokeIdentity,
  operatorSmokeCliHelp,
  operatorSmokeProviderFenceKey,
  operatorSmokeUnknownFenceFilter,
  OPERATOR_PAID_CONFIRMATION,
  OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION,
} from '../operator-smoke'
import { validateOperatorSmokeConfiguration } from '../operator-smoke-runner'
import { spatialArtifactHostnames } from '../processor'

function environment(values: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values }
}

const identity = operatorSmokeIdentity({
  projectId: 'project-a',
  phase: 'H0',
  purpose: 'aholo-world-once',
})
assert.deepEqual(identity, operatorSmokeIdentity({
  projectId: 'project-a',
  phase: 'H0',
  purpose: 'aholo-world-once',
}))
assert.match(identity.smokeId, /^spsmoke_[a-f0-9]{32}$/)
assert.match(identity.runId, /^operator_smoke_[a-f0-9]{32}$/)
assert.equal(operatorSmokeBudgetKey('aholo'), 'aholo')
assert.equal(operatorSmokeBudgetKey('image', 'text'), 'image:text')
assert.equal(operatorSmokeBudgetKey('image', 'edit'), 'image:edit')
assert.equal(operatorSmokeProviderFenceKey('image'), 'image')
assert.deepEqual(operatorSmokeBudgetSlotFilter({
  projectId: ' project-a ',
  phase: ' H0 ',
  provider: 'image',
  imageMode: 'edit',
}), {
  project_id: 'project-a',
  phase: 'H0',
  $or: [
    { budget_key: 'image:edit' },
    { budget_key: 'image', provider: 'image', image_mode: 'edit' },
  ],
})
assert.equal(OPERATOR_PAID_CONFIRMATION, 'AUTHORIZE_ONE_PAID_SUBMISSION')
assert.equal(
  OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION,
  'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
)
const cliHelp = operatorSmokeCliHelp()
for (const action of ['--dry-run', '--prepare', '--submit', '--status', '--resume', '--reconcile-unknown']) {
  assert.match(cliHelp, new RegExp(action))
}
assert.match(cliHelp, /AUTHORIZE_ONE_PAID_SUBMISSION/)
assert.match(cliHelp, /RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING/)
assert.match(cliHelp, /image edit.*--project-id.*--input-path/)
assert.match(cliHelp, /原 intent 永远保持 unknown/)
assert.match(cliHelp, /三个 npm 入口已经预置供应商/)
assert.doesNotMatch(cliHelp, /每次命令还必须指定 --provider/)
assert.deepEqual(operatorSmokeUnknownFenceFilter({
  projectId: ' project-a ',
  providerFenceKey: ' image ',
}), {
  project_id: 'project-a',
  state: 'unknown',
  unknown_reconciled_at: null,
  $or: [
    { provider_fence_key: 'image' },
    { provider_fence_key: { $exists: false }, provider: 'image' },
    { provider_fence_key: null, provider: 'image' },
  ],
})
assert.equal(
  Object.hasOwn(operatorSmokeUnknownFenceFilter({
    projectId: 'project-a',
    providerFenceKey: 'image',
  }), 'phase'),
  false,
  'unknown fence must span every phase',
)
for (const script of ['spatial:smoke:aholo', 'spatial:smoke:lux', 'spatial:smoke:image']) {
  const help = spawnSync('npm', ['run', script, '--', '--help'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(help.status, 0, help.stderr || help.stdout)
  assert.match(help.stdout, /已经预置供应商/)
  assert.doesNotMatch(help.stdout, /--provider 必须/)
}

const aholoChecks = validateOperatorSmokeConfiguration('aholo', environment({
  AHOLO_API_BASE_URL: 'https://api.example.test',
  AHOLO_API_KEY: 'not-printed',
}))
assert.equal(aholoChecks.at(-1)?.detail, 'dry-run 未调用供应商')
assert.match(aholoChecks[1].detail, /configuration_blocked/)

const imageChecks = validateOperatorSmokeConfiguration('image', environment({
  LLM_BASE_URL: 'https://newapi.example.test/v1',
  LLM_API_KEY_TOOLS: 'not-printed',
  PEGASUS_SPATIAL_IMAGE_MODEL: 'GPT-image-2',
}))
assert.match(imageChecks[0].detail, /HTTPS/)
assert.throws(
  () => validateOperatorSmokeConfiguration('image', environment({
    LLM_BASE_URL: 'http://newapi.example.test/v1',
    LLM_API_KEY_TOOLS: 'not-printed',
  })),
  /显式设置 PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP=1/,
)
const insecureImageChecks = validateOperatorSmokeConfiguration('image', environment({
  LLM_BASE_URL: 'http://newapi.example.test/v1',
  LLM_API_KEY_TOOLS: 'not-printed',
  PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP: '1',
}))
assert.match(insecureImageChecks[0].detail, /HTTP 开发例外[^]*明文传输/)
assert.throws(
  () => validateOperatorSmokeConfiguration('image', environment({
    NODE_ENV: 'production',
    LLM_BASE_URL: 'http://newapi.example.test/v1',
    LLM_API_KEY_TOOLS: 'not-printed',
    PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP: '1',
  })),
  /非 production/,
)
assert.deepEqual(spatialArtifactHostnames([
  {
    assetKey: 'one',
    kind: 'model',
    fileName: 'one.glb',
    remoteUrl: 'https://CDN.Example.Test/path/model.glb?signature=secret',
  },
  {
    assetKey: 'two',
    kind: 'thumbnail',
    fileName: 'two.png',
    remoteUrl: 'https://cdn.example.test/second.png',
  },
  {
    assetKey: 'ignored-http',
    kind: 'other',
    fileName: 'bad',
    remoteUrl: 'http://unsafe.example.test/file',
  },
  {
    assetKey: 'ignored-userinfo',
    kind: 'other',
    fileName: 'bad',
    remoteUrl: 'https://user:password@private.example.test/file',
  },
  {
    assetKey: 'ignored-private-address',
    kind: 'other',
    fileName: 'bad',
    remoteUrl: 'https://169.254.169.254/latest/meta-data',
  },
]), ['cdn.example.test'])

console.log('spatial Operator smoke verification passed')
