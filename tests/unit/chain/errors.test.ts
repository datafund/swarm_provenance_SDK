import { describe, it, expect } from 'vitest';
import { ProvenanceError } from '../../../src/errors.js';
import {
  ChainError,
  ChainConfigurationError,
  ChainConnectionError,
  ChainTransactionError,
  ChainValidationError,
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  SignerRequiredError,
} from '../../../src/chain/errors.js';

describe('ChainError hierarchy', () => {
  it('ChainError extends ProvenanceError', () => {
    const err = new ChainError('test');
    expect(err).toBeInstanceOf(ProvenanceError);
    expect(err).toBeInstanceOf(ChainError);
    expect(err.name).toBe('ChainError');
  });

  it('ChainConfigurationError has correct code', () => {
    const err = new ChainConfigurationError('bad config');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('CHAIN_CONFIGURATION');
    expect(err.name).toBe('ChainConfigurationError');
  });

  it('ChainConnectionError has correct code', () => {
    const err = new ChainConnectionError('no rpc');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('CHAIN_CONNECTION');
  });

  it('ChainTransactionError stores txHash', () => {
    const err = new ChainTransactionError('reverted', '0xabc');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('CHAIN_TRANSACTION');
    expect(err.txHash).toBe('0xabc');
  });

  it('ChainValidationError has correct code', () => {
    const err = new ChainValidationError('bad input');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('CHAIN_VALIDATION');
  });

  it('DataAlreadyRegisteredError has correct properties', () => {
    const err = new DataAlreadyRegisteredError('0x123', '0xowner', 1700000000, 'dataset');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('DATA_ALREADY_REGISTERED');
    expect(err.name).toBe('DataAlreadyRegisteredError');
    expect(err.message).toContain('0x123');
    expect(err.message).toContain('already registered');
    expect(err.dataHash).toBe('0x123');
    expect(err.owner).toBe('0xowner');
    expect(err.timestamp).toBe(1700000000);
    expect(err.dataType).toBe('dataset');
  });

  it('DataNotRegisteredError includes hash in message', () => {
    const err = new DataNotRegisteredError('0x123');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('DATA_NOT_REGISTERED');
    expect(err.message).toContain('0x123');
  });

  it('SignerRequiredError has correct code', () => {
    const err = new SignerRequiredError();
    expect(err).toBeInstanceOf(ChainError);
    expect(err.code).toBe('SIGNER_REQUIRED');
  });
});
