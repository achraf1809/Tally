import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import solc from 'solc';

const sourcePath = path.resolve('contracts/BountyEscrow.sol');
const source = await readFile(sourcePath, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'BountyEscrow.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));

const artifact = output.contracts['BountyEscrow.sol'].BountyEscrow;
await mkdir(path.resolve('artifacts'), { recursive: true });
await writeFile(path.resolve('artifacts/BountyEscrow.json'), JSON.stringify({
  contractName: 'BountyEscrow',
  compiler: solc.version(),
  abi: artifact.abi,
  bytecode: `0x${artifact.evm.bytecode.object}`,
}, null, 2));
console.log(`Compiled BountyEscrow with ${solc.version()}`);
