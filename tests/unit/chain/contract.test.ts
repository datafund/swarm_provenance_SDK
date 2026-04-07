import { describe, it, expect } from 'vitest';
import {
  encodeRegisterData,
  encodeRegisterDataFor,
  encodeRecordAccess,
  encodeRecordMergeTransformation,
  encodeGetDataRecord,
  encodeGetTransformationLinks,
  encodeGetChildHashes,
  encodeGetTransformationParents,
  encodeDataRecords,
  encodeSetDataStatus,
  encodeTransferDataOwnership,
  encodeBatchRegisterData,
  encodeGetDataHashByStorageRef,
} from '../../../src/chain/contract.js';
import type { Hex, Address } from '../../../src/chain/types.js';

const SAMPLE_HASH: Hex = `0x${'ab'.repeat(32)}`;
const SAMPLE_ADDRESS: Address = `0x${'cd'.repeat(20)}`;

describe('contract encoders', () => {
  it('encodeRegisterData returns hex-encoded calldata', () => {
    const result = encodeRegisterData(SAMPLE_HASH, 'dataset');
    expect(result).toMatch(/^0x/);
    expect(result.length).toBeGreaterThan(10);
  });

  it('encodeRecordAccess returns hex-encoded calldata', () => {
    const result = encodeRecordAccess(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  it('encodeGetDataRecord returns hex-encoded calldata', () => {
    const result = encodeGetDataRecord(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  it('encodeDataRecords returns hex-encoded calldata', () => {
    const result = encodeDataRecords(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  it('encodeSetDataStatus returns hex-encoded calldata', () => {
    const result = encodeSetDataStatus(SAMPLE_HASH, 1);
    expect(result).toMatch(/^0x/);
  });

  it('encodeTransferDataOwnership returns hex-encoded calldata', () => {
    const result = encodeTransferDataOwnership(SAMPLE_HASH, SAMPLE_ADDRESS);
    expect(result).toMatch(/^0x/);
  });

  it('encodeRecordMergeTransformation returns hex-encoded calldata', () => {
    const hashB: Hex = `0x${'cd'.repeat(32)}`;
    const hashMerged: Hex = `0x${'ee'.repeat(32)}`;
    const result = encodeRecordMergeTransformation(
      [SAMPLE_HASH, hashB],
      hashMerged,
      'merged',
      'merged-dataset',
    );
    expect(result).toMatch(/^0x/);
    expect(result.length).toBeGreaterThan(10);
  });

  it('encodeGetTransformationLinks returns hex-encoded calldata', () => {
    const result = encodeGetTransformationLinks(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  it('encodeGetChildHashes returns hex-encoded calldata', () => {
    const result = encodeGetChildHashes(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  it('encodeGetTransformationParents returns hex-encoded calldata', () => {
    const result = encodeGetTransformationParents(SAMPLE_HASH);
    expect(result).toMatch(/^0x/);
  });

  describe('storageRef overloads (#90)', () => {
    const STORAGE_REF: Hex = `0x${'ef'.repeat(32)}`;

    it('encodeRegisterData with storageRef produces different calldata', () => {
      const withoutRef = encodeRegisterData(SAMPLE_HASH, 'dataset');
      const withRef = encodeRegisterData(SAMPLE_HASH, 'dataset', STORAGE_REF);

      expect(withRef).toMatch(/^0x/);
      expect(withRef.length).toBeGreaterThan(withoutRef.length);
      // Different function selectors (overloaded)
      expect(withRef.slice(0, 10)).not.toBe(withoutRef.slice(0, 10));
    });

    it('encodeRegisterDataFor with storageRef produces different calldata', () => {
      const withoutRef = encodeRegisterDataFor(SAMPLE_HASH, 'dataset', SAMPLE_ADDRESS);
      const withRef = encodeRegisterDataFor(SAMPLE_HASH, 'dataset', SAMPLE_ADDRESS, STORAGE_REF);

      expect(withRef).toMatch(/^0x/);
      expect(withRef.length).toBeGreaterThan(withoutRef.length);
      expect(withRef.slice(0, 10)).not.toBe(withoutRef.slice(0, 10));
    });

    it('encodeBatchRegisterData with storageRefs produces different calldata', () => {
      const hashes: Hex[] = [SAMPLE_HASH];
      const types = ['dataset'];
      const refs: Hex[] = [STORAGE_REF];

      const withoutRefs = encodeBatchRegisterData(hashes, types);
      const withRefs = encodeBatchRegisterData(hashes, types, refs);

      expect(withRefs).toMatch(/^0x/);
      expect(withRefs.length).toBeGreaterThan(withoutRefs.length);
      expect(withRefs.slice(0, 10)).not.toBe(withoutRefs.slice(0, 10));
    });

    it('encodeGetDataHashByStorageRef returns hex-encoded calldata', () => {
      const result = encodeGetDataHashByStorageRef(STORAGE_REF);
      expect(result).toMatch(/^0x/);
      expect(result.length).toBeGreaterThan(10);
    });
  });

  it('different functions produce different selectors', () => {
    const register = encodeRegisterData(SAMPLE_HASH, 'test');
    const access = encodeRecordAccess(SAMPLE_HASH);
    const getRecord = encodeGetDataRecord(SAMPLE_HASH);

    // First 10 chars = 0x + 4 byte selector
    const registerSelector = register.slice(0, 10);
    const accessSelector = access.slice(0, 10);
    const getRecordSelector = getRecord.slice(0, 10);

    expect(registerSelector).not.toBe(accessSelector);
    expect(registerSelector).not.toBe(getRecordSelector);
    expect(accessSelector).not.toBe(getRecordSelector);
  });
});
