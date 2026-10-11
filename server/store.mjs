import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(process.env.DATA_FILE || path.join(serverDir, 'data', 'db.json'));
mkdirSync(path.dirname(dataFile), { recursive: true });

function emptyDatabase() {
  return { version: 1, bounties: [], submissions: [] };
}

function loadDatabase() {
  if (!existsSync(dataFile)) return emptyDatabase();
  try {
    const parsed = JSON.parse(readFileSync(dataFile, 'utf8'));
    return {
      version: 1,
      bounties: Array.isArray(parsed.bounties) ? parsed.bounties : [],
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
    };
  } catch (error) {
    throw new Error(`Could not read persistent data: ${error.message}`);
  }
}

const database = loadDatabase();

function persist() {
  const temporaryFile = `${dataFile}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
  renameSync(temporaryFile, dataFile);
}

function hash(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

export function createMetadataHash(payload) {
  return hash(JSON.stringify(payload));
}

export function listBounties() {
  return [...database.bounties]
    .filter((bounty) => bounty.state !== 'DRAFT')
    .map((bounty) => ({ ...bounty, submissionCount: listSubmissions(bounty.id).length }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBounty(id) {
  return database.bounties.find((bounty) => bounty.id === id) ?? null;
}

export function createBounty(input) {
  const now = new Date().toISOString();
  const metadataPayload = {
    requester: input.requester,
    title: input.title,
    description: input.description,
    requirements: input.requirements ?? [],
    reward: input.reward,
    deadline: input.deadline,
  };
  const bounty = {
    id: randomUUID(),
    ...metadataPayload,
    contractAddress: input.contractAddress || '0x8D9fF4279692381F7ae0F74B3D8AAe94336426de',
    metadataHash: createMetadataHash(metadataPayload),
    state: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
  database.bounties.push(bounty);
  persist();
  return bounty;
}

export function markOnchain(bounty, confirmation) {
  if (bounty.createTxHash) {
    if (bounty.createTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different creation transaction.');
  }
  if (bounty.state !== 'DRAFT') throw new Error('This bounty can no longer be linked.');
  const duplicate = database.bounties.find((entry) => entry.id !== bounty.id && String(entry.chainBountyId) === String(confirmation.chainBountyId));
  if (duplicate) throw new Error('This on-chain bounty is already linked to another record.');
  bounty.state = 'OPEN';
  bounty.chainBountyId = String(confirmation.chainBountyId);
  bounty.createTxHash = confirmation.txHash;
  bounty.requester = confirmation.requester;
  bounty.updatedAt = new Date().toISOString();
  persist();
  return bounty;
}

export function addSubmission(bounty, input) {
  if (!['OPEN', 'SUBMISSIONS_RECEIVED'].includes(bounty.state)) throw new Error('This bounty is not accepting submissions.');
  const evidencePayload = { resultUri: input.resultUri ?? null, evidence: input.evidence ?? [] };
  const now = new Date().toISOString();
  const submission = {
    id: randomUUID(),
    bountyId: bounty.id,
    agent: input.agent,
    ...evidencePayload,
    evidenceHash: hash(JSON.stringify(evidencePayload)),
    state: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
  database.submissions.push(submission);
  persist();
  return submission;
}

export function getSubmission(id) {
  return database.submissions.find((submission) => submission.id === id) ?? null;
}

export function listSubmissions(bountyId) {
  return database.submissions
    .filter((submission) => submission.bountyId === bountyId && submission.state !== 'DRAFT')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markSubmissionOnchain(submission, confirmation) {
  if (submission.txHash) {
    if (submission.txHash === confirmation.txHash) return submission;
    throw new Error('This submission already has a different confirmation transaction.');
  }
  if (submission.state !== 'DRAFT') throw new Error('This submission can no longer be linked.');
  const duplicate = database.submissions.find((entry) => entry.id !== submission.id && entry.txHash === confirmation.txHash);
  if (duplicate) throw new Error('This submission transaction is already linked to another record.');
  const bounty = getBounty(submission.bountyId);
  submission.state = 'CONFIRMED';
  submission.agent = confirmation.agent;
  submission.txHash = confirmation.txHash;
  submission.updatedAt = new Date().toISOString();
  if (bounty) {
    bounty.state = 'SUBMISSIONS_RECEIVED';
    bounty.updatedAt = submission.updatedAt;
  }
  persist();
  return submission;
}

export function approveBounty(bounty, confirmation) {
  if (bounty.settlementTxHash) {
    if (bounty.settlementTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different payout transaction.');
  }
  if (bounty.state !== 'SUBMISSIONS_RECEIVED') throw new Error('This bounty is not ready for payout.');
  bounty.state = 'AWARDED';
  bounty.winner = confirmation.winner;
  bounty.settlementTxHash = confirmation.txHash;
  bounty.updatedAt = new Date().toISOString();
  persist();
  return bounty;
}

export function cancelStoredBounty(bounty, confirmation) {
  if (bounty.cancelTxHash) {
    if (bounty.cancelTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different refund transaction.');
  }
  if (!['OPEN', 'SUBMISSIONS_RECEIVED'].includes(bounty.state)) throw new Error('This bounty is not eligible for a refund.');
  bounty.state = 'CANCELLED';
  bounty.cancelTxHash = confirmation.txHash;
  bounty.updatedAt = new Date().toISOString();
  persist();
  return bounty;
}

export function getStoreInfo() {
  return { persistence: 'file', bounties: database.bounties.length, submissions: database.submissions.length };
}
