/**
 * Attachment Store — the claim-check for user-attached files.
 *
 * IndexedDB `wb_attachments`, shared by the side panel (writes bytes once at
 * ingest) and the background (reads them by id at materialize/tool time).
 * Runtime messages carry only `att_…` ids plus display metadata, ending the
 * era of multi-megabyte base64 payloads inside `chat_start`.
 *
 * Two object stores per record:
 *   - `attachments`: metadata (indexes: tabId, createdAt, origin). Listing a
 *     tab's chips never deserializes file bytes.
 *   - `bytes`: the original file bytes as an ArrayBuffer keyed by the same
 *     id — immutable, byte-faithful for `upload_file` replay. (The plan
 *     sketched a Blob field on the record; a separate ArrayBuffer store
 *     keeps metadata reads cheap on every engine and lets Node tests fake
 *     the backend without Blob semantics.)
 *
 * Dependencies are injected (`idb`, `now`) so Node tests exercise the real
 * store logic against an in-memory fake. Every method rejects on backend
 * failure; callers degrade to the in-memory path and keep the user sending.
 */

export const ATTACHMENT_DB_NAME = 'wb_attachments';
export const ATTACHMENT_DB_VERSION = 1;
export const ATTACHMENT_RECORD_STORE = 'attachments';
export const ATTACHMENT_BYTES_STORE = 'bytes';

// Q1: records live 24 hours from last use, swept hourly by the background
// alarm; "session only" retention clears the store when a new browser
// session starts.
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_SWEEP_ALARM = 'wb-attachment-sweep';
export const ATTACHMENT_SWEEP_PERIOD_MINUTES = 60;
export const ATTACHMENT_RETENTION_KEY = 'attachmentRetentionMode'; // 'ttl' | 'session'
export const ATTACHMENT_SESSION_MARKER_KEY = 'wbAttachmentSessionMarker';

export const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9-]{8,64}$/;

export function newAttachmentId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `att_${uuid}`;
  } catch { /* fall through */ }
  return `att_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function isAttachmentId(value) {
  return typeof value === 'string' && ATTACHMENT_ID_PATTERN.test(value);
}

const ATTACHMENT_KINDS = new Set(['image', 'document', 'text', 'binary']);
const ATTACHMENT_ORIGINS = new Set(['user_upload', 'slash_screenshot']);
const ATTACHMENT_STATES = new Set(['pending', 'sending', 'sent']);

function sanitizeFacts(facts) {
  if (!facts || typeof facts !== 'object') return {};
  const out = {};
  if (Number.isFinite(Number(facts.pages))) out.pages = Math.max(0, Math.floor(Number(facts.pages)));
  if (typeof facts.hasTextLayer === 'boolean') out.hasTextLayer = facts.hasTextLayer;
  if (Number.isFinite(Number(facts.coverage))) out.coverage = Math.min(1, Math.max(0, Number(facts.coverage)));
  if (Number.isFinite(Number(facts.width))) out.width = Math.max(0, Math.floor(Number(facts.width)));
  if (Number.isFinite(Number(facts.height))) out.height = Math.max(0, Math.floor(Number(facts.height)));
  // How far into the document the original send (or the last read_attachment
  // call) delivered — the default resume point for the next read.
  if (Number.isFinite(Number(facts.sentToPage))) out.sentToPage = Math.max(0, Math.floor(Number(facts.sentToPage)));
  return out;
}

export function normalizeAttachmentRecord(record, now = Date.now()) {
  const id = String(record?.id || '');
  const tabId = Number(record?.tabId);
  if (!isAttachmentId(id) || !Number.isFinite(tabId)) return null;
  const kind = ATTACHMENT_KINDS.has(record?.kind) ? record.kind : 'binary';
  const state = ATTACHMENT_STATES.has(record?.state) ? record.state : 'pending';
  return {
    id,
    tabId,
    origin: ATTACHMENT_ORIGINS.has(record?.origin) ? record.origin : 'user_upload',
    name: String(record?.name || 'attachment').slice(0, 240),
    mime: String(record?.mime || '').slice(0, 160),
    kind,
    docType: record?.docType === 'pdf' || record?.docType === 'docx' ? record.docType : null,
    size: Number.isFinite(Number(record?.size)) ? Math.max(0, Number(record.size)) : 0,
    ...(kind === 'text' && typeof record?.textContent === 'string'
      ? { textContent: record.textContent }
      : {}),
    facts: sanitizeFacts(record?.facts),
    // Reserved for the slash-screenshot migration (Q5): capture-time privacy
    // metadata rides the record so redaction state survives the store move.
    ...(record?.redaction && typeof record.redaction === 'object' ? { redaction: record.redaction } : {}),
    state,
    ...(state === 'sending' && record?.requestId
      ? { requestId: String(record.requestId).slice(0, 200) }
      : {}),
    createdAt: Number.isFinite(Number(record?.createdAt)) ? Number(record.createdAt) : now,
    lastUsedAt: Number.isFinite(Number(record?.lastUsedAt)) ? Number(record.lastUsedAt) : now,
  };
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

function toArrayBuffer(bytes) {
  if (bytes == null) return null;
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return null;
}

export function createAttachmentStore({ idb = globalThis.indexedDB, now = Date.now } = {}) {
  if (!idb) throw new Error('IndexedDB is unavailable');
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = idb.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ATTACHMENT_RECORD_STORE)) {
          const store = db.createObjectStore(ATTACHMENT_RECORD_STORE, { keyPath: 'id' });
          store.createIndex('tabId', 'tabId');
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('origin', 'origin');
        }
        if (!db.objectStoreNames.contains(ATTACHMENT_BYTES_STORE)) {
          db.createObjectStore(ATTACHMENT_BYTES_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('IndexedDB open failed'));
      };
    });
    return dbPromise;
  }

  async function withStores(mode, fn) {
    const db = await openDB();
    const transaction = db.transaction([ATTACHMENT_RECORD_STORE, ATTACHMENT_BYTES_STORE], mode);
    const records = transaction.objectStore(ATTACHMENT_RECORD_STORE);
    const bytes = transaction.objectStore(ATTACHMENT_BYTES_STORE);
    const result = await fn(records, bytes, transaction);
    await transactionDone(transaction);
    return result;
  }

  async function listRecords(filter) {
    return withStores('readonly', async (records) => {
      const all = await promisifyRequest(records.getAll());
      return (Array.isArray(all) ? all : [])
        .map((record) => normalizeAttachmentRecord(record, now()))
        .filter(Boolean)
        .filter((record) => (filter ? filter(record) : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  return {
    /** Persist one record plus its immutable original bytes. */
    async put(record, bytesInput = null) {
      const normalized = normalizeAttachmentRecord(record, now());
      if (!normalized) throw new Error('Invalid attachment record');
      const buffer = toArrayBuffer(bytesInput);
      await withStores('readwrite', async (records, bytes) => {
        records.put(normalized);
        if (buffer) bytes.put(buffer, normalized.id);
      });
      return normalized;
    },

    /** Metadata only — never pulls file bytes. */
    async get(id) {
      if (!isAttachmentId(id)) return null;
      return withStores('readonly', async (records) => {
        const record = await promisifyRequest(records.get(id));
        return record ? normalizeAttachmentRecord(record, now()) : null;
      });
    },

    /** Original file bytes for materialize/upload replay, or null. */
    async getBytes(id) {
      if (!isAttachmentId(id)) return null;
      return withStores('readonly', async (records, bytes) => {
        const buffer = await promisifyRequest(bytes.get(id));
        return buffer instanceof ArrayBuffer ? buffer : null;
      });
    },

    /** Refresh lastUsedAt so an actively referenced file outlives the TTL. */
    async touch(id, timestamp = now()) {
      if (!isAttachmentId(id)) return false;
      return withStores('readwrite', async (records) => {
        const record = await promisifyRequest(records.get(id));
        if (!record) return false;
        record.lastUsedAt = Number(timestamp) || now();
        records.put(record);
        return true;
      });
    },

    async listByTab(tabId) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) return [];
      return listRecords((record) => record.tabId === numericTabId);
    },

    async listAll() {
      return listRecords(null);
    },

    /** Merge a partial patch (facts from probe, state transitions). */
    async patch(id, patch) {
      if (!isAttachmentId(id)) return null;
      return withStores('readwrite', async (records) => {
        const record = await promisifyRequest(records.get(id));
        if (!record) return null;
        const merged = normalizeAttachmentRecord({ ...record, ...patch, id: record.id, tabId: record.tabId }, now());
        if (!merged) return null;
        records.put(merged);
        return merged;
      });
    },

    async setState(ids, state, { requestId = '' } = {}) {
      if (!ATTACHMENT_STATES.has(state)) throw new Error(`Invalid attachment state: ${state}`);
      const valid = (Array.isArray(ids) ? ids : [ids]).filter(isAttachmentId);
      if (!valid.length) return 0;
      return withStores('readwrite', async (records) => {
        let updated = 0;
        for (const id of valid) {
          const record = await promisifyRequest(records.get(id));
          if (!record) continue;
          record.state = state;
          if (state === 'sending' && requestId) {
            record.requestId = String(requestId).slice(0, 200);
          } else {
            delete record.requestId;
          }
          record.lastUsedAt = now();
          const normalized = normalizeAttachmentRecord(record, now());
          if (normalized) {
            records.put(normalized);
            updated++;
          }
        }
        return updated;
      });
    },

    async remove(ids) {
      const valid = (Array.isArray(ids) ? ids : [ids]).filter(isAttachmentId);
      if (!valid.length) return 0;
      await withStores('readwrite', async (records, bytes) => {
        for (const id of valid) {
          records.delete(id);
          bytes.delete(id);
        }
      });
      return valid.length;
    },

    /**
     * Remove a tab's records — by default only chips still pending, which is
     * the "tab closed / conversation cleared" cleanup. Sent records stay for
     * read_attachment/upload replay until the TTL sweep collects them.
     */
    async removeByTab(tabId, { states = ['pending'] } = {}) {
      const wanted = new Set(states.filter((state) => ATTACHMENT_STATES.has(state)));
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId) || !wanted.size) return 0;
      return withStores('readwrite', async (records, bytes) => {
        const all = await promisifyRequest(records.getAll());
        let removed = 0;
        for (const record of Array.isArray(all) ? all : []) {
          const normalized = normalizeAttachmentRecord(record, now());
          if (!normalized || normalized.tabId !== numericTabId || !wanted.has(normalized.state)) continue;
          records.delete(normalized.id);
          bytes.delete(normalized.id);
          removed++;
        }
        return removed;
      });
    },

    /** Hourly TTL sweep: drop everything not used within `ttlMs`. */
    async sweep(ttlMs = ATTACHMENT_TTL_MS) {
      const cutoff = now() - Math.max(0, Number(ttlMs) || 0);
      return withStores('readwrite', async (records, bytes) => {
        const all = await promisifyRequest(records.getAll());
        let removed = 0;
        for (const record of Array.isArray(all) ? all : []) {
          const normalized = normalizeAttachmentRecord(record, now());
          if (!normalized || normalized.lastUsedAt >= cutoff) continue;
          records.delete(normalized.id);
          bytes.delete(normalized.id);
          removed++;
        }
        return removed;
      });
    },

    async clearAll() {
      await withStores('readwrite', async (records, bytes) => {
        records.clear();
        bytes.clear();
      });
    },

    /** Settings usage line: record count and summed original byte sizes. */
    async usage() {
      const records = await listRecords(null);
      return {
        count: records.length,
        bytes: records.reduce((sum, record) => sum + (record.size || 0), 0),
      };
    },
  };
}

// One store instance per JS context (side panel, background, settings page).
// They all open the same origin-scoped database, which is the whole point:
// bytes written once by the panel are readable by id from the background.
let sharedStore = null;

export function getSharedAttachmentStore() {
  if (!sharedStore) sharedStore = createAttachmentStore({});
  return sharedStore;
}

/** Test seam: replace or reset the shared instance. */
export function setSharedAttachmentStoreForTests(store) {
  sharedStore = store || null;
}

export function formatAttachmentUsageBytes(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function dataUrlToArrayBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) return null;
  try {
    const binaryStr = globalThis.atob ? globalThis.atob(match[1]) : Buffer.from(match[1], 'base64').toString('binary');
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

function resolveStore(storeOrArea) {
  if (storeOrArea && typeof storeOrArea.put === 'function' && typeof storeOrArea.get === 'function') {
    return storeOrArea;
  }
  try {
    return getSharedAttachmentStore();
  } catch {
    return null;
  }
}

export async function saveStagedScreenshot(storeOrArea, tabId, attachment) {
  const store = resolveStore(storeOrArea);
  const numericTabId = Number(tabId);
  if (!store || !Number.isFinite(numericTabId) || !attachment) return false;
  const dataUrl = String(attachment.dataUrl || '');
  const modelDataUrl = String(attachment.modelDataUrl || '');
  const size = Number(attachment.size);
  if (!/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)
      || (modelDataUrl && !/^data:image\/(?:png|jpeg);base64,/i.test(modelDataUrl))
      || !(Number.isFinite(size) && size > 0)) return false;

  let id = String(attachment.id || attachment.stagedAttachmentId || '');
  if (!isAttachmentId(id)) id = newAttachmentId();
  attachment.id = id;
  attachment.stagedAttachmentId = id;

  const buffer = dataUrlToArrayBuffer(dataUrl);
  const record = {
    id,
    tabId: numericTabId,
    origin: 'slash_screenshot',
    name: String(attachment.name || 'webbrain-screenshot.png').slice(0, 240),
    mime: String(attachment.mimeType || attachment.mime || '').startsWith('image/jpeg') ? 'image/jpeg' : 'image/png',
    kind: 'image',
    size,
    state: attachment.deliveryState === 'sending' ? 'sending' : 'pending',
    ...(attachment.requestId ? { requestId: String(attachment.requestId).slice(0, 200) } : {}),
    redaction: {
      dataUrl,
      modelDataUrl: attachment.modelRedactionReady === true && modelDataUrl ? modelDataUrl : null,
      modelRedactionReady: attachment.modelRedactionReady === true,
      redactionSnapshotReady: attachment.redactionSnapshotReady === true,
      ...(attachment.redactionSnapshot ? { redactionSnapshot: attachment.redactionSnapshot } : {}),
      ...(attachment.captureBounds ? { captureBounds: attachment.captureBounds } : {}),
      fullPage: attachment.fullPage === true,
    },
  };

  try {
    await store.put(record, buffer);
    const verifiedRecord = await store.get(id);
    const verifiedBytes = await store.getBytes(id);
    return !!verifiedRecord
      && !!verifiedBytes
      && verifiedRecord.id === id
      && verifiedRecord.size === size
      && verifiedRecord.redaction?.dataUrl === dataUrl
      && verifiedRecord.redaction?.modelRedactionReady === (attachment.modelRedactionReady === true)
      && String(verifiedRecord.redaction?.modelDataUrl || '') === String(attachment.modelDataUrl || '')
      && (verifiedRecord.state === 'pending' || verifiedRecord.state === 'sending');
  } catch {
    return false;
  }
}

export async function loadStagedScreenshots(storeOrArea, tabId) {
  const store = resolveStore(storeOrArea);
  const numericTabId = Number(tabId);
  if (!store || !Number.isFinite(numericTabId)) return [];
  try {
    const records = await store.listByTab(numericTabId);
    return records
      .filter((rec) => rec.origin === 'slash_screenshot')
      .map((rec) => ({
        version: 1,
        kind: 'image',
        source: 'slash_screenshot',
        id: rec.id,
        stagedAttachmentId: rec.id,
        name: rec.name,
        mimeType: rec.mime,
        size: rec.size,
        dataUrl: rec.redaction?.dataUrl || '',
        modelDataUrl: rec.redaction?.modelDataUrl || '',
        modelRedactionReady: rec.redaction?.modelRedactionReady === true,
        redactionSnapshotReady: rec.redaction?.redactionSnapshotReady === true,
        ...(rec.redaction?.redactionSnapshot ? { redactionSnapshot: rec.redaction.redactionSnapshot } : {}),
        ...(rec.redaction?.captureBounds ? { captureBounds: rec.redaction.captureBounds } : {}),
        fullPage: rec.redaction?.fullPage === true,
        deliveryState: rec.state === 'sending' ? 'sending' : 'pending',
        ...(rec.requestId ? { requestId: rec.requestId } : {}),
        capturedAt: rec.createdAt,
      }));
  } catch {
    return [];
  }
}

export async function markStagedScreenshots(storeOrArea, tabId, attachments, {
  deliveryState = 'pending',
  requestId = '',
} = {}) {
  const store = resolveStore(storeOrArea);
  if (!store) return false;
  const screenshotAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter((att) => att?.source === 'slash_screenshot');
  if (!screenshotAttachments.length) return true;

  const ids = screenshotAttachments
    .map((att) => att?.id || att?.stagedAttachmentId)
    .filter(isAttachmentId);
  if (!ids.length) return false;

  try {
    const updatedCount = await store.setState(ids, deliveryState, { requestId });
    if (updatedCount < ids.length) return false;

    for (const id of ids) {
      const verified = await store.get(id);
      if (!verified
          || verified.state !== deliveryState
          || (deliveryState === 'sending' && String(verified.requestId || '') !== String(requestId || ''))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeStagedScreenshot(storeOrArea, tabId, stagedAttachmentId) {
  const store = resolveStore(storeOrArea);
  const id = String(stagedAttachmentId || '');
  if (!store || !isAttachmentId(id)) return;
  await store.remove(id).catch(() => {});
}

export async function removeStagedScreenshots(storeOrArea, tabId, attachments) {
  const store = resolveStore(storeOrArea);
  if (!store) return;
  const ids = (Array.isArray(attachments) ? attachments : [])
    .map((att) => att?.id || att?.stagedAttachmentId)
    .filter(isAttachmentId);
  if (ids.length) await store.remove(ids).catch(() => {});
}

export async function clearStagedScreenshots(storeOrArea, tabId) {
  const store = resolveStore(storeOrArea);
  const numericTabId = Number(tabId);
  if (!store || !Number.isFinite(numericTabId)) return;
  await store.removeByTab(numericTabId, { states: ['pending', 'sending'] }).catch(() => {});
}

export const STAGED_SCREENSHOT_STORAGE_PREFIX = 'stagedScreenshotAttachments:';
export async function clearLegacyStagedScreenshots(storageArea, tabId = null) {
  if (!storageArea) return;
  const numericTabId = Number(tabId);
  const prefix = Number.isFinite(numericTabId)
    ? `${STAGED_SCREENSHOT_STORAGE_PREFIX}${numericTabId}:`
    : STAGED_SCREENSHOT_STORAGE_PREFIX;
  try {
    let keys = [];
    if (typeof storageArea.getKeys === 'function') {
      const all = await storageArea.getKeys();
      if (Array.isArray(all)) keys = all.filter((k) => k.startsWith(prefix));
    } else if (typeof storageArea.get === 'function') {
      const stored = await storageArea.get(null);
      keys = Object.keys(stored || {}).filter((k) => k.startsWith(prefix));
    }
    if (keys.length && typeof storageArea.remove === 'function') {
      await storageArea.remove(keys);
    }
  } catch {}
}
