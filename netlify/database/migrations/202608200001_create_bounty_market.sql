CREATE TABLE IF NOT EXISTS bounties (
  id UUID PRIMARY KEY,
  requester TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  reward TEXT NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  metadata_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  chain_bounty_id BIGINT UNIQUE,
  create_tx_hash TEXT UNIQUE,
  winner TEXT,
  settlement_tx_hash TEXT UNIQUE,
  cancel_tx_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY,
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  result_uri TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  tx_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bounty_id, agent)
);

CREATE INDEX IF NOT EXISTS bounties_state_created_idx ON bounties (state, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_bounty_created_idx ON submissions (bounty_id, created_at DESC);
