import {
  encodeFunctionData,
  decodeFunctionResult,
  type Hex,
} from 'viem';
import { DATA_PROVENANCE_ABI } from './abi.js';
import type { Address } from './types.js';

/**
 * ABI encoding helpers for the DataProvenance contract.
 * All methods are encoded here so Phase 2 operations just need wiring.
 */

// ─── Read Encoders ───────────────────────────────────────────────

export function encodeGetDataRecord(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getDataRecord',
    args: [dataHash],
  });
}

export function encodeDataRecords(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'dataRecords',
    args: [dataHash],
  });
}

export function encodeGetUserDataRecords(user: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecords',
    args: [user],
  });
}

export function encodeGetUserDataRecordsCount(user: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecordsCount',
    args: [user],
  });
}

export function encodeGetUserDataRecordsPaginated(user: Address, offset: bigint, limit: bigint): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecordsPaginated',
    args: [user, offset, limit],
  });
}

export function encodeHasAddressAccessed(dataHash: Hex, accessor: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'hasAddressAccessed',
    args: [dataHash, accessor],
  });
}

export function encodeIsAuthorizedDelegate(owner: Address, delegate: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'isAuthorizedDelegate',
    args: [owner, delegate],
  });
}

export function encodeGetTransformationLinks(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getTransformationLinks',
    args: [dataHash],
  });
}

export function encodeGetChildHashes(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getChildHashes',
    args: [dataHash],
  });
}

export function encodeGetTransformationParents(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getTransformationParents',
    args: [dataHash],
  });
}

// ─── Write Encoders ──────────────────────────────────────────────

export function encodeRegisterData(dataHash: Hex, dataType: string): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'registerData',
    args: [dataHash, dataType],
  });
}

export function encodeRegisterDataFor(dataHash: Hex, dataType: string, actualOwner: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'registerDataFor',
    args: [dataHash, dataType, actualOwner],
  });
}

export function encodeRecordAccess(dataHash: Hex): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'recordAccess',
    args: [dataHash],
  });
}

export function encodeRecordMergeTransformation(
  sourceDataHashes: Hex[],
  newDataHash: Hex,
  transformation: string,
  newDataType: string,
): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'recordMergeTransformation',
    args: [sourceDataHashes, newDataHash, transformation, newDataType],
  });
}

export function encodeRecordTransformation(
  originalDataHash: Hex,
  newDataHash: Hex,
  transformation: string,
): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'recordTransformation',
    args: [originalDataHash, newDataHash, transformation],
  });
}

export function encodeSetDataStatus(dataHash: Hex, newStatus: number): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'setDataStatus',
    args: [dataHash, newStatus],
  });
}

export function encodeSetDelegate(delegate: Address, authorized: boolean): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'setDelegate',
    args: [delegate, authorized],
  });
}

export function encodeTransferDataOwnership(dataHash: Hex, newOwner: Address): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'transferDataOwnership',
    args: [dataHash, newOwner],
  });
}

export function encodeBatchRegisterData(dataHashes: Hex[], dataTypes: string[]): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'batchRegisterData',
    args: [dataHashes, dataTypes],
  });
}

export function encodeBatchRecordAccess(dataHashes: Hex[]): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'batchRecordAccess',
    args: [dataHashes],
  });
}

export function encodeBatchSetDataStatus(dataHashes: Hex[], statuses: number[]): Hex {
  return encodeFunctionData({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'batchSetDataStatus',
    args: [dataHashes, statuses],
  });
}

// ─── Result Decoders ─────────────────────────────────────────────

export function decodeGetDataRecord(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getDataRecord',
    data,
  });
}

export function decodeDataRecords(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'dataRecords',
    data,
  });
}

export function decodeGetUserDataRecords(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecords',
    data,
  });
}

export function decodeGetUserDataRecordsCount(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecordsCount',
    data,
  });
}

export function decodeHasAddressAccessed(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'hasAddressAccessed',
    data,
  });
}

export function decodeIsAuthorizedDelegate(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'isAuthorizedDelegate',
    data,
  });
}

export function decodeGetTransformationLinks(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getTransformationLinks',
    data,
  });
}

export function decodeGetChildHashes(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getChildHashes',
    data,
  });
}

export function decodeGetTransformationParents(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getTransformationParents',
    data,
  });
}

export function decodeGetUserDataRecordsPaginated(data: Hex) {
  return decodeFunctionResult({
    abi: DATA_PROVENANCE_ABI,
    functionName: 'getUserDataRecordsPaginated',
    data,
  });
}
