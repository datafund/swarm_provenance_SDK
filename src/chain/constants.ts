import type { ChainPreset } from './types.js';

/** Base Sepolia testnet preset */
export const BASE_SEPOLIA: ChainPreset = {
  chainId: 84532,
  name: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  contractAddress: '0x9a3c6F47B69211F05891CCb7aD33596290b9fE64',
  explorerUrl: 'https://sepolia.basescan.org',
};

/** Base mainnet preset (contract not yet deployed) */
export const BASE_MAINNET: ChainPreset = {
  chainId: 8453,
  name: 'base',
  rpcUrl: 'https://mainnet.base.org',
  contractAddress: '0x0000000000000000000000000000000000000000',
  explorerUrl: 'https://basescan.org',
};

/** Local Hardhat preset for development */
export const HARDHAT_LOCAL: ChainPreset = {
  chainId: 31337,
  name: 'hardhat',
  rpcUrl: 'http://127.0.0.1:8545',
  contractAddress: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
  explorerUrl: 'http://localhost',
};

/** All available chain presets indexed by name */
export const CHAIN_PRESETS: Record<string, ChainPreset> = {
  'base-sepolia': BASE_SEPOLIA,
  'base': BASE_MAINNET,
  'hardhat': HARDHAT_LOCAL,
};

/** Zero bytes32 value (used to detect unregistered records) */
export const ZERO_BYTES32: `0x${string}` = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Zero address */
export const ZERO_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000';
