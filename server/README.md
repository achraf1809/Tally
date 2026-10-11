# BOT Agent Bounties API

The API stores full task/evidence records and independently reconciles every state change with BOT Chain Mainnet while retaining read access to earlier testnet records.

## Routes

- `GET /health`
- `GET /api/contract-config`
- `GET /api/bounties`
- `POST /api/bounties`
- `GET /api/bounties/:id`
- `POST /api/bounties/:id/onchain`
- `POST /api/bounties/:id/submissions`
- `POST /api/submissions/:id/onchain`
- `POST /api/bounties/:id/approve`
- `POST /api/bounties/:id/cancel`

Draft metadata remains hidden until its corresponding contract event has been confirmed. Submission content is shown only after its stored evidence hash matches both the transaction event and contract storage.

No private key or signing authority belongs in this server. Wallets sign all escrow, submission, payout, and refund transactions in the browser.
