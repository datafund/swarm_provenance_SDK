import { useState, useEffect } from 'react';
import {
  ProvenanceClient,
  type UploadResult,
  type DownloadResult,
  type NotaryInfo,
} from '@datafund/swarm-provenance';

const client = new ProvenanceClient();

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
    </div>
  );
}

export default App;
