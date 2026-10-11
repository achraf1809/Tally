# Reviewer escrow deployment

`ReviewerEscrow.sol` is the next contract version for TALLY. It keeps the existing
`BountyEscrow` deployment untouched and moves settlement authority to a protocol
reviewer service.

## Roles

- **Requester:** creates the bounty and locks BOT. They can cancel only before the first submission.
- **Primary reviewer:** the only address that can approve/reject during the first review window.
- **Backup reviewer:** activated by anyone after the primary SLA expires.
- **Anyone:** may trigger backup activation or the final timeout refund; no one can redirect escrow.

Existing bounties store their assigned reviewers, so changing the protocol defaults
does not rewrite an in-flight task.

## Testnet deployment

Compile and run the local behavioral suite:

```bash
npm run contract:compile:reviewer
npm run contract:test:reviewer
```

Deploy only with a funded deployer key and two separately controlled reviewer
addresses. The deploy script does not read `.agent-wallet.local.json` and never
prints a private key:

```bash
set DEPLOYER_PRIVATE_KEY=...
set REVIEWER_ADDRESS=0x...
set BACKUP_REVIEWER_ADDRESS=0x...
set REVIEW_WINDOW_SECONDS=172800
npm run contract:deploy:reviewer
```

Review the constructor addresses and transaction in the explorer before wiring the
frontend/API to the new address.
