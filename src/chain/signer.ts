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
  getChainId(): Promise<number>;
  /** viem's WalletClient.switchChain; used to ask the wallet to switch on a mismatch */
  switchChain?(args: { id: number }): Promise<void>;
  /** viem's WalletClient.addChain; used when the wallet does not know the chain (4902) */
  addChain?(args: { chain: BoundChain & { blockExplorers?: { default: { name: string; url: string } } } }): Promise<void>;
  sendTransaction(args: {
    to: Address;
    data: Hex;
    gas?: bigint;
    chain?: BoundChain | null;
  }): Promise<Hex>;
}): ChainSigner {
  if (!walletClient.account) {
    throw new ChainConfigurationError(
      'WalletClient must have an account attached. Use createWalletClient with an account.'
    );
  }

  const account = walletClient.account;

  const signer: ChainSigner = {
    getAddress(): Promise<Address> {
      return Promise.resolve(account.address);
    },
    getChainId(): Promise<number> {
      return walletClient.getChainId();
    },
    sendTransaction(tx: { to: Address; data: Hex; gas?: bigint; chainId?: number }): Promise<Hex> {
      return walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        // viem then refuses to send if the wallet is on another chain
        ...(tx.chainId ? { chain: boundChain(tx.chainId) } : {}),
        ...(tx.gas ? { gas: tx.gas } : {}),
      });
    },
  };
  if (walletClient.switchChain) {
    const switchChain = walletClient.switchChain.bind(walletClient);
    const addChain = walletClient.addChain?.bind(walletClient);
    signer.switchChain = async (chainId, chain) => {
      try {
        await switchChain({ id: chainId });
      } catch (error) {
        // 4902: the wallet does not know the chain; add it (built-in presets only pass details)
        if (!isUnknownChain(error) || !chain || !addChain) throw error;
        await addChain({
          chain: {
            ...boundChain(chainId),
            name: chain.name,
            rpcUrls: { default: { http: chain.rpcUrls } },
            ...(chain.explorerUrl.startsWith('https://')
              ? { blockExplorers: { default: { name: 'Explorer', url: chain.explorerUrl } } }
              : {}),
          },
        });
        await switchChain({ id: chainId });
      }
    };
  }
  return signer;
}

/**
 * Create a ChainSigner from a private key (Node.js / server-side).
 * Dynamically imports viem to create a wallet client.
 *
 * @example
 * ```ts
 * const signer = await fromPrivateKey('0xabc...', 'https://base-sepolia-rpc.publicnode.com');
 * ```
 */
export async function fromPrivateKey(privateKey: Hex, rpcUrl: string): Promise<ChainSigner> {
  let viem: typeof import('viem');
  let viemAccounts: typeof import('viem/accounts');

  try {
    viem = await import('viem');
    viemAccounts = await import('viem/accounts');
  } catch (error) {
    // Once the chain entry has loaded, viem resolves, so this mostly catches a
    // broken install: keep the original error for diagnosis.
    const configError = new ChainConfigurationError(
      'viem is required for private key signing. Install it: npm install viem (or pnpm add viem)'
    );
    configError.cause = error;
    throw configError;
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
    // The RPC decides the chain for a raw key; ChainClient checks it before writing
    getChainId(): Promise<number> {
      return client.getChainId();
    },
    sendTransaction(tx: { to: Address; data: Hex; gas?: bigint; chainId?: number }): Promise<Hex> {
      return client.sendTransaction({
        to: tx.to,
        data: tx.data,
        // Signed for this chain ID (EIP-155): it cannot execute anywhere else
        chain: tx.chainId ? boundChain(tx.chainId) : null,
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
    async getChainId(): Promise<number> {
      return Number(await provider.request({ method: 'eth_chainId' }));
    },
    async switchChain(chainId: number, chain?: { name: string; rpcUrls: string[]; explorerUrl: string }): Promise<void> {
      const hexChainId = `0x${chainId.toString(16)}`;
      try {
        // The wallet asks the user; a refusal throws
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
      } catch (error) {
        // 4902: the wallet does not know the chain (some wallets nest the code)
        if (!isUnknownChain(error) || !chain) throw error;
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexChainId,
              chainName: chain.name,
              rpcUrls: chain.rpcUrls,
              // Wallets accept only https explorer URLs (e.g. not http://localhost)
              ...(chain.explorerUrl.startsWith('https://') ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            },
          ],
        });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
      }
    },
    async sendTransaction(tx: { to: Address; data: Hex; gas?: bigint; chainId?: number }): Promise<Hex> {
      const txHash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            to: tx.to,
            data: tx.data,
            ...(tx.chainId ? { chainId: `0x${tx.chainId.toString(16)}` } : {}),
            ...(tx.gas ? { gas: `0x${tx.gas.toString(16)}` } : {}),
          },
        ],
      })) as Hex;
      return txHash;
    },
  };
}

/** The minimal viem Chain needed to bind a transaction to a chain ID */
type BoundChain = {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: readonly string[] } };
};

function boundChain(id: number): BoundChain {
  return {
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  };
}

/** EIP-1193 4902 "unrecognized chain", at the top level or nested (as some wallets and viem wrap it) */
function isUnknownChain(error: unknown): boolean {
  const e = error as { code?: number; cause?: { code?: number }; data?: { originalError?: { code?: number } } } | null;
  return e?.code === 4902 || e?.cause?.code === 4902 || e?.data?.originalError?.code === 4902;
}
