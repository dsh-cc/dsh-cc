/**
 * The deterministic, non-oracle stub judge of the tool-discovery activation
 * eval (`docs/plans/2026-11-12-tool-discovery-activation.md` § "Runner").
 *
 * Why this exists: the `replay` arm's judgment is derived from the corpus's
 * `expectedNames`, so scoring it would be tautological (~1.0 by construction).
 * The gate must therefore come from a judge that (a) never reads the gold
 * labels, (b) is deterministic, and (c) is deliberately imperfect — a frozen
 * keyword/rule scorer over candidate METADATA only. This is the CI-safe F1 gate
 * arm: it measures whether the production pipeline (pool → questions →
 * `expectedScore` → `selectNames`) turns realistic metadata-similarity into the
 * right activation set, and every miss it makes is a real pipeline-level
 * observation rather than a label echo.
 *
 * Method (frozen — do not tune without bumping the corpus version and
 * re-running the gate):
 *
 * 1. Tokenize the query and each candidate's `name` + `description` +
 *    `searchHint`: lower-case ASCII words (stemmed for plurals) plus CJK
 *    character bigrams.
 * 2. Bridge the two languages with {@link SYNONYM_GROUPS}: a hand-authored
 *    concept table whose members are Chinese and English surface forms, so a
 *    Chinese query reaches English tool text (and the reverse) without any
 *    model call.
 * 3. Weight the overlap by where it lands — name 3, search hint 2, description
 *    1 — and normalize against the query's own content size, capped at three
 *    content words so a long Chinese query (whose bigrams inflate the count) is
 *    not unfairly diluted. The name/hint weighting is also what discounts a
 *    keyword-stuffed description: text alone cannot activate a tool whose name
 *    and hint carry none of the query's vocabulary.
 * 4. Map coverage to a relevance index 0..4 and name/hint evidence to a
 *    direct-fit `noul` through fixed thresholds.
 *
 * Tuning history (corpus growth, `corpusVersion` 2): the concept table grew from
 * ~24 to 46 generic capability groups (scheduling, branches, backups, deploys,
 * charts, permissions, migrations, audio, …) so a growing catalog stays
 * reachable, and the relevance mass became an exact binary split (see
 * {@link massFor}) so an interior index is not lost to floating-point drift.
 * No rule reads a corpus name, id, or label.
 *
 * The answer envelope is byte-compatible with the oracle's `answersFor`:
 * `<id>_relevance` is a `score` answer carrying the full 0..4 mass (so the
 * shipped `expectedScore` computes the weighted value) plus a `score` fallback,
 * and `<id>_direct` is a `noul` answer.
 */

/** ASCII word runs; underscores and hyphens are separators, so names split. */
const ASCII_WORD = /[a-z0-9]+/g

/** CJK runs (BMP ideographs); each run becomes character bigrams. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** One CJK character, without the `g` flag: {@link isCjk} must be stateless. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** Function words carrying no capability content. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'me', 'i', 'it', 'its',
  'in', 'on', 'of', 'for', 'to', 'from', 'with', 'and', 'or', 'but', 'by', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'some', 'any',
  'all', 'every', 'each', 'please', 'how', 'what', 'which', 'who', 'when', 'where',
  'why', 'will', 'can', 'should', 'would', 'could', 'not', 'no', 'up', 'out',
])

/**
 * Hand-authored concept groups (46): one line per everyday capability. A group
 * fires when ANY member is present — a Chinese substring in the text, or an
 * ASCII member among the text's tokens — and then contributes every other
 * member, which is how 查找 reaches `search` and `weather` reaches 天气.
 *
 * The table is generic on purpose: one row per capability concept of an
 * everyday tool catalog (search, files, versions, build, deploy, data, …), never
 * a per-case row and never a tool name from the corpus. Growing it is how the
 * judge follows a corpus that grows; it is not how a single case is passed.
 */
const SYNONYM_GROUPS = [
  ['search', 'find', 'lookup', 'query', '查找', '搜索'],
  ['weather', 'forecast', 'rain', 'temperature', '天气', '下雨'],
  ['reference', 'cite', 'citation', 'bibliography', '引用', '文献'],
  ['paper', 'article', 'essay', '文章', '论文'],
  ['file', 'files', 'document', 'documents', '文件', '文档'],
  ['rewrite', 'edit', 'rename', 'modify', '重写', '改名', '修改'],
  ['test', 'suite', 'spec', '测试', '单元测试'],
  ['run', 'execute', 'invoke', '跑', '执行'],
  ['log', 'logs', 'journal', '日志', '记录'],
  ['changelog', 'release', 'notes', '变更日志', '发布说明'],
  ['translate', 'translation', '翻译'],
  ['table', 'column', 'columns', 'row', '表格', '列'],
  ['order', 'reorder', 'sequence', '顺序', '排序'],
  ['image', 'picture', 'photo', 'resize', '图片', '缩图'],
  ['pdf', 'scan', 'scanned', 'caption', 'captions', '扫描件', '标题'],
  ['fetch', 'download', 'http', 'url', 'browse', '上网', '下载', '网页'],
  ['version', 'latest', '版本', '最新'],
  ['secret', 'secrets', 'credential', 'credentials', 'redact', '密钥', '脱敏'],
  ['space', 'disk', 'volume', 'room', 'capacity', '空间', '磁盘', '容量'],
  ['defer', 'resume', 'later', 'queue', 'background', 'tomorrow', '稍后', '明天', '排队'],
  ['wording', 'prose', 'sentence', 'paragraph', 'text', '措辞', '段落', '句子'],
  ['commit', 'commits', 'revision', 'revisions', 'diff', '提交', '修订'],
  ['summary', 'summarize', 'digest', 'condense', '摘要', '总结'],
  ['benefit', 'review', 'audit', 'auditor', '审计', '评审'],
  ['schedule', 'agenda', 'calendar', '日程', '日历'],
  ['branch', 'fork', '分支'],
  ['sync', 'synchronize', 'merge', '同步', '合并'],
  ['backup', 'snapshot', '备份', '快照'],
  ['archive', '归档', '存档'],
  ['deploy', 'deployment', 'rollout', '部署'],
  ['screenshot', 'screenshots', '截图', '截屏'],
  ['chart', 'plot', 'graph', '图表'],
  ['report', '报表', '报告'],
  ['permission', 'permissions', 'access', '权限'],
  ['dependency', 'dependencies', 'deps', '依赖'],
  ['migration', 'migrations', 'migrate', 'schema', '迁移'],
  ['cache', 'cached', '缓存'],
  ['retry', 'retries', '重试'],
  ['compress', 'zip', '压缩'],
  ['incident', 'outage', 'triage', '故障', '事故'],
  ['latency', 'slowness', 'slow', '延迟', '变慢'],
  ['metric', 'metrics', 'telemetry', '指标', '监控'],
  ['notification', 'notify', 'alert', '通知', '告警'],
  ['customer', 'user', 'users', '客户'],
  ['payment', 'refund', 'billing', 'refunds', '支付', '退款'],
  ['audio', 'recording', 'recordings', 'transcript', 'transcripts', '录音', '音频'],
]

/** Group membership test for one table member. */
const isCjk = member => CJK_CHAR.test(member)

/**
 * Crude plural stemmer: enough to make `references`/`reference` and
 * `columns`/`column` agree, deliberately not a linguistic model.
 * @param word - one lower-case ASCII token.
 * @returns the stemmed token.
 */
function stem(word) {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * Tokenize one text: ASCII words (stopwords dropped, plurals stemmed) plus CJK
 * character bigrams.
 * @param text - any text (query, name, description, hint).
 * @returns the token set.
 */
function tokenize(text) {
  const lower = text.toLowerCase()
  const tokens = new Set()
  for (const word of lower.match(ASCII_WORD) ?? []) {
    const stemmed = stem(word)
    if (!STOPWORDS.has(stemmed) && !STOPWORDS.has(word)) tokens.add(stemmed)
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) tokens.add(run)
    else for (let index = 0; index + 2 <= run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * Expand a token set through the concept table: every group with a present
 * member contributes all of its members.
 * @param text - the original text, for CJK substring membership.
 * @param tokens - the text's own tokens.
 * @returns a new, expanded token set.
 */
function expand(text, tokens) {
  const lower = text.toLowerCase()
  const expanded = new Set(tokens)
  for (const group of SYNONYM_GROUPS) {
    const present = group.some(member => (isCjk(member) ? lower.includes(member) : tokens.has(stem(member))))
    if (!present) continue
    for (const member of group) expanded.add(isCjk(member) ? member : stem(member))
  }
  return expanded
}

/** How many of the query's content tokens appear in the given token set. */
function hitsOf(signature, tokens) {
  let hits = 0
  for (const token of signature) if (tokens.has(token)) hits += 1
  return hits
}

/**
 * The frozen 0..4 mass for one relevance index: three quarters on the index and
 * the rest split between its neighbours, so `expectedScore` returns exactly
 * `index`. Endpoints carry all their mass on the endpoint itself.
 *
 * Every mass is a binary fraction (0.75, 0.125, 1) on purpose: the arithmetic
 * that weights them is then exact, so an interior index does not drift to
 * 2.9999999999999996 and get rejected by the production `min-relevance-index`
 * comparison (`>= 3`). A stub that misreports its own index would understate the
 * judge and make every "direct" judgment look like a miss.
 *
 * @param index - the chosen relevance index.
 * @returns the probability map keyed by the stringified index.
 */
function massFor(index) {
  const probabilities = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }
  if (index === 0 || index === 4) {
    probabilities[index] = 1
    return probabilities
  }
  probabilities[index] = 0.75
  probabilities[index - 1] = 0.125
  probabilities[index + 1] = 0.125
  return probabilities
}

/**
 * Score one candidate against the query signature.
 * @returns the relevance index, the direct-fit value, and its probability mass.
 */
function scoreCandidate(candidate, signature) {
  const nameTokens = expand(candidate.name, tokenize(candidate.name))
  const hintTokens = candidate.searchHint === undefined
    ? new Set()
    : expand(candidate.searchHint, tokenize(candidate.searchHint))
  const descriptionTokens = expand(candidate.description, tokenize(candidate.description))

  const nameHits = hitsOf(signature, nameTokens)
  const hintHits = hitsOf(signature, hintTokens)
  const descriptionHits = hitsOf(signature, descriptionTokens)

  // Normalize against the query's own content size, capped at three content
  // words: a long Chinese query carries many bigrams but only a handful of
  // capability words, and diluting every candidate equally would hide them all.
  const denominator = 3 * Math.min(Math.max(signature.size, 1), 3)
  const matched = 3 * nameHits + 2 * hintHits + descriptionHits
  const coverage = Math.min(1, matched / denominator)
  const directStrength = (3 * nameHits + 2 * hintHits) / (3 * Math.min(Math.max(signature.size, 1), 2))

  const index = coverage >= 0.85 ? 4 : coverage >= 0.4 ? 3 : coverage >= 0.15 ? 2 : coverage > 0 ? 1 : 0
  const noul = directStrength >= 1 ? 0.9 : directStrength >= 0.5 ? 0.8 : directStrength >= 0.25 ? 0.5 : 0.1
  return { index, noul }
}

/**
 * Synthesize a judgment for one batch from candidate metadata alone.
 *
 * Deterministic by construction: no clock, no randomness, no iteration over
 * anything but the caller's arrays and the frozen tables above. The gold labels
 * are NOT an input — that is the whole point of this arm.
 *
 * @param candidates - the judged batch, in pool order
 *   (`{id, name, description, searchHint?}` as `buildQuestions` consumed it).
 * @param query - the raw query being judged.
 * @returns an answer map keyed `<id>_relevance` (a `score` answer) and
 *   `<id>_direct` (a `noul` answer), byte-compatible with the oracle's shape.
 */
export function stubAnswers(candidates, query) {
  const signature = expand(query, tokenize(query))
  const answers = {}
  for (const candidate of candidates) {
    const { index, noul } = scoreCandidate(candidate, signature)
    answers[`${candidate.id}_relevance`] = {
      type: 'score',
      probabilities: massFor(index),
      score: index,
      confidence: 1,
    }
    answers[`${candidate.id}_direct`] = { type: 'noul', noul, confidence: 1 }
  }
  return answers
}
