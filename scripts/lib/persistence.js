/**
 * Persistence Module for Hivemind SESI
 *
 * Saves and loads trust model state to/from disk so that
 * cross-task learning survives server restarts.
 * Inspired by session management patterns from everything-claude-code.
 */

import fs from "fs";
import path from "path";

const DEFAULT_DATA_DIR = path.join(process.cwd(), ".hivemind", "data");

class TrustPersistence {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this.trustFile = path.join(this.dataDir, "trust-model.json");
    this.sessionsDir = path.join(this.dataDir, "sessions");
  }

  /**
   * Ensure data directories exist
   */
  ensureDirectories() {
    for (const dir of [this.dataDir, this.sessionsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Save trust model to disk
   * @param {object} trustData - Trust model data (from EpistemicTrustModel)
   * @returns {boolean} Success status
   */
  saveTrustModel(trustData) {
    try {
      this.ensureDirectories();
      const payload = {
        version: 2,
        savedAt: new Date().toISOString(),
        trust: trustData,
      };
      // Write atomically via temp file
      const tmpFile = this.trustFile + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpFile, this.trustFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load trust model from disk
   * @returns {object|null} Trust model data, or null if not found
   */
  loadTrustModel() {
    try {
      if (!fs.existsSync(this.trustFile)) return null;
      const raw = fs.readFileSync(this.trustFile, "utf8");
      const data = JSON.parse(raw);
      if (data.version !== 2 || !data.trust) return null;
      return data.trust;
    } catch {
      return null;
    }
  }

  /**
   * Save session summary to disk
   * @param {string} sessionId - Session identifier
   * @param {object} sessionData - Session data to persist
   * @returns {boolean} Success status
   */
  saveSession(sessionId, sessionData) {
    try {
      this.ensureDirectories();
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${date}-${sessionId}-session.json`;
      const filepath = path.join(this.sessionsDir, filename);
      const payload = {
        savedAt: new Date().toISOString(),
        sessionId,
        task: sessionData.task,
        status: sessionData.status,
        metrics: sessionData.metrics || {},
        decomposition: sessionData.decomposition || null,
        agentSelections: sessionData.agentSelections || [],
        trailStats: sessionData.trailStats || {},
      };
      fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List recent sessions
   * @param {number} limit - Maximum sessions to return
   * @returns {Array} Recent session summaries
   */
  listSessions(limit = 20) {
    try {
      this.ensureDirectories();
      const files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith("-session.json"))
        .sort()
        .reverse()
        .slice(0, limit);

      return files.map(f => {
        try {
          const raw = fs.readFileSync(path.join(this.sessionsDir, f), "utf8");
          const data = JSON.parse(raw);
          return {
            filename: f,
            sessionId: data.sessionId,
            task: data.task,
            savedAt: data.savedAt,
            status: data.status,
          };
        } catch {
          return { filename: f, error: "parse error" };
        }
      });
    } catch {
      return [];
    }
  }
}

export { TrustPersistence };
export default TrustPersistence;
