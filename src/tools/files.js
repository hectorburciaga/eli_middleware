import * as backend from '../lib/backendClient.js';

/**
 * File connector stub.
 * Real implementations for OneDrive (MS Graph), Google Drive, and Dropbox
 * will be added in Phase 6. For now each method returns a clear stub
 * response so the orchestrator can inform the user gracefully.
 *
 * When a connection is configured, the connector reads its typeId to
 * decide which underlying SDK/API to use — no hardcoding.
 */

async function getConnectionConfig(connectionId) {
  try {
    const conn = await backend.getConnection(connectionId);
    if (!conn || conn.status !== 'configured') return null;
    return { typeId: conn.typeId, config: conn.config };
  } catch {
    return null;
  }
}

// ── Stub response helper ───────────────────────────────────────────────────────
function stub(connectionId, method) {
  return {
    stub: true,
    message: `File connector '${connectionId}' (${method}) will be available in Phase 6. Configure credentials in Settings → Connections first.`,
  };
}

// ── Public methods ────────────────────────────────────────────────────────────

/**
 * List files in a folder. Path is relative to the connection root.
 */
export async function listFiles(connectionId, folderPath = '/') {
  const conn = await getConnectionConfig(connectionId);
  if (!conn) return stub(connectionId, 'listFiles');

  // Route by connection type
  if (conn.typeId === 'onedrive')    return listOneDrive(conn.config, folderPath);
  if (conn.typeId === 'googledrive') return listGoogleDrive(conn.config, folderPath);
  if (conn.typeId === 'dropbox')     return listDropbox(conn.config, folderPath);

  return stub(connectionId, 'listFiles');
}

/**
 * Download a file's content. Returns a Buffer.
 */
export async function downloadFile(connectionId, filePath) {
  const conn = await getConnectionConfig(connectionId);
  if (!conn) return stub(connectionId, 'downloadFile');

  // TODO Phase 6: implement per typeId
  return stub(connectionId, 'downloadFile');
}

/**
 * Upload / overwrite a file with new content.
 * Only called after Cowork has staged the edit and user has confirmed.
 */
export async function uploadFile(connectionId, filePath, content) {
  const conn = await getConnectionConfig(connectionId);
  if (!conn) return stub(connectionId, 'uploadFile');

  // TODO Phase 6: implement per typeId
  return stub(connectionId, 'uploadFile');
}

// ── Per-provider implementations (Phase 6) ────────────────────────────────────

async function listOneDrive(config, folderPath) {
  // TODO: use MS Graph API with config.tenant_id, client_id, client_secret
  return stub('onedrive', 'listFiles');
}

async function listGoogleDrive(config, folderPath) {
  // TODO: use Google Drive API with config.service_account_email, private_key
  return stub('googledrive', 'listFiles');
}

async function listDropbox(config, folderPath) {
  // TODO: use Dropbox API with config.token
  return stub('dropbox', 'listFiles');
}
