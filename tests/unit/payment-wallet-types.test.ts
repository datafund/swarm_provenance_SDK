import { describe, it, expect } from 'vitest';
import { createWalletClient, custom, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';

// The README's x402 setups must typecheck as written (`pnpm typecheck` covers tests/).
// Nothing here makes a request: constructing the client does not touch the network.
describe('PaymentWallet accepts a viem WalletClient extended with publicActions', () => {
  it('server setup: local account', () => {
    const wallet = createWalletClient({
      account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
      chain: baseSepolia,
      transport: http(),
    }).extend(publicActions);

    expect(new ProvenanceClient({ payment: { wallet } })).toBeInstanceOf(ProvenanceClient);
  });

  it('browser setup: injected provider and a JSON-RPC account', () => {
    const provider = { request: () => Promise.resolve(null) };
    const wallet = createWalletClient({
      account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      chain: baseSepolia,
      transport: custom(provider),
    }).extend(publicActions);

    expect(new ProvenanceClient({ payment: { wallet } })).toBeInstanceOf(ProvenanceClient);
  });
});
