import { createPublicClient, http, encodeFunctionData } from 'viem';

// src/chain/client.ts

// src/chain/abi.ts
var DATA_PROVENANCE_ABI = [
  {
    inputs: [],
    stateMutability: "nonpayable",
    type: "constructor"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "dataHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "accessor", type: "address" }
    ],
    name: "DataAccessed",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "dataHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" }
    ],
    name: "DataOwnershipTransferred",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "dataHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: false, internalType: "string", name: "dataType", type: "string" }
    ],
    name: "DataRegistered",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "dataHash", type: "bytes32" },
      { indexed: false, internalType: "enum DataProvenance.DataStatus", name: "oldStatus", type: "uint8" },
      { indexed: false, internalType: "enum DataProvenance.DataStatus", name: "newStatus", type: "uint8" }
    ],
    name: "DataStatusChanged",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "originalDataHash", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "newDataHash", type: "bytes32" },
      { indexed: false, internalType: "string", name: "transformation", type: "string" }
    ],
    name: "DataTransformed",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "delegate", type: "address" },
      { indexed: false, internalType: "bool", name: "authorized", type: "bool" }
    ],
    name: "DelegateAuthorized",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "role", type: "bytes32" },
      { indexed: true, internalType: "address", name: "account", type: "address" },
      { indexed: true, internalType: "address", name: "sender", type: "address" }
    ],
    name: "RoleGranted",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "role", type: "bytes32" },
      { indexed: true, internalType: "address", name: "account", type: "address" },
      { indexed: true, internalType: "address", name: "sender", type: "address" }
    ],
    name: "RoleRevoked",
    type: "event"
  },
  // View functions
  {
    inputs: [],
    name: "ADMIN_ROLE",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "AUDITOR_ROLE",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "MAX_ACCESSORS",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "MAX_TRANSFORMATIONS",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "OPERATOR_ROLE",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" }
    ],
    name: "authorizedDelegates",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  // Write functions
  {
    inputs: [{ internalType: "bytes32[]", name: "_dataHashes", type: "bytes32[]" }],
    name: "batchRecordAccess",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32[]", name: "_dataHashes", type: "bytes32[]" },
      { internalType: "string[]", name: "_dataTypes", type: "string[]" }
    ],
    name: "batchRegisterData",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32[]", name: "_dataHashes", type: "bytes32[]" },
      { internalType: "enum DataProvenance.DataStatus[]", name: "_statuses", type: "uint8[]" }
    ],
    name: "batchSetDataStatus",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "contractAdmin",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    name: "dataRecords",
    outputs: [
      { internalType: "bytes32", name: "dataHash", type: "bytes32" },
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "timestamp", type: "uint256" },
      { internalType: "string", name: "dataType", type: "string" },
      { internalType: "enum DataProvenance.DataStatus", name: "status", type: "uint8" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes32", name: "_dataHash", type: "bytes32" }],
    name: "getDataRecord",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "dataHash", type: "bytes32" },
          { internalType: "address", name: "owner", type: "address" },
          { internalType: "uint256", name: "timestamp", type: "uint256" },
          { internalType: "string", name: "dataType", type: "string" },
          { internalType: "string[]", name: "transformations", type: "string[]" },
          { internalType: "address[]", name: "accessors", type: "address[]" },
          { internalType: "enum DataProvenance.DataStatus", name: "status", type: "uint8" }
        ],
        internalType: "struct DataProvenance.DataRecord",
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" }
    ],
    name: "getRoleMember",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes32", name: "role", type: "bytes32" }],
    name: "getRoleMemberCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_user", type: "address" }],
    name: "getUserDataRecords",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_user", type: "address" }],
    name: "getUserDataRecordsCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_user", type: "address" },
      { internalType: "uint256", name: "_offset", type: "uint256" },
      { internalType: "uint256", name: "_limit", type: "uint256" }
    ],
    name: "getUserDataRecordsPaginated",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "address", name: "account", type: "address" }
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "address", name: "_accessor", type: "address" }
    ],
    name: "hasAddressAccessed",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "address", name: "account", type: "address" }
    ],
    name: "hasRole",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_owner", type: "address" },
      { internalType: "address", name: "_delegate", type: "address" }
    ],
    name: "isAuthorizedDelegate",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "enum DataProvenance.DataStatus", name: "_newStatus", type: "uint8" }
    ],
    name: "operatorSetDataStatus",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes32", name: "_dataHash", type: "bytes32" }],
    name: "recordAccess",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_originalDataHash", type: "bytes32" },
      { internalType: "bytes32", name: "_newDataHash", type: "bytes32" },
      { internalType: "string", name: "_transformation", type: "string" }
    ],
    name: "recordTransformation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "string", name: "_dataType", type: "string" }
    ],
    name: "registerData",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "string", name: "_dataType", type: "string" },
      { internalType: "address", name: "_actualOwner", type: "address" }
    ],
    name: "registerDataFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes32", name: "role", type: "bytes32" }],
    name: "renounceRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "address", name: "account", type: "address" }
    ],
    name: "revokeRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "enum DataProvenance.DataStatus", name: "_newStatus", type: "uint8" }
    ],
    name: "setDataStatus",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_delegate", type: "address" },
      { internalType: "bool", name: "_authorized", type: "bool" }
    ],
    name: "setDelegate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_dataHash", type: "bytes32" },
      { internalType: "address", name: "_newOwner", type: "address" }
    ],
    name: "transferDataOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "uint256", name: "", type: "uint256" }
    ],
    name: "userDataRecords",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  }
];

// src/chain/constants.ts
var BASE_SEPOLIA = {
  chainId: 84532,
  name: "base-sepolia",
  rpcUrl: "https://sepolia.base.org",
  contractAddress: "0x9a3c6F47B69211F05891CCb7aD33596290b9fE64",
  explorerUrl: "https://sepolia.basescan.org"
};
var BASE_MAINNET = {
  chainId: 8453,
  name: "base",
  rpcUrl: "https://mainnet.base.org",
  contractAddress: "0x0000000000000000000000000000000000000000",
  explorerUrl: "https://basescan.org"
};
var CHAIN_PRESETS = {
  "base-sepolia": BASE_SEPOLIA,
  "base": BASE_MAINNET
};
var ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// src/errors.ts
var ProvenanceError = class _ProvenanceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "ProvenanceError";
    Object.setPrototypeOf(this, _ProvenanceError.prototype);
  }
};

// src/chain/errors.ts
var ChainError = class _ChainError extends ProvenanceError {
  constructor(message, code) {
    super(message, code);
    this.name = "ChainError";
    Object.setPrototypeOf(this, _ChainError.prototype);
  }
};
var ChainConfigurationError = class _ChainConfigurationError extends ChainError {
  constructor(message) {
    super(message, "CHAIN_CONFIGURATION");
    this.name = "ChainConfigurationError";
    Object.setPrototypeOf(this, _ChainConfigurationError.prototype);
  }
};
var ChainConnectionError = class _ChainConnectionError extends ChainError {
  constructor(message) {
    super(message, "CHAIN_CONNECTION");
    this.name = "ChainConnectionError";
    Object.setPrototypeOf(this, _ChainConnectionError.prototype);
  }
};
var ChainTransactionError = class _ChainTransactionError extends ChainError {
  constructor(message, txHash) {
    super(message, "CHAIN_TRANSACTION");
    this.txHash = txHash;
    this.name = "ChainTransactionError";
    Object.setPrototypeOf(this, _ChainTransactionError.prototype);
  }
};
var ChainValidationError = class _ChainValidationError extends ChainError {
  constructor(message) {
    super(message, "CHAIN_VALIDATION");
    this.name = "ChainValidationError";
    Object.setPrototypeOf(this, _ChainValidationError.prototype);
  }
};
var DataNotRegisteredError = class _DataNotRegisteredError extends ChainError {
  constructor(dataHash) {
    super(`Data hash ${dataHash} is not registered on-chain`, "DATA_NOT_REGISTERED");
    this.name = "DataNotRegisteredError";
    Object.setPrototypeOf(this, _DataNotRegisteredError.prototype);
  }
};
var SignerRequiredError = class _SignerRequiredError extends ChainError {
  constructor() {
    super("A signer is required for write operations", "SIGNER_REQUIRED");
    this.name = "SignerRequiredError";
    Object.setPrototypeOf(this, _SignerRequiredError.prototype);
  }
};

// src/chain/validation.ts
var BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;
var HASH_NO_PREFIX_REGEX = /^[0-9a-fA-F]{64}$/;
function normalizeHash(hash) {
  if (BYTES32_REGEX.test(hash)) {
    return hash;
  }
  if (HASH_NO_PREFIX_REGEX.test(hash)) {
    return `0x${hash}`;
  }
  throw new ChainValidationError(
    `Invalid data hash: expected 64 hex characters (with or without 0x prefix), got "${hash}"`
  );
}
function validateDataType(dataType) {
  if (!dataType || dataType.trim().length === 0) {
    throw new ChainValidationError("Data type must not be empty");
  }
}
function encodeRegisterData(dataHash, dataType) {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: "registerData",
    args: [dataHash, dataType]
  });
}
function encodeRecordAccess(dataHash) {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: "recordAccess",
    args: [dataHash]
  });
}

// src/chain/client.ts
var ChainClient = class {
  publicClient;
  contractAddress;
  preset;
  signer;
  constructor(config) {
    if (typeof config.chain === "string") {
      const preset = CHAIN_PRESETS[config.chain];
      if (!preset) {
        throw new ChainConfigurationError(
          `Unknown chain preset: "${config.chain}". Available: ${Object.keys(CHAIN_PRESETS).join(", ")}`
        );
      }
      this.preset = preset;
    } else {
      this.preset = config.chain;
    }
    const rpcUrl = config.rpcUrl ?? this.preset.rpcUrl;
    this.contractAddress = config.contractAddress ?? this.preset.contractAddress;
    this.signer = config.signer;
    if (this.contractAddress === ZERO_ADDRESS) {
      throw new ChainConfigurationError(
        `Contract not yet deployed on ${this.preset.name}. Use a chain with a deployed contract.`
      );
    }
    this.publicClient = createPublicClient({
      transport: http(rpcUrl)
    });
  }
  // ─── Read Operations ─────────────────────────────────────────
  /**
   * Check if a data hash is registered on-chain.
   */
  async verifyOnChain(dataHash) {
    const hash = normalizeHash(dataHash);
    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: "dataRecords",
        args: [hash]
      });
      const [storedHash] = result;
      return storedHash !== ZERO_BYTES32;
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to verify on-chain: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Get the full on-chain provenance record for a data hash.
   * Throws DataNotRegisteredError if the hash is not registered.
   */
  async getDataRecord(dataHash) {
    const hash = normalizeHash(dataHash);
    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: "getDataRecord",
        args: [hash]
      });
      const record = result;
      if (record.dataHash === ZERO_BYTES32) {
        throw new DataNotRegisteredError(dataHash);
      }
      return {
        dataHash: record.dataHash,
        owner: record.owner,
        timestamp: Number(record.timestamp),
        dataType: record.dataType,
        status: record.status,
        accessors: [...record.accessors],
        transformations: [...record.transformations]
      };
    } catch (error) {
      if (error instanceof DataNotRegisteredError) {
        throw error;
      }
      throw new ChainConnectionError(
        `Failed to get data record: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // ─── Write Operations ────────────────────────────────────────
  /**
   * Anchor a data hash on-chain by registering it in the DataProvenance contract.
   * Requires a signer.
   */
  async anchor(dataHash, dataType) {
    this.requireSigner();
    validateDataType(dataType);
    const hash = normalizeHash(dataHash);
    const data = encodeRegisterData(hash, dataType);
    const owner = await this.signer.getAddress();
    const receipt = await this.sendAndWait(data);
    return {
      ...receipt,
      dataHash: hash,
      dataType,
      owner
    };
  }
  /**
   * Record an access event for a data hash on-chain.
   * Requires a signer.
   */
  async recordAccess(dataHash) {
    this.requireSigner();
    const hash = normalizeHash(dataHash);
    const data = encodeRecordAccess(hash);
    const accessor = await this.signer.getAddress();
    const receipt = await this.sendAndWait(data);
    return {
      ...receipt,
      dataHash: hash,
      accessor
    };
  }
  // ─── Helpers ─────────────────────────────────────────────────
  /**
   * Get the explorer URL for a transaction hash.
   */
  getExplorerUrl(txHash) {
    return `${this.preset.explorerUrl}/tx/${txHash}`;
  }
  requireSigner() {
    if (!this.signer) {
      throw new SignerRequiredError();
    }
  }
  async sendAndWait(data) {
    let txHash;
    try {
      txHash = await this.signer.sendTransaction({
        to: this.contractAddress,
        data
      });
    } catch (error) {
      throw new ChainTransactionError(
        `Transaction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash
      });
      if (receipt.status === "reverted") {
        throw new ChainTransactionError("Transaction reverted", txHash);
      }
      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed,
        explorerUrl: this.getExplorerUrl(txHash)
      };
    } catch (error) {
      if (error instanceof ChainTransactionError) {
        throw error;
      }
      throw new ChainConnectionError(
        `Failed waiting for receipt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};

// src/chain/signer.ts
function fromViemWalletClient(walletClient) {
  if (!walletClient.account) {
    throw new ChainConfigurationError(
      "WalletClient must have an account attached. Use createWalletClient with an account."
    );
  }
  const account = walletClient.account;
  return {
    getAddress() {
      return Promise.resolve(account.address);
    },
    sendTransaction(tx) {
      return walletClient.sendTransaction(tx);
    }
  };
}
async function fromPrivateKey(privateKey, rpcUrl) {
  let viem;
  let viemAccounts;
  try {
    viem = await import('viem');
    viemAccounts = await import('viem/accounts');
  } catch {
    throw new ChainConfigurationError(
      "viem is required for private key signing. Install it: pnpm add viem"
    );
  }
  const account = viemAccounts.privateKeyToAccount(privateKey);
  const client = viem.createWalletClient({
    account,
    transport: viem.http(rpcUrl)
  });
  return {
    getAddress() {
      return Promise.resolve(account.address);
    },
    sendTransaction(tx) {
      return client.sendTransaction({
        to: tx.to,
        data: tx.data,
        chain: null
        // let the RPC determine the chain
      });
    }
  };
}
async function fromEip1193Provider(provider) {
  const accounts = await provider.request({
    method: "eth_requestAccounts"
  });
  if (!accounts || accounts.length === 0) {
    throw new ChainConfigurationError("No accounts available from provider");
  }
  const address = accounts[0];
  return {
    getAddress() {
      return Promise.resolve(address);
    },
    async sendTransaction(tx) {
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: tx.to,
            data: tx.data
          }
        ]
      });
      return txHash;
    }
  };
}

// src/chain/types.ts
var DataStatus = /* @__PURE__ */ ((DataStatus2) => {
  DataStatus2[DataStatus2["ACTIVE"] = 0] = "ACTIVE";
  DataStatus2[DataStatus2["RESTRICTED"] = 1] = "RESTRICTED";
  DataStatus2[DataStatus2["DELETED"] = 2] = "DELETED";
  return DataStatus2;
})(DataStatus || {});

export { BASE_MAINNET, BASE_SEPOLIA, CHAIN_PRESETS, ChainClient, ChainConfigurationError, ChainConnectionError, ChainError, ChainTransactionError, ChainValidationError, DataNotRegisteredError, DataStatus, SignerRequiredError, fromEip1193Provider, fromPrivateKey, fromViemWalletClient, normalizeHash };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map