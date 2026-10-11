import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, parseEther } from 'ethers';
import artifact from '../artifacts/ReviewerEscrow.json' with { type: 'json' };

const eip1193 = ganache.provider({
  chain: { chainId: 968 },
  wallet: { totalAccounts: 6, defaultBalance: 100 },
  logging: { quiet: true },
});
const provider = new BrowserProvider(eip1193);
const [owner, requester, agent, reviewer, backup, stranger] = await Promise.all(
  (await provider.listAccounts()).map((account) => provider.getSigner(account.address)),
);
const [ownerAddress, requesterAddress, agentAddress, reviewerAddress, backupAddress, strangerAddress] = await Promise.all(
  [owner, requester, agent, reviewer, backup, stranger].map((signer) => signer.getAddress()),
);

const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
const escrow = await factory.deploy(reviewerAddress, backupAddress, 20);
await escrow.waitForDeployment();

async function now() {
  return (await provider.getBlock('latest')).timestamp;
}

async function advance(seconds) {
  await eip1193.request({ method: 'evm_increaseTime', params: [seconds] });
  await eip1193.request({ method: 'evm_mine', params: [] });
}

async function expectRevert(action, reason) {
  try {
    await action();
    assert.fail(`Expected revert: ${reason}`);
  } catch (error) {
    const message = [
      error?.message,
      error?.reason,
      error?.shortMessage,
      error?.info?.error?.data?.reason,
      error?.info?.error?.message,
    ].filter(Boolean).join(' ');
    assert.match(message, new RegExp(reason), `Expected revert reason: ${reason}`);
  }
}

async function createAndSubmit(deadlineSeconds = 100) {
  const deadline = (await now()) + deadlineSeconds;
  const bountyId = Number(await escrow.nextBountyId());
  await (await escrow.connect(requester).createBounty('0x' + '11'.repeat(32), deadline, { value: parseEther('1') })).wait();
  await (await escrow.connect(agent).registerSubmission(bountyId, '0x' + '22'.repeat(32))).wait();
  return bountyId;
}

assert.equal(await escrow.owner(), ownerAddress);
assert.equal(await escrow.primaryReviewer(), reviewerAddress);
assert.equal(await escrow.backupReviewer(), backupAddress);

// The requester and an arbitrary wallet cannot approve or release escrow.
await createAndSubmit();
await expectRevert(() => escrow.connect(requester).approveSubmission(0, agentAddress), 'not assigned reviewer');
await expectRevert(() => escrow.connect(stranger).approveSubmission(0, agentAddress), 'not assigned reviewer');

// The assigned reviewer can approve and the reward is paid to the agent.
await (await escrow.connect(reviewer).approveSubmission(0, agentAddress)).wait();
const awarded = await escrow.bounties(0);
assert.equal(Number(awarded.state), 2, 'bounty should be AWARDED');
assert.equal(awarded.winner.toLowerCase(), agentAddress.toLowerCase());

// A requester can cancel before any submission, but cannot cancel after submission.
const deadline = (await now()) + 100;
await (await escrow.connect(requester).createBounty('0x' + '33'.repeat(32), deadline, { value: parseEther('1') })).wait();
await (await escrow.connect(requester).cancelBounty(1)).wait();
assert.equal(Number((await escrow.bounties(1)).state), 3, 'empty bounty should be CANCELLED');

// A missed primary-reviewer SLA activates the backup reviewer; a second missed SLA refunds escrow.
await createAndSubmit(10);
await advance(31);
await (await escrow.connect(stranger).activateBackupReviewer(2)).wait();
assert.equal((await escrow.bounties(2)).reviewer.toLowerCase(), backupAddress.toLowerCase());
await expectRevert(() => escrow.connect(reviewer).approveSubmission(2, agentAddress), 'not assigned reviewer');
await advance(21);
await (await escrow.connect(stranger).refundAfterReviewTimeout(2)).wait();
assert.equal(Number((await escrow.bounties(2)).state), 3, 'unreviewed bounty should be CANCELLED');

console.log('ReviewerEscrow tests passed: requester locked out, reviewer approval paid, backup timeout and refund verified.');
