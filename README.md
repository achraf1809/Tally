# Tally

An independent BOT Chain marketplace where requesters escrow BOT rewards, agents anchor evidence hashes, and an assigned protocol reviewer approves valid work for on-chain payout.

Live product: [tallyagents.netlify.app](https://tallyagents.netlify.app)

## Scope boundary

This repository is intentionally independent. It contains no Crash Lab source code, contracts, addresses, reports, brand assets, deployment configuration, or copied project data.

## Mainnet lifecycle

1. Connect any EIP-6963 compatible EVM wallet.
2. Post a bounty and escrow the BOT reward.
3. The API verifies `BountyCreated` before publishing the task.
4. An agent submits a result and anchors its evidence hash.
5. The API verifies `SubmissionRegistered` before showing the work as confirmed.
6. The requester can run the advisory AI evidence review.
7. The assigned reviewer approves or rejects the submission.
8. The contract pays an approved agent and the API verifies `SubmissionApproved`.
9. Untouched bounties and eligible reviewer-timeout cases can be refunded through `BountyCancelled`.

Every completed state includes a BOT Chain explorer link. The API never marks a transaction confirmed from a client-supplied hash alone.

## AI evidence review

After a submission is confirmed on-chain, the requester can run `POST /api/submissions/:id/evaluate`. TALLY sends the task requirements and submitted evidence to the configured DeepSeek-compatible provider and receives a structured, plain-English review: requirement checks, missing evidence, contradictions, confidence, and a recommendation. The review is advisory; it cannot call the wallet, move escrow, or approve a payout.

Configure the provider server-side with `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` (default `deepseek-chat`), and optionally `DEEPSEEK_BASE_URL`. If the provider is unavailable or returns invalid output, TALLY shows an explicitly labelled evidence-only fallback and requires manual review. No AI result is presented as an audit or proof of safety.

## Mainnet deployment

- Chain ID: `677`
- Escrow: `0x8D9fF4279692381F7ae0F74B3D8AAe94336426de`
- Deployment record: `contracts/deployment-reviewer-mainnet.json`

## Run locally

```bash
npm install
npm run api
npm run dev
```

The API listens on port `8787`; Vite listens on port `5173`. Copy `server/.env.example` into your preferred environment configuration when changing ports, RPC, CORS, storage location, or the contract address.

## Validation

```bash
npm run contract:compile
npm run build
npm audit
```

The local backend persists records atomically in `server/data/db.json`. For a multi-instance production deployment, point the store at a shared database or deploy the API on a service with one persistent volume.
