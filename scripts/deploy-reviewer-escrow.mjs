import { readFile } from 'node:fs/promises';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

const rpcUrl = process.env.BOT_CHAIN_RPC_URL || 'https://rpc.bohr.life';
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const reviewer = process.env.REVIEWER_ADDRESS;
const backupReviewer = process.env.BACKUP_REVIEWER_ADDRESS;
const reviewWindow = BigInt(process.env.REVIEW_WINDOW_SECONDS || 172800);

if (!privateKey) throw new Error('Set DEPLOYER_PRIVATE_KEY in the shell; never commit it.');
if (!reviewer || !backupReviewer) throw new Error('Set REVIEWER_ADDRESS and BACKUP_REVIEWER_ADDRESS.');

const artifact = JSON.parse(await readFile(new URL('../artifacts/ReviewerEscrow.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider(rpcUrl, 968, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
const contract = await factory.deploy(reviewer, backupReviewer, reviewWindow);
const deploymentTx = contract.deploymentTransaction();
await contract.waitForDeployment();

console.log(JSON.stringify({
  contract: await contract.getAddress(),
  deploymentTx: deploymentTx?.hash,
  deployer: await signer.getAddress(),
  chainId: 968,
  reviewer,
  backupReviewer,
  reviewWindowSeconds: reviewWindow.toString(),
  explorerUrl: `https://scan.bohr.life/address/${await contract.getAddress()}`,
}, null, 2));
