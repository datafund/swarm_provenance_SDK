import { useState, useEffect } from 'react';
import {
  ProvenanceClient,
  type UploadResult,
  type DownloadResult,
  type NotaryInfo,
} from '@datafund/swarm-provenance';
import {
  ChainClient,
  fromEip1193Provider,
  DataStatus,
  type ChainSigner,
  type ChainProvenanceRecord,
  type AnchorResult,
} from '@datafund/swarm-provenance/chain';

const client = new ProvenanceClient();

// EIP-1193 provider type for window.ethereum
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

function App() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [notaryInfo, setNotaryInfo] = useState<NotaryInfo | null>(null);

  // Upload state
  const [uploadText, setUploadText] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [useNotary, setUseNotary] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Download state
  const [downloadRef, setDownloadRef] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Chain state
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [chainClient, setChainClient] = useState<ChainClient | null>(null);
  const [chainPreset, setChainPreset] = useState<string>('base-sepolia');
  const [chainName, setChainName] = useState<string | null>(null);
  const [wrongChain, setWrongChain] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [anchorHash, setAnchorHash] = useState('');
  const [anchorType, setAnchorType] = useState('dataset');
  const [anchoring, setAnchoring] = useState(false);
  const [anchorResult, setAnchorResult] = useState<AnchorResult | null>(null);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [verifyHash, setVerifyHash] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyRecord, setVerifyRecord] = useState<ChainProvenanceRecord | null>(null);
  const [verifyNotFound, setVerifyNotFound] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const hasWallet = typeof window !== 'undefined' && !!window.ethereum;

  // Check health and notary on mount
  useEffect(() => {
    client.health().then(setHealthy);
    client.notaryInfo().then(setNotaryInfo).catch(() => setNotaryInfo(null));
  }, []);

  const handleUpload = async () => {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);

    try {
      const content = uploadFile || uploadText;
      if (!content) {
        throw new Error('Please enter text or select a file');
      }

      const result = await client.upload(content, {
        sign: useNotary ? 'notary' : undefined,
        standard: 'demo-v1',
      });

      setUploadResult(result);
      setDownloadRef(result.reference);
      // Auto-populate anchor hash with the content hash
      setAnchorHash(result.metadata.content_hash);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadResult(null);

    try {
      if (!downloadRef.trim()) {
        throw new Error('Please enter a reference');
      }

      const result = await client.download(downloadRef.trim());
      setDownloadResult(result);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  // Supported chain IDs
  const SUPPORTED_CHAINS: Record<number, string> = { 31337: 'hardhat', 84532: 'base-sepolia' };
  const CHAIN_NAMES: Record<number, string> = {
    1: 'Ethereum Mainnet', 31337: 'Hardhat', 84532: 'Base Sepolia',
    8453: 'Base', 11155111: 'Sepolia', 137: 'Polygon',
  };

  const setupChainClient = async (signer: ChainSigner, chainId: number) => {
    const preset = SUPPORTED_CHAINS[chainId];
    if (preset) {
      setChainPreset(preset);
      setChainName(CHAIN_NAMES[chainId] || `Chain ${chainId}`);
      setWrongChain(false);
      setChainClient(new ChainClient({ chain: preset, signer, txTimeout: 120_000 }));
    } else {
      setChainName(CHAIN_NAMES[chainId] || `Unknown (${chainId})`);
      setWrongChain(true);
      setChainClient(null);
    }
  };

  const handleConnectWallet = async () => {
    if (!window.ethereum) return;
    setConnecting(true);
    setAnchorError(null);

    try {
      const signer: ChainSigner = await fromEip1193Provider(window.ethereum);
      const address = await signer.getAddress();
      setWalletAddress(address);

      const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' }) as string;
      const chainId = parseInt(chainIdHex, 16);
      await setupChainClient(signer, chainId);

      // Listen for chain changes
      window.ethereum.on?.('chainChanged', () => {
        window.location.reload();
      });
    } catch (err) {
      setAnchorError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  };

  const handleSwitchChain = async (targetChainId: number) => {
    if (!window.ethereum) return;
    setSwitching(true);
    setAnchorError(null);

    const hexChainId = `0x${targetChainId.toString(16)}`;

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexChainId }],
      });
    } catch (err: any) {
      // 4902 = chain not added to MetaMask yet
      if (err?.code === 4902 || err?.message?.includes('Unrecognized chain ID')) {
        try {
          if (targetChainId === 31337) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: hexChainId,
                chainName: 'Hardhat Local',
                rpcUrls: ['http://127.0.0.1:8545'],
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              }],
            });
          } else if (targetChainId === 84532) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: hexChainId,
                chainName: 'Base Sepolia',
                rpcUrls: ['https://sepolia.base.org'],
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                blockExplorerUrls: ['https://sepolia.basescan.org'],
              }],
            });
          }
        } catch (addErr) {
          setAnchorError(addErr instanceof Error ? addErr.message : 'Failed to add network');
          setSwitching(false);
          return;
        }
      } else {
        setAnchorError(err instanceof Error ? err.message : 'Failed to switch network');
        setSwitching(false);
        return;
      }
    }

    // After switching, re-setup the client
    try {
      const signer: ChainSigner = await fromEip1193Provider(window.ethereum);
      const address = await signer.getAddress();
      setWalletAddress(address);
      await setupChainClient(signer, targetChainId);
    } catch (err) {
      setAnchorError(err instanceof Error ? err.message : 'Failed to reconnect after switch');
    } finally {
      setSwitching(false);
    }
  };

  const handleAnchor = async () => {
    if (!chainClient) return;
    setAnchoring(true);
    setAnchorError(null);
    setAnchorResult(null);

    try {
      if (!anchorHash.trim()) {
        throw new Error('Please enter a data hash to anchor');
      }
      console.log('[anchor] Starting anchor:', anchorHash.trim(), anchorType);
      console.log('[anchor] Chain preset:', chainPreset);
      const result = await chainClient.anchor(anchorHash.trim(), anchorType);
      console.log('[anchor] Success:', result);
      setAnchorResult(result);
      // Auto-populate verify hash
      setVerifyHash(anchorHash.trim());
    } catch (err) {
      console.error('[anchor] Error:', err);
      setAnchorError(err instanceof Error ? err.message : 'Anchor failed');
    } finally {
      setAnchoring(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    setVerifyRecord(null);
    setVerifyNotFound(false);

    try {
      if (!verifyHash.trim()) {
        throw new Error('Please enter a hash to verify');
      }
      // Read-only client - uses same chain as connected wallet (or base-sepolia default)
      const readClient = new ChainClient({ chain: chainPreset });
      const record = await readClient.getDataRecord(verifyHash.trim());
      setVerifyRecord(record);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not registered')) {
        setVerifyNotFound(true);
      } else {
        setVerifyError(err instanceof Error ? err.message : 'Verification failed');
      }
    } finally {
      setVerifying(false);
    }
  };

  const statusLabel = (status: DataStatus) => {
    switch (status) {
      case DataStatus.ACTIVE: return 'Active';
      case DataStatus.RESTRICTED: return 'Restricted';
      case DataStatus.DELETED: return 'Deleted';
      default: return `Unknown (${String(status)})`;
    }
  };

  return (
    <div className="container">
      <h1>Swarm Provenance Demo</h1>

      {/* Status Section */}
      <section className="status">
        <h2>Gateway Status</h2>
        <p>
          Health:{' '}
          {healthy === null ? (
            'Checking...'
          ) : healthy ? (
            <span className="success">Connected</span>
          ) : (
            <span className="error">Disconnected</span>
          )}
        </p>
        {notaryInfo && (
          <p>
            Notary:{' '}
            {notaryInfo.available ? (
              <span className="success">Available ({notaryInfo.address?.slice(0, 10)}...)</span>
            ) : (
              <span className="warning">Not available</span>
            )}
          </p>
        )}
      </section>

      {/* Upload Section */}
      <section className="upload">
        <h2>Upload</h2>

        <div className="input-group">
          <label>Text content:</label>
          <textarea
            value={uploadText}
            onChange={(e) => setUploadText(e.target.value)}
            placeholder="Enter text to upload..."
            rows={4}
            disabled={!!uploadFile}
          />
        </div>

        <div className="input-group">
          <label>Or select a file:</label>
          <input
            type="file"
            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
          />
          {uploadFile && (
            <button className="small" onClick={() => setUploadFile(null)}>
              Clear
            </button>
          )}
        </div>

        {notaryInfo?.available && (
          <div className="input-group checkbox">
            <label>
              <input
                type="checkbox"
                checked={useNotary}
                onChange={(e) => setUseNotary(e.target.checked)}
              />
              Sign with Notary
            </label>
          </div>
        )}

        <button onClick={handleUpload} disabled={uploading || (!uploadText && !uploadFile)}>
          {uploading ? 'Uploading...' : 'Upload'}
        </button>

        {uploadError && <p className="error">{uploadError}</p>}

        {uploadResult && (
          <div className="result">
            <h3>Upload Successful</h3>
            <p>
              <strong>Reference:</strong>
              <code>{uploadResult.reference}</code>
            </p>
            <p>
              <strong>Content Hash:</strong>
              <code>{uploadResult.metadata.content_hash}</code>
            </p>
            {uploadResult.signedDocument && (
              <p className="success">
                Signed by notary: {uploadResult.signedDocument.signatures[0]?.signer}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Download Section */}
      <section className="download">
        <h2>Download</h2>

        <div className="input-group">
          <label>Reference:</label>
          <input
            type="text"
            value={downloadRef}
            onChange={(e) => setDownloadRef(e.target.value)}
            placeholder="Enter Swarm reference (64 hex chars)..."
          />
        </div>

        <button onClick={handleDownload} disabled={downloading || !downloadRef.trim()}>
          {downloading ? 'Downloading...' : 'Download'}
        </button>

        {downloadError && <p className="error">{downloadError}</p>}

        {downloadResult && (
          <div className="result">
            <h3>Download Successful</h3>
            <p>
              <strong>Content Hash:</strong>
              <code>{downloadResult.metadata.content_hash}</code>
            </p>
            <p>
              <strong>Stamp ID:</strong>
              <code>{downloadResult.metadata.stamp_id}</code>
            </p>
            {downloadResult.metadata.provenance_standard && (
              <p>
                <strong>Standard:</strong> {downloadResult.metadata.provenance_standard}
              </p>
            )}
            {downloadResult.signatures && downloadResult.signatures.length > 0 && (
              <div className={`signature-section ${downloadResult.verified ? 'verified' : 'failed'}`}>
                <h4>Notary Signature</h4>

                {/* Verification Status */}
                <div className="verification-status">
                  {downloadResult.verified ? (
                    <div className="status-badge success">
                      <span className="icon">✓</span>
                      <span>Signature Verified</span>
                    </div>
                  ) : (
                    <div className="status-badge error">
                      <span className="icon">✗</span>
                      <span>Verification Failed</span>
                    </div>
                  )}
                  <p className="verification-explanation">
                    {downloadResult.verified
                      ? `Signature is cryptographically valid and signer matches the gateway notary.`
                      : `Signature verification failed. The signature may be invalid or the signer doesn't match the known notary.`}
                  </p>
                </div>

                {/* Signature Details */}
                {downloadResult.signatures.map((sig, index) => (
                  <div key={index} className="signature-details">
                    <div className="detail-row">
                      <span className="label">Signer:</span>
                      <code className="value">{sig.signer}</code>
                      {notaryInfo?.address && (
                        <span className={sig.signer.toLowerCase() === notaryInfo.address.toLowerCase() ? 'badge success' : 'badge warning'}>
                          {sig.signer.toLowerCase() === notaryInfo.address.toLowerCase() ? 'Matches Gateway Notary' : 'Unknown Signer'}
                        </span>
                      )}
                    </div>
                    <div className="detail-row">
                      <span className="label">Type:</span>
                      <span className="value">{sig.type}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Timestamp:</span>
                      <span className="value">{new Date(sig.timestamp).toLocaleString()}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Data Hash:</span>
                      <code className="value small">{sig.data_hash}</code>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="content-preview">
              <strong>Content:</strong>
              <pre>{new TextDecoder().decode(downloadResult.file)}</pre>
            </div>
          </div>
        )}
      </section>

      {/* Chain Anchoring Section */}
      <section className="chain">
        <h2>Blockchain Anchoring</h2>
        <p className="section-description">
          Anchor data hashes on the DataProvenance contract for immutable on-chain provenance.
        </p>

        {/* Wallet Connection */}
        {!hasWallet ? (
          <p className="warning">No wallet detected. Install MetaMask to use chain features.</p>
        ) : !walletAddress ? (
          <button onClick={handleConnectWallet} disabled={connecting}>
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        ) : (
          <div className="wallet-status">
            <span className="success">Connected:</span>{' '}
            <code>{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</code>
            {chainName && (
              <span style={{ marginLeft: 12 }}>
                on <strong>{chainName}</strong>
                {wrongChain && <span className="error" style={{ marginLeft: 8 }}>Unsupported chain</span>}
              </span>
            )}
          </div>
        )}

        {/* Wrong chain warning */}
        {walletAddress && wrongChain && (
          <div className="chain-switch">
            <p className="warning">
              Please switch to a supported network:
            </p>
            <button className="small" onClick={() => handleSwitchChain(31337)} disabled={switching}>
              {switching ? 'Switching...' : 'Switch to Hardhat (local)'}
            </button>
            <button className="small" onClick={() => handleSwitchChain(84532)} disabled={switching}>
              {switching ? 'Switching...' : 'Switch to Base Sepolia'}
            </button>
          </div>
        )}

        {/* Anchor Form */}
        {walletAddress && !wrongChain && (
          <>
            <h3>Anchor Data</h3>
            <div className="input-group">
              <label>Data Hash (SHA256):</label>
              <input
                type="text"
                value={anchorHash}
                onChange={(e) => setAnchorHash(e.target.value)}
                placeholder="64 hex characters (auto-populated after upload)"
              />
            </div>

            <div className="input-group">
              <label>Data Type:</label>
              <input
                type="text"
                value={anchorType}
                onChange={(e) => setAnchorType(e.target.value)}
                placeholder="e.g. dataset, model, document"
              />
            </div>

            <button onClick={handleAnchor} disabled={anchoring || !anchorHash.trim()}>
              {anchoring ? 'Anchoring...' : 'Anchor On-Chain'}
            </button>
          </>
        )}

        {anchorError && <p className="error">{anchorError}</p>}

        {anchorResult && (
          <div className="result">
            <h3>Anchored Successfully</h3>
            <div className="detail-row">
              <span className="label">Tx Hash:</span>
              <a href={anchorResult.explorerUrl} target="_blank" rel="noopener noreferrer">
                <code className="value">{anchorResult.txHash.slice(0, 10)}...{anchorResult.txHash.slice(-8)}</code>
              </a>
            </div>
            <div className="detail-row">
              <span className="label">Block:</span>
              <span className="value">{anchorResult.blockNumber}</span>
            </div>
            <div className="detail-row">
              <span className="label">Gas Used:</span>
              <span className="value">{anchorResult.gasUsed.toString()}</span>
            </div>
            <div className="detail-row">
              <span className="label">Owner:</span>
              <code className="value">{anchorResult.owner}</code>
            </div>
          </div>
        )}

        {/* Verify On-Chain */}
        <h3>Verify On-Chain</h3>
        <div className="input-group">
          <label>Data Hash to verify:</label>
          <input
            type="text"
            value={verifyHash}
            onChange={(e) => setVerifyHash(e.target.value)}
            placeholder="64 hex characters"
          />
        </div>

        <button onClick={handleVerify} disabled={verifying || !verifyHash.trim()}>
          {verifying ? 'Verifying...' : 'Verify On-Chain'}
        </button>

        {verifyError && <p className="error">{verifyError}</p>}

        {verifyNotFound && (
          <div className="result" style={{ borderLeftColor: '#ffc107' }}>
            <p><strong>Not found.</strong> This hash is not registered on-chain.</p>
          </div>
        )}

        {verifyRecord && (
          <div className="result">
            <h3>On-Chain Record</h3>
            <div className="detail-row">
              <span className="label">Owner:</span>
              <code className="value">{verifyRecord.owner}</code>
            </div>
            <div className="detail-row">
              <span className="label">Data Type:</span>
              <span className="value">{verifyRecord.dataType}</span>
            </div>
            <div className="detail-row">
              <span className="label">Status:</span>
              <span className={`badge ${verifyRecord.status === DataStatus.ACTIVE ? 'success' : 'warning'}`}>
                {statusLabel(verifyRecord.status)}
              </span>
            </div>
            <div className="detail-row">
              <span className="label">Registered:</span>
              <span className="value">{new Date(verifyRecord.timestamp * 1000).toLocaleString()}</span>
            </div>
            {verifyRecord.accessors.length > 0 && (
              <div className="detail-row">
                <span className="label">Accessors:</span>
                <span className="value">{verifyRecord.accessors.length}</span>
              </div>
            )}
            {verifyRecord.transformations.length > 0 && (
              <div className="detail-row">
                <span className="label">Transforms:</span>
                <span className="value">{verifyRecord.transformations.length}</span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
