import { describe, it, expect } from 'vitest';
import { BASE_SEPOLIA, BASE_MAINNET, CHAIN_PRESETS, ZERO_BYTES32, ZERO_ADDRESS } from '../../../src/chain/constants.js';

describe('chain constants', () => {
  it('BASE_SEPOLIA has correct chainId', () => {
    expect(BASE_SEPOLIA.chainId).toBe(84532);
  });

  it('BASE_SEPOLIA has contract address', () => {
    expect(BASE_SEPOLIA.contractAddress).toBe('0xD4a724CD7f5C4458cD2d884C2af6f011aC3Af80a');
  });

  it('BASE_MAINNET has correct chainId', () => {
    expect(BASE_MAINNET.chainId).toBe(8453);
  });

  it('CHAIN_PRESETS contains both chains', () => {
    expect(CHAIN_PRESETS['base-sepolia']).toBe(BASE_SEPOLIA);
    expect(CHAIN_PRESETS['base']).toBe(BASE_MAINNET);
  });

  it('ZERO_BYTES32 is 66 chars (0x + 64)', () => {
    expect(ZERO_BYTES32).toHaveLength(66);
    expect(ZERO_BYTES32).toMatch(/^0x0+$/);
  });

  it('ZERO_ADDRESS is 42 chars (0x + 40)', () => {
    expect(ZERO_ADDRESS).toHaveLength(42);
    expect(ZERO_ADDRESS).toMatch(/^0x0+$/);
  });
});
