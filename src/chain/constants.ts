import type { ChainPreset } from './types.js';

/** Base Sepolia testnet preset (v3 contract with storageRef support) */
export const BASE_SEPOLIA: ChainPreset = {
  chainId: 84532,
  name: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  contractAddress: '0x3945aDfd5Df9ab2F5cB4Ca0eb3D4384CC3650322',
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

/** Local Hardhat preset for development (address from ConsentsBasedDataProvenance deploy script) */
export const HARDHAT_LOCAL: ChainPreset = {
  chainId: 31337,
  name: 'hardhat',
  rpcUrl: 'http://127.0.0.1:8545',
  contractAddress: '0xD42912755319665397FF090fBB63B1a31aE87Cee',
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
