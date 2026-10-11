import { Contract, Interface, JsonRpcProvider, formatEther, getAddress } from 'ethers';
import {
  createBounty, createSubmission, getBounty, getCounts, getSubmission, listBounties,
  listSubmissions, markAwarded, markBountyOnchain, markCancelled, markSubmissionOnchain, markSubmissionRejected, upsertRecoveredBounty,
} from '../lib/database.mjs';
import { reviewSubmission } from '../../lib/reviewer.mjs';

const legacyContractAddress = process.env.LEGACY_BOUNTY_ESCROW_ADDRESS || '0x349Ab37142bA7E2b4D28e86D0624f0d2268A4801';
const testnetReviewerContractAddress = process.env.TESTNET_REVIEWER_ESCROW_ADDRESS || '0x69EB316b3Aff3Fec49Be48D24A6ea304a9B94C9e';
const contractAddress = process.env.BOUNTY_ESCROW_ADDRESS || '0x8D9fF4279692381F7ae0F74B3D8AAe94336426de';
const chainId = Number(process.env.BOT_CHAIN_ID || 677);
const rpcUrl = process.env.BOT_CHAIN_RPC_URL || 'https://rpc.botchain.ai';
const testnetChainId = Number(process.env.BOT_TESTNET_CHAIN_ID || 968);
const testnetRpcUrl = process.env.BOT_TESTNET_RPC_URL || 'https://rpc.bohr.life';
const reviewerDeploymentBlock = Number(process.env.BOUNTY_ESCROW_DEPLOYMENT_BLOCK || 21021352);
const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
const testnetProvider = new JsonRpcProvider(testnetRpcUrl, testnetChainId, { staticNetwork: true });
const contractInterface = new Interface([
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,uint256 reward,uint64 deadline,bytes32 metadataHash)',
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed reviewer,uint256 reward,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 metadataHash)',
  'event SubmissionRegistered(uint256 indexed bountyId,address indexed agent,bytes32 evidenceHash)',
  'event BountyAwarded(uint256 indexed bountyId,address indexed winner,uint256 reward)',
  'event SubmissionApproved(uint256 indexed bountyId,address indexed agent,uint256 reward)',
  'event SubmissionRejected(uint256 indexed bountyId,address indexed agent,bytes32 evidenceHash)',
  'event BountyCancelled(uint256 indexed bountyId,uint256 refund)',
]);
const legacyReadContract = new Contract(legacyContractAddress, [
  'function bounties(uint256) view returns (address requester,uint64 deadline,uint256 reward,bytes32 metadataHash,uint8 state,address winner)',
  'function submissions(uint256,address) view returns (bytes32)',
], testnetProvider);
const reviewerReadContract = new Contract(contractAddress, [
  'function bounties(uint256) view returns (address requester,address reviewer,address backupReviewer,uint64 submissionDeadline,uint64 reviewDeadline,uint256 reward,bytes32 metadataHash,uint8 state,address winner)',
  'function submissions(uint256,address) view returns (bytes32 evidenceHash,uint8 state)',
], provider);
const testnetReviewerReadContract = new Contract(testnetReviewerContractAddress, [
  'function bounties(uint256) view returns (address requester,address reviewer,address backupReviewer,uint64 submissionDeadline,uint64 reviewDeadline,uint256 reward,bytes32 metadataHash,uint8 state,address winner)',
  'function submissions(uint256,address) view returns (bytes32 evidenceHash,uint8 state)',
], testnetProvider);

function json(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

function requireString(value, field, maximumLength = 8_000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  const result = value.trim();
  if (result.length > maximumLength) throw new Error(`${field} is too long.`);
  return result;
}

function requireAddress(value, field) {
  const address = requireString(value, field, 42);
  try { return getAddress(address); } catch { throw new Error(`${field} is not a valid wallet address.`); }
}

function optionalHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch { throw new Error('Result URL must begin with http:// or https://.'); }
}

function sameAddress(first, second) {
  try { return getAddress(first) === getAddress(second); } catch { return false; }
}

function isReviewerBounty(bounty) {
  return sameAddress(bounty?.contractAddress, contractAddress) || sameAddress(bounty?.contractAddress, testnetReviewerContractAddress);
}

function readContractFor(bounty) {
  if (sameAddress(bounty?.contractAddress, contractAddress)) return reviewerReadContract;
  if (sameAddress(bounty?.contractAddress, testnetReviewerContractAddress)) return testnetReviewerReadContract;
  return legacyReadContract;
}

function providerFor(targetAddress) {
  return sameAddress(targetAddress, contractAddress) ? provider : testnetProvider;
}

function reviewerStateLabel(state) {
  return ({ 0: 'OPEN', 1: 'SUBMISSIONS_RECEIVED', 2: 'AWARDED', 3: 'CANCELLED' })[Number(state)] || 'OPEN';
}

/**
 * Reconcile confirmed BountyCreated events into the database. A blockchain
 * transaction is the source of truth; this makes a successful escrow write
 * recoverable even if the tab closes before the API confirmation request.
 */
async function reconcileMainnetBounties() {
  const latestBlock = await provider.getBlockNumber();
  if (latestBlock < reviewerDeploymentBlock) return;
  const logs = await provider.getLogs({ address: contractAddress, fromBlock: reviewerDeploymentBlock, toBlock: latestBlock });
  const settlementTxByBounty = new Map();
  const cancelTxByBounty = new Map();
  for (const log of logs) {
    let event;
    try { event = contractInterface.parseLog(log); } catch { continue; }
    if (event?.name === 'SubmissionApproved' || event?.name === 'BountyAwarded') settlementTxByBounty.set(event.args.bountyId.toString(), log.transactionHash);
    if (event?.name === 'BountyCancelled') cancelTxByBounty.set(event.args.bountyId.toString(), log.transactionHash);
  }
  for (const log of logs) {
    let event;
    try { event = contractInterface.parseLog(log); } catch { continue; }
    if (!event || event.name !== 'BountyCreated') continue;
    const chainBountyId = event.args.bountyId.toString();
    const chainBounty = await reviewerReadContract.bounties(chainBountyId);
    const deadlineSeconds = Number(chainBounty.submissionDeadline);
    if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) continue;
    const state = reviewerStateLabel(chainBounty.state);
    await upsertRecoveredBounty({
      chainBountyId,
      createTxHash: log.transactionHash,
      requester: chainBounty.requester,
      // Keep the original escrow amount visible after payout/refund zeroes the
      // contract's live reward field.
      reward: formatEther(event.args.reward),
      deadline: new Date(deadlineSeconds * 1000).toISOString(),
      metadataHash: chainBounty.metadataHash,
      state,
      winner: chainBounty.winner,
      settlementTxHash: settlementTxByBounty.get(chainBountyId) || null,
      cancelTxHash: cancelTxByBounty.get(chainBountyId) || null,
      contractAddress,
      title: `Recovered BOT Chain bounty #${chainBountyId}`,
      description: 'This market was recovered from a confirmed BOT Chain escrow transaction. Review the on-chain creation proof before accepting work.',
      requirements: ['Review the on-chain creation transaction', 'Confirm the requested outcome with the requester', 'Return a readable result with supporting evidence'],
    });
  }
}

async function confirmedEvent(txHash, eventName, targetAddress) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('Transaction hash is invalid.');
  const receipt = await providerFor(targetAddress).getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Transaction is not confirmed yet.');
  if (receipt.status !== 1) throw new Error('Transaction failed on BOT Chain.');
  const log = receipt.logs.find((entry) => {
    if (!sameAddress(entry.address, targetAddress)) return false;
    try { return contractInterface.parseLog(entry)?.name === eventName; } catch { return false; }
  });
  if (!log) throw new Error(`Transaction does not contain ${eventName} from the configured escrow.`);
  return contractInterface.parseLog(log);
}

async function verifyBountyCreation(bounty, txHash) {
  const event = await confirmedEvent(txHash, 'BountyCreated', bounty.contractAddress);
  if (event.args.metadataHash.toLowerCase() !== bounty.metadataHash.toLowerCase()) throw new Error('Transaction metadata does not match this bounty.');
  if (!sameAddress(event.args.requester, bounty.requester)) throw new Error('Transaction requester does not match this bounty.');
  const chainBounty = await readContractFor(bounty).bounties(event.args.bountyId);
  if (chainBounty.metadataHash.toLowerCase() !== bounty.metadataHash.toLowerCase()) throw new Error('On-chain bounty verification failed.');
  return { txHash, chainBountyId: event.args.bountyId.toString(), requester: event.args.requester };
}

async function verifySubmission(submission, bounty, txHash) {
  const event = await confirmedEvent(txHash, 'SubmissionRegistered', bounty.contractAddress);
  if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Submission belongs to a different bounty.');
  if (!sameAddress(event.args.agent, submission.agent)) throw new Error('Submitting wallet does not match this record.');
  if (event.args.evidenceHash.toLowerCase() !== submission.evidenceHash.toLowerCase()) throw new Error('On-chain evidence does not match the submitted work.');
  const stored = await readContractFor(bounty).submissions(bounty.chainBountyId, event.args.agent);
  const storedHash = isReviewerBounty(bounty) ? stored.evidenceHash : stored;
  if (storedHash.toLowerCase() !== submission.evidenceHash.toLowerCase()) throw new Error('Contract submission verification failed.');
  return { txHash, agent: event.args.agent };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(200, { ok: true, service: 'bot-agent-bounties-netlify-api', contractAddress, legacyContractAddress, testnetReviewerContractAddress, chainId, rpcUrl, testnetChainId, testnetRpcUrl, blockNumber: await provider.getBlockNumber(), store: await getCounts() });
    }
    if (req.method === 'GET' && url.pathname === '/api/contract-config') return json(200, { chainId, contractAddress, legacyContractAddress, testnetReviewerContractAddress, rpcUrl, testnetChainId, testnetRpcUrl, status: 'configured' });
    if (req.method === 'GET' && url.pathname === '/api/bounties') {
      try { await reconcileMainnetBounties(); } catch (error) { console.error('mainnet bounty reconciliation failed', error); }
      return json(200, { data: await listBounties() });
    }
    if (req.method === 'POST' && url.pathname === '/api/bounties') {
      const input = await req.json();
      const bounty = await createBounty({
        requester: requireAddress(input.requester, 'requester'), title: requireString(input.title, 'title', 180),
        description: requireString(input.description, 'description'),
        requirements: Array.isArray(input.requirements) ? input.requirements.filter(Boolean).slice(0, 12).map((item) => requireString(item, 'requirement', 500)) : [],
        reward: requireString(input.reward, 'reward'), deadline: requireString(input.deadline, 'deadline'), contractAddress,
      });
      return json(201, { data: bounty });
    }
    if (parts[0] === 'api' && parts[1] === 'bounties' && parts[2]) {
      const bounty = await getBounty(parts[2]);
      if (!bounty) return json(404, { error: 'Bounty not found.' });
      if (req.method === 'GET' && parts.length === 3) {
        const data = { ...bounty, contractType: isReviewerBounty(bounty) ? 'reviewer' : 'legacy', submissions: await listSubmissions(bounty.id) };
        if (isReviewerBounty(bounty) && bounty.chainBountyId != null) {
          try {
            const chainBounty = await readContractFor(bounty).bounties(bounty.chainBountyId);
            data.reviewer = chainBounty.reviewer;
            data.backupReviewer = chainBounty.backupReviewer;
            data.reviewDeadline = new Date(Number(chainBounty.reviewDeadline) * 1000).toISOString();
          } catch { /* keep the database response usable while RPC is unavailable */ }
        }
        return json(200, { data });
      }
      if (req.method === 'POST' && parts[3] === 'onchain') {
        const input = await req.json(); const txHash = requireString(input.txHash, 'transaction hash');
        return json(200, { data: await markBountyOnchain(bounty, await verifyBountyCreation(bounty, txHash)) });
      }
      if (req.method === 'POST' && parts[3] === 'submissions') {
        const input = await req.json();
        const submission = await createSubmission(bounty, {
          agent: requireAddress(input.agent, 'agent'), resultUri: optionalHttpUrl(input.resultUri),
          evidence: Array.isArray(input.evidence) ? input.evidence.filter(Boolean).slice(0, 20).map((item) => requireString(item, 'evidence item', 1_000)) : [],
        });
        return json(201, { data: submission });
      }
      if (req.method === 'POST' && parts[3] === 'approve') {
        const input = await req.json(); const txHash = requireString(input.txHash, 'transaction hash');
        const event = await confirmedEvent(txHash, isReviewerBounty(bounty) ? 'SubmissionApproved' : 'BountyAwarded', bounty.contractAddress);
        if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Award belongs to a different bounty.');
        return json(200, { data: await markAwarded(bounty, { txHash, winner: isReviewerBounty(bounty) ? event.args.agent : event.args.winner }) });
      }
      if (req.method === 'POST' && parts[3] === 'reject') {
        const input = await req.json(); const txHash = requireString(input.txHash, 'transaction hash');
        const event = await confirmedEvent(txHash, 'SubmissionRejected', bounty.contractAddress);
        if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Rejection belongs to a different bounty.');
        return json(200, { data: await markSubmissionRejected(bounty, { txHash, agent: event.args.agent }) });
      }
      if (req.method === 'POST' && parts[3] === 'cancel') {
        const input = await req.json(); const txHash = requireString(input.txHash, 'transaction hash');
        const event = await confirmedEvent(txHash, 'BountyCancelled', bounty.contractAddress);
        if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Refund belongs to a different bounty.');
        return json(200, { data: await markCancelled(bounty, { txHash }) });
      }
    }
    if (parts[0] === 'api' && parts[1] === 'submissions' && parts[2]) {
      const submission = await getSubmission(parts[2]);
      if (!submission) return json(404, { error: 'Submission not found.' });
      if (req.method === 'POST' && parts[3] === 'onchain') {
        const input = await req.json(); const txHash = requireString(input.txHash, 'transaction hash');
        const bounty = await getBounty(submission.bountyId);
        return json(200, { data: await markSubmissionOnchain(submission, await verifySubmission(submission, bounty, txHash)) });
      }
      if (req.method === 'POST' && parts[3] === 'evaluate') {
        const bounty = await getBounty(submission.bountyId);
        if (!bounty) return json(404, { error: 'Bounty not found.' });
        if (submission.state !== 'CONFIRMED') throw new Error('Only on-chain confirmed submissions can be reviewed.');
        return json(200, { data: await reviewSubmission({ bounty, submission }) });
      }
    }
    return json(404, { error: 'Route not found.' });
  } catch (error) {
    console.error(`${req.method} ${url.pathname}`, error);
    return json(400, { error: error.message || 'Request could not be completed.' });
  }
}

export const config = { path: '/api/*' };
