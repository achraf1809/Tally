const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, 2_000) : fallback;
}

function normalizeStatus(value) {
  return ['PASS', 'PARTIAL', 'MISSING'].includes(value) ? value : 'MISSING';
}

function normalizeRecommendation(value) {
  return ['PASS', 'NEEDS_FIX', 'MANUAL_REVIEW'].includes(value) ? value : 'MANUAL_REVIEW';
}

function normalizeReview(raw, requirements) {
  if (!raw || typeof raw !== 'object') throw new Error('The AI response was not an object.');
  const checks = Array.isArray(raw.checks) ? raw.checks.slice(0, requirements.length || 20).map((check, index) => ({
    requirement: cleanText(check?.requirement, requirements[index] || `Requirement ${index + 1}`),
    status: normalizeStatus(check?.status),
    explanation: cleanText(check?.explanation, 'No explanation was provided.'),
  })) : [];
  if (requirements.length && checks.length !== requirements.length) throw new Error('The AI response did not cover every requirement.');
  return {
    version: 'tally-review-v1',
    source: 'ai',
    provider: process.env.DEEPSEEK_MODEL || process.env.DEEPSEEKMODEL || DEFAULT_MODEL,
    recommendation: normalizeRecommendation(raw.recommendation),
    confidence: clampConfidence(raw.confidence),
    summary: cleanText(raw.summary, 'The AI reviewer returned no summary.'),
    checks,
    missingEvidence: Array.isArray(raw.missingEvidence) ? raw.missingEvidence.slice(0, 12).map((item) => cleanText(item)).filter(Boolean) : [],
    contradictions: Array.isArray(raw.contradictions) ? raw.contradictions.slice(0, 12).map((item) => cleanText(item)).filter(Boolean) : [],
    reviewedAt: new Date().toISOString(),
  };
}

function deterministicReview({ bounty, submission, reason = 'AI provider is not configured.' }) {
  const requirements = Array.isArray(bounty.requirements) ? bounty.requirements : [];
  const evidence = Array.isArray(submission.evidence) ? submission.evidence : [];
  const evidenceText = `${submission.resultUri || ''}\n${evidence.join('\n')}`.toLowerCase();
  const checks = requirements.map((requirement) => {
    const words = requirement.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
    const matched = words.length > 0 && words.filter((word) => evidenceText.includes(word)).length >= Math.max(1, Math.ceil(words.length * 0.45));
    return { requirement, status: matched ? 'PARTIAL' : 'MISSING', explanation: matched ? 'Some requirement terms appear in the submitted evidence; manual review is still required.' : 'No reliable evidence match was found.' };
  });
  const missingEvidence = checks.filter((check) => check.status === 'MISSING').map((check) => check.requirement);
  return {
    version: 'tally-review-v1',
    source: 'evidence-fallback',
    provider: 'deterministic',
    providerStatus: reason,
    recommendation: 'MANUAL_REVIEW',
    confidence: 0,
    summary: `The live AI provider did not return a valid report. ${reason}`,
    checks,
    missingEvidence,
    contradictions: [],
    reviewedAt: new Date().toISOString(),
  };
}

function parseJsonContent(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(text);
}

export async function reviewSubmission({ bounty, submission }) {
  const requirements = Array.isArray(bounty.requirements) ? bounty.requirements : [];
  // Support both the conventional name and the existing Netlify variable.
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEKAPIKEY;
  if (!apiKey) return deterministicReview({ bounty, submission });
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || process.env.DEEPSEEKBASEURL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL || process.env.DEEPSEEKMODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are TALLY\'s evidence reviewer. Compare a submission against every requirement. You are advisory only: never claim an audit, never invent evidence, and never authorize payment. Return strict JSON with keys: recommendation (PASS, NEEDS_FIX, or MANUAL_REVIEW), confidence (0-100), summary, checks (one object per requirement with requirement, status PASS/PARTIAL/MISSING, explanation), missingEvidence (array), contradictions (array).' },
          { role: 'user', content: JSON.stringify({ task: { title: bounty.title, description: bounty.description, requirements }, submission: { resultUri: submission.resultUri || null, evidence: submission.evidence || [], onchainEvidenceHash: submission.evidenceHash || null } }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
    const payload = await response.json();
    return normalizeReview(parseJsonContent(payload?.choices?.[0]?.message?.content), requirements);
  } catch (error) {
    return deterministicReview({ bounty, submission, reason: error.name === 'AbortError' ? 'The AI review timed out.' : error.message });
  } finally {
    clearTimeout(timeout);
  }
}
