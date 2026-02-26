import { describe, it, expect } from 'vitest';
import {
  encodeRegisterData,
  encodeRecordAccess,
  encodeGetDataRecord,
  encodeDataRecords,
  encodeSetDataStatus,
  encodeTransferDataOwnership,
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
