import { BrowserProvider, Contract, id, parseEther } from 'ethers';

export const BOT_CHAIN = {
  chainId: 677,
  chainHex: '0x2a5',
  chainName: 'BOT Chain Mainnet',
  rpcUrl: 'https://rpc.botchain.ai',
  explorerUrl: 'https://scan.botchain.ai',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
};

export const LEGACY_ESCROW_ADDRESS = '0x349Ab37142bA7E2b4D28e86D0624f0d2268A4801';
export const ESCROW_ADDRESS = import.meta.env.VITE_BOUNTY_ESCROW_ADDRESS || '0x8D9fF4279692381F7ae0F74B3D8AAe94336426de';
export const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8787' : '');

export const ESCROW_ABI = [
  'function createBounty(bytes32 metadataHash, uint64 deadline) payable returns (uint256 bountyId)',
  'function registerSubmission(uint256 bountyId, bytes32 evidenceHash)',
  'function approveSubmission(uint256 bountyId, address payable agent)',
  'function rejectSubmission(uint256 bountyId, address agent)',
  'function cancelBounty(uint256 bountyId)',
  'function activateBackupReviewer(uint256 bountyId)',
  'function refundAfterReviewTimeout(uint256 bountyId)',
  'function nextBountyId() view returns (uint256)',
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,uint256 reward,uint64 deadline,bytes32 metadataHash)',
  'event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed reviewer,uint256 reward,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 metadataHash)',
  'event SubmissionRegistered(uint256 indexed bountyId,address indexed agent,bytes32 evidenceHash)',
  'event SubmissionApproved(uint256 indexed bountyId,address indexed agent,uint256 reward)',
  'event SubmissionRejected(uint256 indexed bountyId,address indexed agent,bytes32 evidenceHash)',
  'event BackupReviewerActivated(uint256 indexed bountyId,address indexed reviewer,uint64 reviewDeadline)',
  'event BountyCancelled(uint256 indexed bountyId,uint256 refund)',
];

export function explainWalletError(error) {
  const code = Number(error?.code ?? error?.data?.originalError?.code);
  const raw = String(error?.shortMessage ?? error?.reason ?? error?.message ?? '').trim();
  const message = raw.toLowerCase();

  if (message.includes('insufficient funds') || code === -32000 && message.includes('fund')) {
    return 'This wallet does not have enough BOT for the reward and network fee. Add BOT, then try again.';
  }
  if (code === 4001 || message.includes('user rejected') || message.includes('action_rejected') || message.includes('cancelled')) {
    return 'The wallet request was cancelled. Try again when you are ready.';
  }
  if (message.includes('wrong network') || message.includes('chain 968') || message.includes('bot chain testnet')) {
    return raw.length < 180 ? raw : 'Switch the selected wallet to BOT Chain Mainnet, then try again.';
  }
  if (message.includes('failed to fetch') || message.includes('network error') || message.includes('could not connect')) {
    return 'BOT Chain Mainnet could not be reached. Check your connection and try again.';
  }
  if (message.includes('execution reverted') || message.includes('call_exception') || message.includes('missing revert data')) {
    return 'The contract could not complete this request. Check the bounty details and try again.';
  }
  if (message.includes('nonce too low') || message.includes('replacement transaction')) {
    return 'Your wallet has another transaction pending. Wait for it to finish, then try again.';
  }
  if (message.includes('invalid decimal') || message.includes('invalid value') || message.includes('underflow')) {
    return 'Enter a valid BOT reward amount, such as 0.02.';
  }
  if (message.includes('estimate gas') || message.includes('gas required exceeds')) {
    return 'The wallet could not calculate the network fee. Check your balance and bounty details, then try again.';
  }

  const looksSafe = raw.length > 0 && raw.length <= 180 && !/[{}\[\]"]/.test(raw) && !/transaction=|payload=|info=|jsonrpc|0x[a-f0-9]{20,}/i.test(raw);
  return looksSafe ? raw : 'Something went wrong while talking to the wallet. Check the wallet notification and try again.';
}

export function hasWallet() {
  return typeof window !== 'undefined' && Boolean(window.ethereum || window.rabby);
}

function describeProvider(provider, info = {}) {
  return info.name || (provider?.isRabby ? 'Rabby Wallet' : provider?.isMetaMask ? 'MetaMask' : provider?.isCoinbaseWallet ? 'Coinbase Wallet' : 'Injected Wallet');
}

export async function discoverWallets() {
  if (typeof window === 'undefined') return [];
  const discovered = [];
  const seen = new Set();
  const add = (provider, info = {}) => {
    if (!provider || seen.has(provider)) return;
    seen.add(provider);
    discovered.push({ id: info.rdns || `${describeProvider(provider, info)}-${discovered.length}`, name: describeProvider(provider, info), provider });
  };
  if (window.rabby?.ethereum) add(window.rabby.ethereum, { name: 'Rabby Wallet', rdns: 'io.rabby' });
  if (Array.isArray(window.ethereum?.providers)) window.ethereum.providers.forEach((provider) => add(provider));
  if (window.ethereum) add(window.ethereum);
  return new Promise((resolve) => {
    const onProvider = (event) => {
      const { info, provider } = event.detail || {};
      add(provider, info);
    };
    window.addEventListener('eip6963:announceProvider', onProvider);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onProvider);
      resolve(discovered);
    }, 250);
  });
}

export async function connectBotWallet(injectedProvider) {
  if (!injectedProvider) throw new Error('Choose an installed EVM wallet to continue.');
  await injectedProvider.request({ method: 'eth_requestAccounts' });
  let chainId = await injectedProvider.request({ method: 'eth_chainId' });
  if (Number.parseInt(chainId, 16) !== BOT_CHAIN.chainId) {
    try {
      await injectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BOT_CHAIN.chainHex }] });
    } catch (switchError) {
      const errorCode = Number(switchError?.code ?? switchError?.data?.originalError?.code);
      const errorMessage = String(switchError?.message ?? switchError?.data?.originalError?.message ?? '');
      if (errorCode === 4001) throw new Error('Network switch was cancelled.');
      const shouldAddChain = errorCode === 4902 || errorCode === -32603 || /unknown|unrecognized|not added|does not exist/i.test(errorMessage);
      if (!shouldAddChain) throw new Error(`The selected wallet could not switch networks (${Number.isFinite(errorCode) ? errorCode : 'provider error'}).`);
      try {
        await injectedProvider.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: BOT_CHAIN.chainHex,
          chainName: BOT_CHAIN.chainName,
          nativeCurrency: BOT_CHAIN.nativeCurrency,
          rpcUrls: [BOT_CHAIN.rpcUrl],
          blockExplorerUrls: [BOT_CHAIN.explorerUrl],
        }] });
      } catch (addError) {
        const addCode = Number(addError?.code ?? addError?.data?.originalError?.code);
        if (addCode === 4001) throw new Error('Network setup was cancelled.');
        throw new Error(`The selected wallet could not add BOT Chain Mainnet (${Number.isFinite(addCode) ? addCode : 'provider error'}).`);
      }
      chainId = await injectedProvider.request({ method: 'eth_chainId' });
      if (Number.parseInt(chainId, 16) !== BOT_CHAIN.chainId) {
        await injectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BOT_CHAIN.chainHex }] });
      }
    }
    chainId = await injectedProvider.request({ method: 'eth_chainId' });
  }
  if (Number.parseInt(chainId, 16) !== BOT_CHAIN.chainId) throw new Error('The wallet is still on the wrong network. Select BOT Chain Mainnet and try again.');
  const provider = new BrowserProvider(injectedProvider);
  const signer = await provider.getSigner();
  return { provider, signer, injectedProvider, address: await signer.getAddress() };
}

export async function restoreBotWallet(injectedProvider) {
  if (!injectedProvider) return null;
  const accounts = await injectedProvider.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts) || !accounts[0]) return null;
  return { injectedProvider, address: accounts[0] };
}

export async function createOnchainBounty({ metadataHash, deadline, reward, walletProvider }) {
  const { signer } = await connectBotWallet(walletProvider);
  const contract = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
  const tx = await contract.createBounty(metadataHash || id('missing-metadata'), Math.floor(new Date(deadline).getTime() / 1000), { value: parseEther(reward) });
  const receipt = await tx.wait();
  let chainBountyId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'BountyCreated') chainBountyId = parsed.args.bountyId.toString();
    } catch {
      // Ignore logs emitted by other contracts.
    }
  }
  return { txHash: tx.hash, chainBountyId, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

async function escrowWithSigner(walletProvider) {
  const { signer } = await connectBotWallet(walletProvider);
  return new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
}

export async function submitOnchainWork({ bountyId, evidenceHash, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.registerSubmission(bountyId, evidenceHash);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export async function approveOnchainSubmission({ bountyId, agent, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.approveSubmission(bountyId, agent);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export async function rejectOnchainSubmission({ bountyId, agent, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.rejectSubmission(bountyId, agent);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export async function cancelOnchainBounty({ bountyId, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.cancelBounty(bountyId);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export async function refundOnchainBounty({ bountyId, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.refundAfterReviewTimeout(bountyId);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export async function activateOnchainBackupReviewer({ bountyId, walletProvider }) {
  const contract = await escrowWithSigner(walletProvider);
  const tx = await contract.activateBackupReviewer(bountyId);
  await tx.wait();
  return { txHash: tx.hash, explorerUrl: `${BOT_CHAIN.explorerUrl}/tx/${tx.hash}` };
}

export function transactionUrl(txHash) {
  return txHash ? `${BOT_CHAIN.explorerUrl}/tx/${txHash}` : '#';
}
