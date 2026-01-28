import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// src/errors.ts
var ProvenanceError = class _ProvenanceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "ProvenanceError";
    Object.setPrototypeOf(this, _ProvenanceError.prototype);
  }
};
var GatewayConnectionError = class _GatewayConnectionError extends ProvenanceError {
  constructor(message, statusCode, code) {
    super(message, code);
    this.statusCode = statusCode;
    this.name = "GatewayConnectionError";
    Object.setPrototypeOf(this, _GatewayConnectionError.prototype);
  }
};
var StampError = class _StampError extends ProvenanceError {
  constructor(message, code) {
    super(message, code);
    this.name = "StampError";
    Object.setPrototypeOf(this, _StampError.prototype);
  }
};
var NotaryError = class _NotaryError extends ProvenanceError {
  constructor(message, code) {
    super(message, code);
    this.name = "NotaryError";
    Object.setPrototypeOf(this, _NotaryError.prototype);
  }
};
var VerificationError = class _VerificationError extends ProvenanceError {
  constructor(message, code) {
    super(message, code);
    this.name = "VerificationError";
    Object.setPrototypeOf(this, _VerificationError.prototype);
  }
};
function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new TextEncoder().encode(input);
}
function sha256Hex(data) {
  const bytes = toBytes(data);
  const hash = sha256(bytes);
  return bytesToHex(hash);
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
function base64ToBytes(base64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function isValidHex(str) {
  return /^[0-9a-fA-F]+$/.test(str);
}
function isValidSwarmReference(ref) {
  return ref.length === 64 && isValidHex(ref);
}

// src/metadata.ts
function buildMetadata(content, options) {
  const bytes = toBytes(content);
  const contentHash = sha256Hex(bytes);
  const base64Data = bytesToBase64(bytes);
  const metadata = {
    data: base64Data,
    content_hash: contentHash,
    stamp_id: options.stampId
  };
  if (options.standard) {
    metadata.provenance_standard = options.standard;
  }
  if (options.encryption) {
    metadata.encryption = options.encryption;
  }
  return metadata;
}
function extractContent(metadata) {
  return base64ToBytes(metadata.data);
}
function verifyContentHash(metadata) {
  const content = extractContent(metadata);
  const computedHash = sha256Hex(content);
  return computedHash === metadata.content_hash;
}
function serializeMetadata(metadata) {
  return JSON.stringify(metadata);
}
function parseMetadata(json) {
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid metadata: expected object");
  }
  const obj = parsed;
  if (typeof obj["data"] !== "string") {
    throw new Error("Invalid metadata: missing or invalid data field");
  }
  if (typeof obj["content_hash"] !== "string") {
    throw new Error("Invalid metadata: missing or invalid content_hash field");
  }
  if (typeof obj["stamp_id"] !== "string") {
    throw new Error("Invalid metadata: missing or invalid stamp_id field");
  }
  const result = {
    data: obj["data"],
    content_hash: obj["content_hash"],
    stamp_id: obj["stamp_id"]
  };
  if (typeof obj["provenance_standard"] === "string") {
    result.provenance_standard = obj["provenance_standard"];
  }
  if (typeof obj["encryption"] === "string") {
    result.encryption = obj["encryption"];
  }
  return result;
}

// src/notary.ts
function toCanonicalJson(value) {
  if (value === null || value === void 0) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(toCanonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ":" + toCanonicalJson(value[k])
  );
  return "{" + pairs.join(",") + "}";
}
function verifyDataHash(signature, metadata) {
  const hashedFields = signature.hashed_fields;
  let valueToHash;
  if (hashedFields.length === 1 && hashedFields[0] === "data") {
    valueToHash = metadata.data;
  } else {
    const obj = {};
    for (const field of hashedFields) {
      if (field === "content_hash") {
        obj[field] = metadata.content_hash;
      } else if (field === "data") {
        obj[field] = metadata.data;
      } else if (field === "stamp_id") {
        obj[field] = metadata.stamp_id;
      } else if (field === "provenance_standard") {
        obj[field] = metadata.provenance_standard ?? "";
      }
    }
    valueToHash = obj;
  }
  const canonicalJson = toCanonicalJson(valueToHash);
  const computedHash = sha256Hex(canonicalJson);
  return computedHash === signature.data_hash;
}
function verifySignature(signature, metadata, expectedSigner) {
  const dataHashValid = verifyDataHash(signature, metadata);
  if (!dataHashValid) {
    return {
      valid: false,
      dataHashValid: false,
      error: "Data hash mismatch"
    };
  }
  if (expectedSigner) {
    const signerValid = signature.signer.toLowerCase() === expectedSigner.toLowerCase();
    if (!signerValid) {
      return {
        valid: false,
        dataHashValid: true,
        signerValid: false,
        error: `Signer mismatch: expected ${expectedSigner}, got ${signature.signer}`
      };
    }
    return {
      valid: true,
      dataHashValid: true,
      signerValid: true
    };
  }
  return {
    valid: true,
    dataHashValid: true
  };
}
function verifyAllSignatures(signatures, metadata, expectedSigner) {
  const results = signatures.map((sig, index) => {
    const result = verifySignature(sig, metadata, expectedSigner);
    const item = {
      index,
      valid: result.valid
    };
    if (result.error !== void 0) {
      item.error = result.error;
    }
    return item;
  });
  return {
    allValid: results.every((r) => r.valid),
    results
  };
}

// src/client.ts
var DEFAULT_GATEWAY_URL = "https://provenance-gateway.dev.datafund.io";
var DEFAULT_TIMEOUT = 3e4;
var ProvenanceClient = class {
  gatewayUrl;
  timeout;
  constructor(config = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }
  /**
   * Check if the gateway is healthy and reachable
   */
  async health() {
    try {
      const response = await this.fetch("/health");
      return response.ok;
    } catch {
      return false;
    }
  }
  /**
   * Get notary service information
   */
  async notaryInfo() {
    const response = await this.fetch("/api/v1/notary/info");
    if (!response.ok) {
      if (response.status === 404) {
        return { enabled: false, available: false };
      }
      throw await this.handleError(response);
    }
    const data = await response.json();
    const info = {
      enabled: data.enabled,
      available: data.available
    };
    if (data.address !== void 0) {
      info.address = data.address;
    }
    if (data.message !== void 0) {
      info.message = data.message;
    }
    return info;
  }
  /**
   * Get stamp pool status
   */
  async poolStatus() {
    const response = await this.fetch("/api/v1/pool/status");
    if (!response.ok) {
      if (response.status === 404) {
        return { enabled: false, available: {}, reserve: {} };
      }
      throw await this.handleError(response);
    }
    const data = await response.json();
    return {
      enabled: data.enabled,
      available: data.available,
      reserve: data.reserve
    };
  }
  /**
   * Acquire a stamp from the pool
   */
  async acquireStamp(size = "small") {
    const response = await this.fetch("/api/v1/pool/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size })
    });
    if (!response.ok) {
      const error = await this.handleError(response);
      throw new StampError(error.message, error.code);
    }
    const data = await response.json();
    return {
      batchId: data.batch_id,
      depth: data.depth,
      sizeName: data.size_name,
      fallbackUsed: data.fallback_used
    };
  }
  /**
   * Upload provenance data to Swarm
   */
  async upload(content, options = {}) {
    let stampId = options.stampId;
    if (!stampId) {
      const stamp = await this.acquireStamp(options.poolSize ?? "small");
      stampId = stamp.batchId;
    }
    let bytes;
    if (content instanceof Blob) {
      const buffer = await content.arrayBuffer();
      bytes = new Uint8Array(buffer);
    } else {
      bytes = toBytes(content);
    }
    const metadataOptions = { stampId };
    if (options.standard !== void 0) {
      metadataOptions.standard = options.standard;
    }
    const metadata = buildMetadata(bytes, metadataOptions);
    const params = new URLSearchParams();
    params.set("stamp_id", stampId);
    if (options.contentType) {
      params.set("content_type", options.contentType);
    }
    if (options.sign === "notary") {
      params.set("sign", "notary");
    }
    const formData = new FormData();
    const metadataBlob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
    formData.append("file", metadataBlob, "provenance.json");
    const response = await this.fetch(`/api/v1/data/?${params.toString()}`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const error = await this.handleError(response);
      if (options.sign === "notary") {
        throw new NotaryError(error.message, error.code);
      }
      throw error;
    }
    const data = await response.json();
    const result = {
      reference: data.reference,
      metadata
    };
    if (data.signed_document) {
      result.signedDocument = {
        metadata: data.signed_document.metadata,
        signatures: data.signed_document.signatures
      };
    }
    return result;
  }
  /**
   * Download and optionally verify provenance data from Swarm
   */
  async download(reference, options = {}) {
    const response = await this.fetch(`/api/v1/data/${reference}`);
    if (!response.ok) {
      throw await this.handleError(response);
    }
    let metadata;
    let signatures;
    const data = await response.json();
    if ("metadata" in data && data.metadata && typeof data.metadata === "object") {
      metadata = data.metadata;
      signatures = data.signatures;
    } else {
      const directData = data;
      if (directData.signatures && Array.isArray(directData.signatures)) {
        signatures = directData.signatures;
      }
      metadata = {
        data: directData.data,
        content_hash: directData.content_hash,
        stamp_id: directData.stamp_id
      };
      if (directData.provenance_standard !== void 0) {
        metadata.provenance_standard = directData.provenance_standard;
      }
      if (directData.encryption !== void 0) {
        metadata.encryption = directData.encryption;
      }
    }
    const file = extractContent(metadata);
    const contentHashValid = verifyContentHash(metadata);
    if (!contentHashValid) {
      throw new ProvenanceError("Content hash verification failed", "CONTENT_HASH_MISMATCH");
    }
    const result = {
      file,
      metadata
    };
    if (signatures !== void 0) {
      result.signatures = signatures;
    }
    if (signatures && signatures.length > 0) {
      const shouldVerify = options.verify !== false;
      if (shouldVerify) {
        const notary = await this.notaryInfo();
        const verification = verifyAllSignatures(signatures, metadata, notary.address);
        result.verified = verification.allValid;
      }
    }
    return result;
  }
  /**
   * Make a fetch request to the gateway
   */
  async fetch(path, init) {
    const url = `${this.gatewayUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const headers = new Headers(init?.headers);
    if (!headers.has("X-Payment-Mode")) {
      headers.set("X-Payment-Mode", "free");
    }
    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayConnectionError("Request timed out", void 0, "TIMEOUT");
      }
      throw new GatewayConnectionError(
        error instanceof Error ? error.message : "Failed to connect to gateway",
        void 0,
        "CONNECTION_FAILED"
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
  /**
   * Handle error responses from the gateway
   */
  async handleError(response) {
    let message = `Gateway error: ${response.status} ${response.statusText}`;
    let code;
    try {
      const data = await response.json();
      message = data.detail || message;
      code = data.code;
    } catch {
    }
    return new GatewayConnectionError(message, response.status, code);
  }
};

export { GatewayConnectionError, NotaryError, ProvenanceClient, ProvenanceError, StampError, VerificationError, base64ToBytes, buildMetadata, bytesToBase64, extractContent, isValidSwarmReference, parseMetadata, serializeMetadata, sha256Hex, toBytes, verifyAllSignatures, verifyContentHash, verifyDataHash, verifySignature };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map