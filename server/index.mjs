import http from 'node:http';
import { Contract, Interface, JsonRpcProvider, getAddress } from 'ethers';
import {
  addSubmission, approveBounty, cancelStoredBounty, createBounty, getBounty,
  getStoreInfo, getSubmission, listBounties, listSubmissions, markOnchain,
  markSubmissionOnchain,
} from './store.mjs';
import { reviewSubmission } from '../lib/reviewer.mjs';

const port = Number(process.env.API_PORT || 8787);
const legacyContractAddress = process.env.LEGACY_BOUNTY_ESCROW_ADDRESS || '0x349Ab37142bA7E2b4D28e86D0624f0d2268A4801';
const testnetReviewerContractAddress = process.env.TESTNET_REVIEWER_ESCROW_ADDRESS || '0x69EB316b3Aff3Fec49Be48D24A6ea304a9B94C9e';
const contractAddress = process.env.BOUNTY_ESCROW_ADDRESS || '0x8D9fF4279692381F7ae0F74B3D8AAe94336426de';
const chainId = Number(process.env.BOT_CHAIN_ID || 677);
const rpcUrl = process.env.BOT_CHAIN_RPC_URL || 'https://rpc.botchain.ai';
const testnetChainId = Number(process.env.BOT_TESTNET_CHAIN_ID || 968);
const testnetRpcUrl = process.env.BOT_TESTNET_RPC_URL || 'https://rpc.bohr.life';
const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
const testnetProvider = new JsonRpcProvider(testnetRpcUrl, testnetChainId, { staticNetwork: true });
const contractInterface = new Interface([
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,uint256 reward,uint64 deadline,bytes32 metadataHash)',
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed reviewer,uint256 reward,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 metadataHash)',
  'event SubmissionRegistered(uint256 indexed bountyId,address indexed agent,bytes32 evidenceHash)',
  'event BountyAwarded(uint256 indexed bountyId,address indexed winner,uint256 reward)',
  'event SubmissionApproved(uint256 indexed bountyId,address indexed agent,uint256 reward)',
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

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.CORS_ORIGIN || 'http://localhost:5173',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request is too large.');
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Error('Request body is not valid JSON.'); }
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
  } catch {
    throw new Error('Result URL must begin with http:// or https://.');
  }
}

function sameAddress(first, second) {
  try { return getAddress(first) === getAddress(second); } catch { return false; }
}

function isReviewerBounty(bounty) {
  return sameAddress(bounty?.contractAddress || legacyContractAddress, contractAddress)
    || sameAddress(bounty?.contractAddress, testnetReviewerContractAddress);
}
function readContractFor(bounty) {
  if (sameAddress(bounty?.contractAddress, contractAddress)) return reviewerReadContract;
  if (sameAddress(bounty?.contractAddress, testnetReviewerContractAddress)) return testnetReviewerReadContract;
  return legacyReadContract;
}
function providerFor(targetAddress) { return sameAddress(targetAddress, contractAddress) ? provider : testnetProvider; }

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
  const event = await confirmedEvent(txHash, 'BountyCreated', bounty.contractAddress || legacyContractAddress);
  if (event.args.metadataHash.toLowerCase() !== bounty.metadataHash.toLowerCase()) throw new Error('Transaction metadata does not match this bounty.');
  if (!sameAddress(event.args.requester, bounty.requester)) throw new Error('Transaction requester does not match this bounty.');
  const chainBounty = await readContractFor(bounty).bounties(event.args.bountyId);
  if (chainBounty.metadataHash.toLowerCase() !== bounty.metadataHash.toLowerCase()) throw new Error('On-chain bounty verification failed.');
  return { txHash, chainBountyId: event.args.bountyId.toString(), requester: event.args.requester };
}

async function verifySubmission(submission, bounty, txHash) {
  const event = await confirmedEvent(txHash, 'SubmissionRegistered', bounty.contractAddress || legacyContractAddress);
  if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Submission belongs to a different bounty.');
  if (!sameAddress(event.args.agent, submission.agent)) throw new Error('Submitting wallet does not match this record.');
  if (event.args.evidenceHash.toLowerCase() !== submission.evidenceHash.toLowerCase()) throw new Error('On-chain evidence does not match the submitted work.');
  const stored = await readContractFor(bounty).submissions(bounty.chainBountyId, event.args.agent);
  const storedHash = isReviewerBounty(bounty) ? stored.evidenceHash : stored;
  if (storedHash.toLowerCase() !== submission.evidenceHash.toLowerCase()) throw new Error('Contract submission verification failed.');
  return { txHash, agent: event.args.agent };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const blockNumber = await provider.getBlockNumber();
      return send(res, 200, { ok: true, service: 'bot-agent-bounties-api', contractAddress, legacyContractAddress, testnetReviewerContractAddress, chainId, rpcUrl, testnetChainId, testnetRpcUrl, blockNumber, store: getStoreInfo() });
    }
    if (req.method === 'GET' && url.pathname === '/api/contract-config') return send(res, 200, { chainId, contractAddress, legacyContractAddress, testnetReviewerContractAddress, rpcUrl, testnetChainId, testnetRpcUrl, status: 'configured' });
    if (req.method === 'GET' && url.pathname === '/api/bounties') return send(res, 200, { data: listBounties() });
    if (req.method === 'POST' && url.pathname === '/api/bounties') {
      const input = await readJson(req);
      const bounty = createBounty({
        requester: requireAddress(input.requester, 'requester'), title: requireString(input.title, 'title', 180),
        description: requireString(input.description, 'description'),
        requirements: Array.isArray(input.requirements) ? input.requirements.filter(Boolean).slice(0, 12).map((item) => requireString(item, 'requirement', 500)) : [],
        reward: requireString(input.reward, 'reward'), deadline: requireString(input.deadline, 'deadline'), contractAddress,
      });
      return send(res, 201, { data: bounty });
    }
    if (parts[0] === 'api' && parts[1] === 'bounties' && parts[2]) {
      const bounty = getBounty(parts[2]);
      if (!bounty) return send(res, 404, { error: 'Bounty not found.' });
      if (req.method === 'GET' && parts.length === 3) {
        const data = { ...bounty, contractType: isReviewerBounty(bounty) ? 'reviewer' : 'legacy', submissions: listSubmissions(bounty.id) };
        if (isReviewerBounty(bounty) && bounty.chainBountyId != null) {
          try {
            const chainBounty = await readContractFor(bounty).bounties(bounty.chainBountyId);
            data.reviewer = chainBounty.reviewer;
            data.backupReviewer = chainBounty.backupReviewer;
            data.reviewDeadline = new Date(Number(chainBounty.reviewDeadline) * 1000).toISOString();
          } catch { /* keep local API usable if RPC is unavailable */ }
        }
        return send(res, 200, { data });
      }
      if (req.method === 'POST' && parts[3] === 'onchain') {
        const input = await readJson(req); const txHash = requireString(input.txHash, 'transaction hash');
        return send(res, 200, { data: markOnchain(bounty, await verifyBountyCreation(bounty, txHash)) });
      }
      if (req.method === 'POST' && parts[3] === 'submissions') {
        const input = await readJson(req);
        const submission = addSubmission(bounty, {
          agent: requireAddress(input.agent, 'agent'), resultUri: optionalHttpUrl(input.resultUri),
          evidence: Array.isArray(input.evidence) ? input.evidence.filter(Boolean).slice(0, 20).map((item) => requireString(item, 'evidence item', 1_000)) : [],
        });
        return send(res, 201, { data: submission });
      }
      if (req.method === 'POST' && parts[3] === 'approve') {
        const input = await readJson(req); const txHash = requireString(input.txHash, 'transaction hash');
        const event = await confirmedEvent(txHash, isReviewerBounty(bounty) ? 'SubmissionApproved' : 'BountyAwarded', bounty.contractAddress || legacyContractAddress);
        if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Award belongs to a different bounty.');
        return send(res, 200, { data: approveBounty(bounty, { txHash, winner: isReviewerBounty(bounty) ? event.args.agent : event.args.winner }) });
      }
      if (req.method === 'POST' && parts[3] === 'cancel') {
        const input = await readJson(req); const txHash = requireString(input.txHash, 'transaction hash');
        const event = await confirmedEvent(txHash, 'BountyCancelled', bounty.contractAddress || legacyContractAddress);
        if (event.args.bountyId.toString() !== String(bounty.chainBountyId)) throw new Error('Refund belongs to a different bounty.');
        return send(res, 200, { data: cancelStoredBounty(bounty, { txHash }) });
      }
    }
    if (parts[0] === 'api' && parts[1] === 'submissions' && parts[2]) {
      const submission = getSubmission(parts[2]);
      if (!submission) return send(res, 404, { error: 'Submission not found.' });
      if (req.method === 'POST' && parts[3] === 'onchain') {
        const input = await readJson(req); const txHash = requireString(input.txHash, 'transaction hash');
        const bounty = getBounty(submission.bountyId);
        return send(res, 200, { data: markSubmissionOnchain(submission, await verifySubmission(submission, bounty, txHash)) });
      }
      if (req.method === 'POST' && parts[3] === 'evaluate') {
        const bounty = getBounty(submission.bountyId);
        if (!bounty) return send(res, 404, { error: 'Bounty not found.' });
        if (submission.state !== 'CONFIRMED') throw new Error('Only on-chain confirmed submissions can be reviewed.');
        return send(res, 200, { data: await reviewSubmission({ bounty, submission }) });
      }
    }
    return send(res, 404, { error: 'Route not found.' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}:`, error);
    return send(res, 400, { error: error.message || 'Request could not be completed.' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`BOT Agent Bounties API listening on http://localhost:${port}`));
