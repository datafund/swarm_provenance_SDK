/**
 * Base error class for all SDK errors
 */
declare class ProvenanceError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
/**
 * Error connecting to or communicating with the gateway
 */
declare class GatewayConnectionError extends ProvenanceError {
    readonly statusCode?: number | undefined;
    constructor(message: string, statusCode?: number | undefined, code?: string);
}
/**
 * Error related to postage stamps (acquisition, validation, etc.)
 */
declare class StampError extends ProvenanceError {
    constructor(message: string, code?: string);
}
/**
 * Error related to notary signing service
 */
declare class NotaryError extends ProvenanceError {
    constructor(message: string, code?: string);
}
/**
 * Error when signature verification fails
 */
declare class VerificationError extends ProvenanceError {
    constructor(message: string, code?: string);
}

export { GatewayConnectionError as G, NotaryError as N, ProvenanceError as P, StampError as S, VerificationError as V };
