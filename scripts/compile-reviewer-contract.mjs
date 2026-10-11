import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import solc from 'solc';

const sourcePath = path.resolve('contracts/ReviewerEscrow.sol');
const source = await readFile(sourcePath, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ReviewerEscrow.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));

const artifact = output.contracts['ReviewerEscrow.sol'].ReviewerEscrow;
await mkdir(path.resolve('artifacts'), { recursive: true });
await writeFile(path.resolve('artifacts/ReviewerEscrow.json'), JSON.stringify({
  contractName: 'ReviewerEscrow',
  compiler: solc.version(),
  abi: artifact.abi,
  bytecode: `0x${artifact.evm.bytecode.object}`,
}, null, 2));
console.log(`Compiled ReviewerEscrow with ${solc.version()} (${artifact.evm.bytecode.object.length / 2} byte runtime+init bytecode)`);
