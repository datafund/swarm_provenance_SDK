import type { Address, Hex, ChainSigner } from './types.js';
import { ChainConfigurationError } from './errors.js';

/**
 * EIP-1193 provider interface (window.ethereum / MetaMask)
 */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Create a ChainSigner from a viem WalletClient.
 *
 * @example
 * ```ts
 * import { createWalletClient, http } from 'viem';
 * import { baseSepolia } from 'viem/chains';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const walletClient = createWalletClient({
 *   account: privateKeyToAccount('0x...'),
 *   chain: baseSepolia,
 *   transport: http(),
 * });
 * const signer = fromViemWalletClient(walletClient);
 * ```
 */
export function fromViemWalletClient(walletClient: {
  account?: { address: Address } | null;
  sendTransaction(args: {
    to: Address;
    data: Hex;
    gas?: bigint;
  }): Promise<Hex>;
}): ChainSigner {
  if (!walletClient.account) {
    throw new ChainConfigurationError(
      'WalletClient must have an account attached. Use createWalletClient with an account.'
    );
  }

  const account = walletClient.account;

  return {
    getAddress(): Promise<Address> {
      return Promise.resolve(account.address);
    },
    sendTransaction(tx: { to: Address; data: Hex; gas?: bigint }): Promise<Hex> {
      return walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        ...(tx.gas ? { gas: tx.gas } : {}),
      });
    },
  };
}

/**
 * Create a ChainSigner from a private key (Node.js / server-side).
 * Dynamically imports viem to create a wallet client.
 *
 * @example
 * ```ts
 * const signer = await fromPrivateKey('0xabc...', 'https://sepolia.base.org');
 * ```
 */
export async function fromPrivateKey(privateKey: Hex, rpcUrl: string): Promise<ChainSigner> {
  let viem: typeof import('viem');
  let viemAccounts: typeof import('viem/accounts');

  try {
    viem = await import('viem');
    viemAccounts = await import('viem/accounts');
  } catch {
    throw new ChainConfigurationError(
      'viem is required for private key signing. Install it: pnpm add viem'
    );
  }

  const account = viemAccounts.privateKeyToAccount(privateKey);
  const client = viem.createWalletClient({
    account,
    transport: viem.http(rpcUrl),
  });

  return {
    getAddress(): Promise<Address> {
      return Promise.resolve(account.address);
    },
    sendTransaction(tx: { to: Address; data: Hex; gas?: bigint }): Promise<Hex> {
      return client.sendTransaction({
        to: tx.to,
        data: tx.data,
        chain: null, // let the RPC determine the chain
        ...(tx.gas ? { gas: tx.gas } : {}),
      });
    },
  };
}

/**
 * Create a ChainSigner from an EIP-1193 provider (browser wallet like MetaMask).
 *
 * @example
 * ```ts
 * const signer = await fromEip1193Provider(window.ethereum);
 * ```
 */
export async function fromEip1193Provider(provider: Eip1193Provider): Promise<ChainSigner> {
  // Request account access
  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
  })) as string[];

  if (!accounts || accounts.length === 0) {
    throw new ChainConfigurationError('No accounts available from provider');
  }

  const address = accounts[0] as Address;

  return {
    getAddress(): Promise<Address> {
      return Promise.resolve(address);
    },
    async sendTransaction(tx: { to: Address; data: Hex; gas?: bigint }): Promise<Hex> {
      const txHash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            to: tx.to,
            data: tx.data,
            ...(tx.gas ? { gas: `0x${tx.gas.toString(16)}` } : {}),
          },
        ],
      })) as Hex;
      return txHash;
    },
  };
}
