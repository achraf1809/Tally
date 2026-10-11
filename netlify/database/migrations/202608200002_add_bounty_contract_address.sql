ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS contract_address TEXT NOT NULL DEFAULT '0x349Ab37142bA7E2b4D28e86D0624f0d2268A4801';

CREATE INDEX IF NOT EXISTS bounties_contract_address_idx ON bounties (contract_address);
