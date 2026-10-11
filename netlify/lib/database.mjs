import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from '@netlify/database';

const db = getDatabase();

function hash(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function mapBounty(row) {
  if (!row) return null;
  return {
    id: row.id,
    requester: row.requester,
    title: row.title,
    description: row.description,
    requirements: row.requirements || [],
    reward: row.reward,
    deadline: iso(row.deadline),
    metadataHash: row.metadata_hash,
    contractAddress: row.contract_address || '0x349Ab37142bA7E2b4D28e86D0624f0d2268A4801',
    state: row.state,
    chainBountyId: row.chain_bounty_id == null ? null : String(row.chain_bounty_id),
    createTxHash: row.create_tx_hash,
    winner: row.winner,
    settlementTxHash: row.settlement_tx_hash,
    cancelTxHash: row.cancel_tx_hash,
    submissionCount: Number(row.submission_count || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    bountyId: row.bounty_id,
    agent: row.agent,
    resultUri: row.result_uri,
    evidence: row.evidence || [],
    evidenceHash: row.evidence_hash,
    state: row.state,
    txHash: row.tx_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createMetadataHash(input) {
  return hash(JSON.stringify({
    requester: input.requester,
    title: input.title,
    description: input.description,
    requirements: input.requirements ?? [],
    reward: input.reward,
    deadline: input.deadline,
  }));
}

export async function listBounties() {
  const rows = await db.sql`
    SELECT b.*, COUNT(s.id)::int AS submission_count
    FROM bounties b
    LEFT JOIN submissions s ON s.bounty_id = b.id AND s.state = 'CONFIRMED'
    WHERE b.state <> 'DRAFT'
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `;
  const hiddenIds = new Set(String(process.env.TALLY_HIDDEN_BOUNTY_IDS || '2').split(',').map((value) => value.trim()).filter(Boolean));
  return rows.filter((row) => !hiddenIds.has(String(row.chain_bounty_id))).map(mapBounty);
}

/**
 * Attach a confirmed on-chain bounty to its database record. This is used by
 * the chain reconciler when a wallet transaction succeeded but the browser
 * closed before the normal confirmation callback reached the API.
 */
export async function upsertRecoveredBounty(input) {
  const chainBountyId = String(input.chainBountyId);
  const metadataHash = String(input.metadataHash);
  const createTxHash = String(input.createTxHash);
  const contractAddress = input.contractAddress;
  const requirements = JSON.stringify(input.requirements ?? []);
  const title = input.title || `Recovered on-chain bounty #${chainBountyId}`;
  const description = input.description || 'This market was recovered from a confirmed BOT Chain escrow transaction.';
  const [existing] = await db.sql`
    SELECT * FROM bounties
    WHERE chain_bounty_id = ${chainBountyId} OR create_tx_hash = ${createTxHash}
       OR (state = 'DRAFT' AND metadata_hash = ${metadataHash})
    ORDER BY CASE WHEN state = 'DRAFT' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `;
  if (existing) {
    const [row] = await db.sql`
      UPDATE bounties
      SET requester = ${input.requester}, title = CASE WHEN state = 'DRAFT' THEN ${title} ELSE title END,
          description = CASE WHEN state = 'DRAFT' THEN ${description} ELSE description END,
          requirements = CASE WHEN state = 'DRAFT' THEN ${requirements}::jsonb ELSE requirements END,
          reward = ${input.reward}, deadline = ${input.deadline}, metadata_hash = ${metadataHash},
          state = ${input.state}, chain_bounty_id = ${chainBountyId}, create_tx_hash = ${createTxHash},
          contract_address = ${contractAddress}, winner = ${input.winner || null},
          settlement_tx_hash = COALESCE(${input.settlementTxHash || null}, settlement_tx_hash),
          cancel_tx_hash = COALESCE(${input.cancelTxHash || null}, cancel_tx_hash), updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;
    return mapBounty(row);
  }
  const [row] = await db.sql`
    INSERT INTO bounties (id, requester, title, description, requirements, reward, deadline, metadata_hash, state, chain_bounty_id, create_tx_hash, winner, settlement_tx_hash, cancel_tx_hash, contract_address)
    VALUES (${randomUUID()}, ${input.requester}, ${title}, ${description}, ${requirements}::jsonb, ${input.reward}, ${input.deadline}, ${metadataHash}, ${input.state}, ${chainBountyId}, ${createTxHash}, ${input.winner || null}, ${input.settlementTxHash || null}, ${input.cancelTxHash || null}, ${contractAddress})
    ON CONFLICT (chain_bounty_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  return mapBounty(row);
}

export async function getBounty(id) {
  const [row] = await db.sql`
    SELECT b.*, COUNT(s.id)::int AS submission_count
    FROM bounties b
    LEFT JOIN submissions s ON s.bounty_id = b.id AND s.state = 'CONFIRMED'
    WHERE b.id = ${id}
    GROUP BY b.id
  `;
  return mapBounty(row);
}

export async function createBounty(input) {
  const id = randomUUID();
  const metadataHash = createMetadataHash(input);
  const requirements = JSON.stringify(input.requirements ?? []);
  const [row] = await db.sql`
      INSERT INTO bounties (id, requester, title, description, requirements, reward, deadline, metadata_hash, contract_address)
      VALUES (${id}, ${input.requester}, ${input.title}, ${input.description}, ${requirements}::jsonb, ${input.reward}, ${input.deadline}, ${metadataHash}, ${input.contractAddress || '0x8D9fF4279692381F7ae0F74B3D8AAe94336426de'})
    RETURNING *
  `;
  return mapBounty(row);
}

export async function markBountyOnchain(bounty, confirmation) {
  if (bounty.createTxHash) {
    if (bounty.createTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different creation transaction.');
  }
  const [row] = await db.sql`
    UPDATE bounties
    SET state = 'OPEN', chain_bounty_id = ${confirmation.chainBountyId}, create_tx_hash = ${confirmation.txHash}, requester = ${confirmation.requester}, updated_at = NOW()
    WHERE id = ${bounty.id} AND state = 'DRAFT' AND create_tx_hash IS NULL
    RETURNING *
  `;
  if (!row) throw new Error('This bounty can no longer be linked.');
  return mapBounty(row);
}

export async function createSubmission(bounty, input) {
  if (!['OPEN', 'SUBMISSIONS_RECEIVED'].includes(bounty.state)) throw new Error('This bounty is not accepting submissions.');
  const id = randomUUID();
  const evidencePayload = { resultUri: input.resultUri ?? null, evidence: input.evidence ?? [] };
  const evidenceHash = hash(JSON.stringify(evidencePayload));
  const evidence = JSON.stringify(input.evidence ?? []);
  try {
    const [row] = await db.sql`
      INSERT INTO submissions (id, bounty_id, agent, result_uri, evidence, evidence_hash)
      VALUES (${id}, ${bounty.id}, ${input.agent}, ${input.resultUri}, ${evidence}::jsonb, ${evidenceHash})
      RETURNING *
    `;
    return mapSubmission(row);
  } catch (error) {
    if (String(error.message).includes('unique')) throw new Error('This wallet already prepared a submission for this bounty.');
    throw error;
  }
}

export async function getSubmission(id) {
  const [row] = await db.sql`SELECT * FROM submissions WHERE id = ${id}`;
  return mapSubmission(row);
}

export async function listSubmissions(bountyId) {
  const rows = await db.sql`
    SELECT * FROM submissions
    WHERE bounty_id = ${bountyId} AND state = 'CONFIRMED'
    ORDER BY created_at DESC
  `;
  return rows.map(mapSubmission);
}

export async function markSubmissionOnchain(submission, confirmation) {
  if (submission.txHash) {
    if (submission.txHash === confirmation.txHash) return submission;
    throw new Error('This submission already has a different confirmation transaction.');
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE submissions SET state = 'CONFIRMED', agent = $1, tx_hash = $2, updated_at = NOW()
       WHERE id = $3 AND state = 'DRAFT' AND tx_hash IS NULL RETURNING *`,
      [confirmation.agent, confirmation.txHash, submission.id],
    );
    if (!result.rows[0]) throw new Error('This submission can no longer be linked.');
    await client.query(
      `UPDATE bounties SET state = 'SUBMISSIONS_RECEIVED', updated_at = NOW()
       WHERE id = $1 AND state IN ('OPEN', 'SUBMISSIONS_RECEIVED')`,
      [submission.bountyId],
    );
    await client.query('COMMIT');
    return mapSubmission(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markAwarded(bounty, confirmation) {
  if (bounty.settlementTxHash) {
    if (bounty.settlementTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different payout transaction.');
  }
  const [row] = await db.sql`
    UPDATE bounties
    SET state = 'AWARDED', winner = ${confirmation.winner}, settlement_tx_hash = ${confirmation.txHash}, updated_at = NOW()
    WHERE id = ${bounty.id} AND state = 'SUBMISSIONS_RECEIVED' AND settlement_tx_hash IS NULL
    RETURNING *
  `;
  if (!row) throw new Error('This bounty is not ready for payout.');
  return mapBounty(row);
}

export async function markSubmissionRejected(bounty, confirmation) {
  const [row] = await db.sql`
    UPDATE submissions
    SET state = 'REJECTED', tx_hash = COALESCE(${confirmation.txHash}, tx_hash), updated_at = NOW()
    WHERE bounty_id = ${bounty.id} AND agent = ${confirmation.agent} AND state = 'CONFIRMED'
    RETURNING *
  `;
  if (!row) throw new Error('This submission is no longer available for rejection.');
  return mapSubmission(row);
}

export async function markCancelled(bounty, confirmation) {
  if (bounty.cancelTxHash) {
    if (bounty.cancelTxHash === confirmation.txHash) return bounty;
    throw new Error('This bounty already has a different refund transaction.');
  }
  const [row] = await db.sql`
    UPDATE bounties
    SET state = 'CANCELLED', cancel_tx_hash = ${confirmation.txHash}, updated_at = NOW()
    WHERE id = ${bounty.id} AND state IN ('OPEN', 'SUBMISSIONS_RECEIVED') AND cancel_tx_hash IS NULL
    RETURNING *
  `;
  if (!row) throw new Error('This bounty is not eligible for a refund.');
  return mapBounty(row);
}

export async function getCounts() {
  const [row] = await db.sql`
    SELECT (SELECT COUNT(*)::int FROM bounties) AS bounties,
           (SELECT COUNT(*)::int FROM submissions) AS submissions
  `;
  return { persistence: 'netlify-postgres', bounties: Number(row.bounties), submissions: Number(row.submissions) };
}
