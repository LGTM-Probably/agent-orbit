import fs from "fs";
import os from "os";
import path from "path";
import { performance } from "perf_hooks";
import { StringDecoder } from "string_decoder";
import { HarnessKind } from "../shared/types";
import {
  AntigravityFileContext,
  ingestAntigravityLine,
  parseAntigravityFilePath,
} from "./adapters/antigravityAdapter";
import {
  ClaudeFileContext,
  ingestClaudeLine,
  parseClaudeFilePath,
} from "./adapters/claudeAdapter";
import {
  CodexFileContext,
  ingestCodexLine,
  parseCodexFilePath,
} from "./adapters/codexAdapter";
import {
  ingestStrataLine,
  ingestStrataZstdFile,
  parseStrataFilePath,
  StrataFileContext,
} from "./adapters/strataAdapter";
import { GraphStore } from "./graphStore";

interface TrackedFile {
  filePath: string;
  harness: HarnessKind;
  offset: number;
  remainder: string;
  lastMtimeMs: number;
  decoder: StringDecoder;
  coldHydrating?: boolean;
  claudeCtx?: ClaudeFileContext;
  codexCtx?: CodexFileContext;
  agyCtx?: AntigravityFileContext;
  strataCtx?: StrataFileContext;
}

interface DiscoveredCandidate {
  filePath: string;
  mtimeMs: number;
}

const MAX_LOOKBACK_MS = 25 * 60 * 60 * 1000;
const CHUNK_SIZE = 64 * 1024;
const STARTUP_HOT_WINDOW_MS = 45 * 60 * 1000;
const STARTUP_MAX_IMMEDIATE_FILES = 12;
const STARTUP_INITIAL_SLICE_BYTES = 512 * 1024;
const COLD_HYDRATE_SLICE_BYTES = 256 * 1024;
const MAX_BUDGET_MS = 6;
const HYDRATE_YIELD_MS = 8;
const WATCH_COALESCE_MS = 30;
const DISCOVER_INTERVAL_MS = 10_000;
const COLD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MISSING_PATH_TTL_MS = 60 * 1000;
const CODEX_DATE_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

export class TranscriptTailer {
  private tracked = new Map<string, TrackedFile>();
  private queued = new Set<string>();
  /**
   * Maps normalized path -> mtimeMs (positive if existing cold file < cutoff;
   * negative `-checkedAtMs` if path did not exist when checked).
   */
  private coldFiles = new Map<string, number>();
  private lastColdSweepAt = 0;

  private readBuf = Buffer.allocUnsafe(CHUNK_SIZE);
  private dirtyWatchPaths = new Set<string>();
  private watchFlushTimer: NodeJS.Timeout | null = null;

  private pendingHydrationFiles: TrackedFile[] = [];
  private deferredCandidates: DiscoveredCandidate[] = [];
  private deferredPaths = new Set<string>();
  private deferredIdx = 0;
  private hydrateTimer: NodeJS.Timeout | null = null;
  private discoveringAsync = false;

  private tailTimer: NodeJS.Timeout | null = null;
  private discoverTimer: NodeJS.Timeout | null = null;
  private statusRefreshTimer: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private homeDir: string;
  private stopped = false;

  constructor(private store: GraphStore) {
    this.homeDir = process.env.USERPROFILE || os.homedir();
  }

  public start(): void {
    this.stopped = false;

    const now = Date.now();
    const hotCutoff = now - STARTUP_HOT_WINDOW_MS;
    const candidates = this.collectCandidates();
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const immediate: DiscoveredCandidate[] = [];
    const deferred: DiscoveredCandidate[] = [];
    for (const c of candidates) {
      if (c.mtimeMs >= hotCutoff && immediate.length < STARTUP_MAX_IMMEDIATE_FILES) {
        immediate.push(c);
      } else {
        deferred.push(c);
      }
    }

    const syncStart = performance.now();
    for (let i = 0; i < immediate.length; i++) {
      if (i > 0 && performance.now() - syncStart > 16) {
        deferred.unshift(...immediate.slice(i));
        break;
      }
      const c = immediate[i];
      this.tryRegisterFile(c.filePath, false, c.mtimeMs, STARTUP_INITIAL_SLICE_BYTES);
    }
    this.store.emitSnapshotNow();

    this.deferredCandidates = deferred;
    this.deferredPaths.clear();
    for (const d of deferred) {
      this.deferredPaths.add(d.filePath);
    }
    this.deferredIdx = 0;
    if (
      this.pendingHydrationFiles.length > 0 ||
      this.deferredIdx < this.deferredCandidates.length
    ) {
      this.scheduleHydrationSlice();
    }

    this.setupDirectoryWatchers();

    this.tailTimer = setInterval(() => {
      this.pollActiveFiles();
    }, 700);

    this.discoverTimer = setInterval(() => {
      void this.discoverFilesAsync();
    }, DISCOVER_INTERVAL_MS);

    this.statusRefreshTimer = setInterval(() => {
      this.store.emitSnapshotNow();
    }, 5000);
  }

  private scheduleHydrationSlice(): void {
    if (this.stopped || this.hydrateTimer) return;
    this.hydrateTimer = setTimeout(() => {
      this.hydrateTimer = null;
      this.runHydrationSlice();
    }, HYDRATE_YIELD_MS);
  }

  private runHydrationSlice(): void {
    if (this.stopped) return;
    const sliceStart = performance.now();

    while (performance.now() - sliceStart < MAX_BUDGET_MS) {
      if (this.pendingHydrationFiles.length > 0) {
        const tf = this.pendingHydrationFiles[0];
        const hasMore = this.readAppendedBytes(tf, false, COLD_HYDRATE_SLICE_BYTES);
        if (!hasMore) {
          tf.coldHydrating = false;
          this.pendingHydrationFiles.shift();
        }
      } else if (this.deferredIdx < this.deferredCandidates.length) {
        const cand = this.deferredCandidates[this.deferredIdx++];
        this.deferredPaths.delete(cand.filePath);
        this.tryRegisterFile(cand.filePath, false, cand.mtimeMs, COLD_HYDRATE_SLICE_BYTES);
      } else {
        break;
      }
    }

    if (
      this.pendingHydrationFiles.length > 0 ||
      this.deferredIdx < this.deferredCandidates.length
    ) {
      this.store.scheduleSnapshot();
      this.scheduleHydrationSlice();
    } else {
      this.deferredCandidates = [];
      this.deferredIdx = 0;
      this.store.emitSnapshotNow();
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.tailTimer) {
      clearInterval(this.tailTimer);
      this.tailTimer = null;
    }
    if (this.discoverTimer) {
      clearInterval(this.discoverTimer);
      this.discoverTimer = null;
    }
    if (this.statusRefreshTimer) {
      clearInterval(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
    if (this.watchFlushTimer) {
      clearTimeout(this.watchFlushTimer);
      this.watchFlushTimer = null;
    }
    if (this.hydrateTimer) {
      clearTimeout(this.hydrateTimer);
      this.hydrateTimer = null;
    }
    this.dirtyWatchPaths.clear();
    this.pendingHydrationFiles = [];
    this.deferredCandidates = [];
    this.deferredPaths.clear();
    this.deferredIdx = 0;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }

  public getTrackedFileCount(): number {
    return this.tracked.size;
  }

  private invalidateColdPath(fullPath: string): void {
    this.coldFiles.delete(fullPath);
    const parent = path.dirname(fullPath);
    this.coldFiles.delete(parent);
    const grandParent = path.dirname(parent);
    this.coldFiles.delete(grandParent);
    this.coldFiles.delete(path.dirname(grandParent));
    const norm = fullPath.replace(/\\/g, "/");
    if (norm.includes("/.system_generated/logs/transcript")) {
      this.coldFiles.delete(path.normalize(path.join(parent, "transcript_full.jsonl")));
      this.coldFiles.delete(path.normalize(path.join(parent, "transcript.jsonl")));
    }
  }

  private setupDirectoryWatchers(): void {
    const dirs = [
      path.join(this.homeDir, ".claude", "projects"),
      path.join(this.homeDir, ".codex", "sessions"),
      path.join(this.homeDir, ".gemini", "antigravity", "brain"),
      path.join(this.homeDir, ".strata"),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename || (!filename.endsWith(".jsonl") && !filename.endsWith(".zstd"))) return;
          const full = path.normalize(path.join(dir, filename));
          this.invalidateColdPath(full);
          this.dirtyWatchPaths.add(full);
          if (!this.watchFlushTimer && !this.stopped) {
            this.watchFlushTimer = setTimeout(() => {
              this.flushDirtyWatchPaths();
            }, WATCH_COALESCE_MS);
          }
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {}
    }
  }

  private flushDirtyWatchPaths(): void {
    this.watchFlushTimer = null;
    if (this.stopped || this.dirtyWatchPaths.size === 0) {
      this.dirtyWatchPaths.clear();
      return;
    }

    const batch = Array.from(this.dirtyWatchPaths);
    this.dirtyWatchPaths.clear();

    const resolvedPaths = new Set<string>();
    for (let full of batch) {
      this.invalidateColdPath(full);
      const norm = full.replace(/\\/g, "/");
      if (norm.includes("/.system_generated/logs/transcript")) {
        const folder = path.dirname(full);
        const fullJsonl = path.normalize(path.join(folder, "transcript_full.jsonl"));
        this.coldFiles.delete(fullJsonl);
        if (safeMtime(fullJsonl) > 0) {
          full = fullJsonl;
        }
      }
      resolvedPaths.add(full);
    }

    for (const full of resolvedPaths) {
      this.deferredPaths.delete(full);
      const existing = this.tracked.get(full);
      if (existing) {
        if (!existing.coldHydrating) {
          this.readAppendedBytes(existing, true);
        }
      } else {
        this.tryRegisterFile(full, true);
      }
    }
  }

  public discoverFiles(isLive: boolean): void {
    const candidates = this.collectCandidates();
    for (const c of candidates) {
      if (isLive && this.deferredPaths.has(c.filePath)) continue;
      this.deferredPaths.delete(c.filePath);
      this.tryRegisterFile(c.filePath, isLive, c.mtimeMs);
    }
  }

  public async discoverFilesAsync(): Promise<void> {
    if (this.stopped || this.discoveringAsync) return;
    this.discoveringAsync = true;
    try {
      const now = Date.now();
      this.maybeResetColdCache(now);
      const cutoff = now - MAX_LOOKBACK_MS;
      const out: DiscoveredCandidate[] = [];

      await this.collectClaudeProjectsAsync(cutoff, now, out);
      if (this.stopped) return;
      await this.collectCodexSessionsAsync(cutoff, now, out);
      if (this.stopped) return;
      await this.collectAntigravityBrainAsync(cutoff, now, out);
      if (this.stopped) return;
      await this.collectStrataSessionsAsync(cutoff, now, out);
      if (this.stopped) return;

      for (const c of out) {
        if (this.stopped) return;
        if (this.deferredPaths.has(c.filePath)) continue;
        this.tryRegisterFile(c.filePath, true, c.mtimeMs, COLD_HYDRATE_SLICE_BYTES);
      }
    } finally {
      this.discoveringAsync = false;
    }
  }

  private maybeResetColdCache(now: number): void {
    if (this.lastColdSweepAt === 0) {
      this.lastColdSweepAt = now;
      return;
    }
    if (now - this.lastColdSweepAt >= COLD_SWEEP_INTERVAL_MS) {
      this.coldFiles.clear();
      this.lastColdSweepAt = now;
    }
  }

  private getMtimeCachedSync(full: string, now: number, cutoff: number): number {
    const cached = this.coldFiles.get(full);
    if (cached !== undefined) {
      if (cached > 0) {
        if (cached < cutoff) return cached;
        this.coldFiles.delete(full);
      } else {
        if (now + cached < MISSING_PATH_TTL_MS) return 0;
        this.coldFiles.delete(full);
      }
    }

    const mtime = safeMtime(full);
    if (mtime <= 0) {
      this.coldFiles.set(full, -now);
      return 0;
    }
    if (mtime < cutoff) {
      this.coldFiles.set(full, mtime);
    } else {
      this.coldFiles.delete(full);
    }
    return mtime;
  }

  private async getMtimeCachedAsync(full: string, now: number, cutoff: number): Promise<number> {
    const cached = this.coldFiles.get(full);
    if (cached !== undefined) {
      if (cached > 0) {
        if (cached < cutoff) return cached;
        this.coldFiles.delete(full);
      } else {
        if (now + cached < MISSING_PATH_TTL_MS) return 0;
        this.coldFiles.delete(full);
      }
    }

    const mtime = await safeMtimeAsync(full);
    if (mtime <= 0) {
      this.coldFiles.set(full, -now);
      return 0;
    }
    if (mtime < cutoff) {
      this.coldFiles.set(full, mtime);
    } else {
      this.coldFiles.delete(full);
    }
    return mtime;
  }

  private collectCandidates(): DiscoveredCandidate[] {
    const now = Date.now();
    this.maybeResetColdCache(now);
    const cutoff = now - MAX_LOOKBACK_MS;
    const out: DiscoveredCandidate[] = [];
    this.collectClaudeProjects(cutoff, now, out);
    this.collectCodexSessions(cutoff, now, out);
    this.collectAntigravityBrain(cutoff, now, out);
    this.collectStrataSessions(cutoff, now, out);
    return out;
  }

  private collectStrataSessions(cutoff: number, now: number, out: DiscoveredCandidate[]): void {
    const root = path.join(this.homeDir, ".strata");
    if (!fs.existsSync(root)) return;

    this.walkRecentJsonlSync(root, 6, cutoff, now, (full, mtime) => {
      out.push({ filePath: full, mtimeMs: mtime });
    });
  }

  private async collectStrataSessionsAsync(
    cutoff: number,
    now: number,
    out: DiscoveredCandidate[]
  ): Promise<void> {
    const root = path.join(this.homeDir, ".strata");
    await this.walkRecentJsonlAsync(root, 6, cutoff, now, (full, mtime) => {
      out.push({ filePath: full, mtimeMs: mtime });
    });
  }

  private collectClaudeProjects(cutoff: number, now: number, out: DiscoveredCandidate[]): void {
    const root = path.join(this.homeDir, ".claude", "projects");
    if (!fs.existsSync(root)) return;

    let projDirs: fs.Dirent[];
    try {
      projDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const proj of projDirs) {
      if (!proj.isDirectory()) continue;
      const projPath = path.normalize(path.join(root, proj.name));
      const cachedColdProj = this.coldFiles.get(projPath);
      if (cachedColdProj !== undefined && cachedColdProj <= 0 && now + cachedColdProj < 30_000) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const activeSessionIds = new Set<string>();
      const sessionMtimes = new Map<string, number>();

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const full = path.normalize(path.join(projPath, entry.name));
          const sessionId = path.basename(entry.name, ".jsonl");
          if (this.tracked.has(full) || this.deferredPaths.has(full)) {
            activeSessionIds.add(sessionId);
            continue;
          }
          const mtime = this.getMtimeCachedSync(full, now, cutoff);
          sessionMtimes.set(sessionId, mtime);
          if (mtime >= cutoff) {
            activeSessionIds.add(sessionId);
            out.push({ filePath: full, mtimeMs: mtime });
          }
        }
      }

      let foundRecentSub = false;
      const staleParentCutoff = cutoff - 2 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const includeAllSubs = activeSessionIds.has(entry.name);
        if (!includeAllSubs) {
          const parentMtime = sessionMtimes.get(entry.name);
          if (parentMtime !== undefined && parentMtime > 0 && parentMtime < staleParentCutoff) {
            continue;
          }
        }
        const sessionDir = path.join(projPath, entry.name);
        const subDir = path.normalize(path.join(sessionDir, "subagents"));

        const cachedMissing = this.coldFiles.get(subDir);
        if (cachedMissing !== undefined && cachedMissing <= 0 && now + cachedMissing < MISSING_PATH_TTL_MS) {
          continue;
        }

        let subFiles: fs.Dirent[];
        try {
          subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        } catch {
          this.coldFiles.set(subDir, -now);
          continue;
        }

        for (const sf of subFiles) {
          if (!sf.isFile() || !sf.name.endsWith(".jsonl")) continue;
          const full = path.normalize(path.join(subDir, sf.name));
          if (this.tracked.has(full) || this.deferredPaths.has(full)) {
            foundRecentSub = true;
            continue;
          }
          if (includeAllSubs) {
            const mtime = safeMtime(full);
            if (mtime > 0) {
              foundRecentSub = true;
              out.push({ filePath: full, mtimeMs: mtime });
            }
          } else {
            const mtime = this.getMtimeCachedSync(full, now, cutoff);
            if (mtime >= cutoff) {
              foundRecentSub = true;
              out.push({ filePath: full, mtimeMs: mtime });
            }
          }
        }
      }

      if (activeSessionIds.size === 0 && !foundRecentSub) {
        this.coldFiles.set(projPath, -now);
      } else {
        this.coldFiles.delete(projPath);
      }
    }
  }

  private async collectClaudeProjectsAsync(
    cutoff: number,
    now: number,
    out: DiscoveredCandidate[]
  ): Promise<void> {
    const root = path.join(this.homeDir, ".claude", "projects");
    let projDirs: fs.Dirent[];
    try {
      projDirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const proj of projDirs) {
      if (this.stopped || !proj.isDirectory()) continue;
      const projPath = path.join(root, proj.name);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(projPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const activeSessionIds = new Set<string>();
      const sessionMtimes = new Map<string, number>();

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const full = path.normalize(path.join(projPath, entry.name));
          const sessionId = path.basename(entry.name, ".jsonl");
          if (this.tracked.has(full) || this.deferredPaths.has(full)) {
            activeSessionIds.add(sessionId);
            continue;
          }
          const mtime = await this.getMtimeCachedAsync(full, now, cutoff);
          sessionMtimes.set(sessionId, mtime);
          if (mtime >= cutoff) {
            activeSessionIds.add(sessionId);
            out.push({ filePath: full, mtimeMs: mtime });
          }
        }
      }

      const staleParentCutoff = cutoff - 2 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (this.stopped || !entry.isDirectory()) continue;
        const includeAllSubs = activeSessionIds.has(entry.name);
        if (!includeAllSubs) {
          const parentMtime = sessionMtimes.get(entry.name);
          if (parentMtime !== undefined && parentMtime > 0 && parentMtime < staleParentCutoff) {
            continue;
          }
        }
        const sessionDir = path.join(projPath, entry.name);
        const subDir = path.normalize(path.join(sessionDir, "subagents"));

        const cachedMissing = this.coldFiles.get(subDir);
        if (cachedMissing !== undefined && cachedMissing <= 0 && now + cachedMissing < MISSING_PATH_TTL_MS) {
          continue;
        }

        let subFiles: fs.Dirent[];
        try {
          subFiles = await fs.promises.readdir(subDir, { withFileTypes: true });
        } catch {
          this.coldFiles.set(subDir, -now);
          continue;
        }

        for (const sf of subFiles) {
          if (!sf.isFile() || !sf.name.endsWith(".jsonl")) continue;
          const full = path.normalize(path.join(subDir, sf.name));
          if (this.tracked.has(full) || this.deferredPaths.has(full)) continue;
          if (includeAllSubs) {
            const mtime = await safeMtimeAsync(full);
            if (mtime > 0) {
              out.push({ filePath: full, mtimeMs: mtime });
            }
          } else {
            const mtime = await this.getMtimeCachedAsync(full, now, cutoff);
            if (mtime >= cutoff) {
              out.push({ filePath: full, mtimeMs: mtime });
            }
          }
        }
      }
    }
  }

  private collectCodexSessions(cutoff: number, now: number, out: DiscoveredCandidate[]): void {
    const root = path.join(this.homeDir, ".codex", "sessions");
    if (!fs.existsSync(root)) return;

    const dateCutoff = cutoff - CODEX_DATE_MARGIN_MS;
    let yearEntries: fs.Dirent[];
    try {
      yearEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ye of yearEntries) {
      const yFull = path.join(root, ye.name);
      if (ye.isFile() && ye.name.endsWith(".jsonl")) {
        const norm = path.normalize(yFull);
        if (!this.tracked.has(norm)) {
          const mtime = this.getMtimeCachedSync(norm, now, cutoff);
          if (mtime >= cutoff) out.push({ filePath: norm, mtimeMs: mtime });
        }
        continue;
      }
      if (!ye.isDirectory()) continue;

      if (!/^\d{4}$/.test(ye.name)) {
        this.walkRecentJsonlSync(yFull, 3, cutoff, now, (full, mtime) => {
          out.push({ filePath: full, mtimeMs: mtime });
        });
        continue;
      }

      const year = Number(ye.name);
      if (Date.UTC(year + 1, 0, 1) < dateCutoff) continue;

      let monthEntries: fs.Dirent[];
      try {
        monthEntries = fs.readdirSync(yFull, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const me of monthEntries) {
        if (!me.isDirectory()) continue;
        const mFull = path.join(yFull, me.name);
        if (!/^\d{1,2}$/.test(me.name)) {
          this.walkRecentJsonlSync(mFull, 2, cutoff, now, (full, mtime) => {
            out.push({ filePath: full, mtimeMs: mtime });
          });
          continue;
        }

        const month = Number(me.name);
        if (Date.UTC(year, month, 1) < dateCutoff) continue;

        let dayEntries: fs.Dirent[];
        try {
          dayEntries = fs.readdirSync(mFull, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const de of dayEntries) {
          if (!de.isDirectory()) continue;
          const dFull = path.join(mFull, de.name);
          if (/^\d{1,2}$/.test(de.name)) {
            const day = Number(de.name);
            if (Date.UTC(year, month - 1, day) < dateCutoff) continue;
          }
          this.walkRecentJsonlSync(dFull, 1, cutoff, now, (full, mtime) => {
            out.push({ filePath: full, mtimeMs: mtime });
          });
        }
      }
    }
  }

  private async collectCodexSessionsAsync(
    cutoff: number,
    now: number,
    out: DiscoveredCandidate[]
  ): Promise<void> {
    const root = path.join(this.homeDir, ".codex", "sessions");
    const dateCutoff = cutoff - CODEX_DATE_MARGIN_MS;

    let yearEntries: fs.Dirent[];
    try {
      yearEntries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ye of yearEntries) {
      if (this.stopped) return;
      const yFull = path.join(root, ye.name);
      if (ye.isFile() && ye.name.endsWith(".jsonl")) {
        const norm = path.normalize(yFull);
        if (!this.tracked.has(norm)) {
          const mtime = await this.getMtimeCachedAsync(norm, now, cutoff);
          if (mtime >= cutoff) out.push({ filePath: norm, mtimeMs: mtime });
        }
        continue;
      }
      if (!ye.isDirectory()) continue;

      if (!/^\d{4}$/.test(ye.name)) {
        await this.walkRecentJsonlAsync(yFull, 3, cutoff, now, (full, mtime) => {
          out.push({ filePath: full, mtimeMs: mtime });
        });
        continue;
      }

      const year = Number(ye.name);
      if (Date.UTC(year + 1, 0, 1) < dateCutoff) continue;

      let monthEntries: fs.Dirent[];
      try {
        monthEntries = await fs.promises.readdir(yFull, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const me of monthEntries) {
        if (this.stopped || !me.isDirectory()) continue;
        const mFull = path.join(yFull, me.name);
        if (!/^\d{1,2}$/.test(me.name)) {
          await this.walkRecentJsonlAsync(mFull, 2, cutoff, now, (full, mtime) => {
            out.push({ filePath: full, mtimeMs: mtime });
          });
          continue;
        }

        const month = Number(me.name);
        if (Date.UTC(year, month, 1) < dateCutoff) continue;

        let dayEntries: fs.Dirent[];
        try {
          dayEntries = await fs.promises.readdir(mFull, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const de of dayEntries) {
          if (this.stopped || !de.isDirectory()) continue;
          const dFull = path.join(mFull, de.name);
          if (/^\d{1,2}$/.test(de.name)) {
            const day = Number(de.name);
            if (Date.UTC(year, month - 1, day) < dateCutoff) continue;
          }
          await this.walkRecentJsonlAsync(dFull, 1, cutoff, now, (full, mtime) => {
            out.push({ filePath: full, mtimeMs: mtime });
          });
        }
      }
    }
  }

  private collectAntigravityBrain(cutoff: number, now: number, out: DiscoveredCandidate[]): void {
    const root = path.join(this.homeDir, ".gemini", "antigravity", "brain");
    if (!fs.existsSync(root)) return;

    let convDirs: fs.Dirent[];
    try {
      convDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const conv of convDirs) {
      if (!conv.isDirectory()) continue;
      const logsDir = path.join(root, conv.name, ".system_generated", "logs");
      const transcriptFull = path.normalize(path.join(logsDir, "transcript_full.jsonl"));
      if (this.tracked.has(transcriptFull) || this.deferredPaths.has(transcriptFull)) continue;

      const fullMtime = this.getMtimeCachedSync(transcriptFull, now, cutoff);
      if (fullMtime > 0) {
        if (fullMtime >= cutoff) {
          out.push({ filePath: transcriptFull, mtimeMs: fullMtime });
        }
        continue;
      }

      const transcript = path.normalize(path.join(logsDir, "transcript.jsonl"));
      if (this.tracked.has(transcript) || this.deferredPaths.has(transcript)) continue;

      const mtime = this.getMtimeCachedSync(transcript, now, cutoff);
      if (mtime >= cutoff) {
        out.push({ filePath: transcript, mtimeMs: mtime });
      }
    }
  }

  private async collectAntigravityBrainAsync(
    cutoff: number,
    now: number,
    out: DiscoveredCandidate[]
  ): Promise<void> {
    const root = path.join(this.homeDir, ".gemini", "antigravity", "brain");
    let convDirs: fs.Dirent[];
    try {
      convDirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const conv of convDirs) {
      if (this.stopped || !conv.isDirectory()) continue;
      const logsDir = path.join(root, conv.name, ".system_generated", "logs");
      const transcriptFull = path.normalize(path.join(logsDir, "transcript_full.jsonl"));
      if (this.tracked.has(transcriptFull) || this.deferredPaths.has(transcriptFull)) continue;

      const fullMtime = await this.getMtimeCachedAsync(transcriptFull, now, cutoff);
      if (fullMtime > 0) {
        if (fullMtime >= cutoff) {
          out.push({ filePath: transcriptFull, mtimeMs: fullMtime });
        }
        continue;
      }

      const transcript = path.normalize(path.join(logsDir, "transcript.jsonl"));
      if (this.tracked.has(transcript) || this.deferredPaths.has(transcript)) continue;

      const mtime = await this.getMtimeCachedAsync(transcript, now, cutoff);
      if (mtime >= cutoff) {
        out.push({ filePath: transcript, mtimeMs: mtime });
      }
    }
  }

  private walkRecentJsonlSync(
    dir: string,
    maxDepth: number,
    cutoff: number,
    now: number,
    onFile: (fullPath: string, mtime: number) => void
  ): void {
    if (maxDepth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this.walkRecentJsonlSync(full, maxDepth - 1, cutoff, now, onFile);
      } else if (
        e.isFile() &&
        (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zstd"))
      ) {
        const norm = path.normalize(full);
        if (this.tracked.has(norm) || this.queued.has(norm) || this.deferredPaths.has(norm)) continue;
        const mtime = this.getMtimeCachedSync(norm, now, cutoff);
        if (mtime >= cutoff) {
          onFile(norm, mtime);
        }
      }
    }
  }

  private async walkRecentJsonlAsync(
    dir: string,
    maxDepth: number,
    cutoff: number,
    now: number,
    onFile: (fullPath: string, mtime: number) => void
  ): Promise<void> {
    if (maxDepth < 0 || this.stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (this.stopped) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.walkRecentJsonlAsync(full, maxDepth - 1, cutoff, now, onFile);
      } else if (
        e.isFile() &&
        (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zstd"))
      ) {
        const norm = path.normalize(full);
        if (this.tracked.has(norm) || this.queued.has(norm) || this.deferredPaths.has(norm)) continue;
        const mtime = await this.getMtimeCachedAsync(norm, now, cutoff);
        if (mtime >= cutoff) {
          onFile(norm, mtime);
        }
      }
    }
  }

  private registerTrackedAndRead(
    tf: TrackedFile,
    isLive: boolean,
    maxBytesToRead?: number
  ): void {
    this.tracked.set(tf.filePath, tf);
    const hasMore = this.readAppendedBytes(tf, isLive, maxBytesToRead);
    if (hasMore) {
      tf.coldHydrating = true;
      this.pendingHydrationFiles.push(tf);
      this.scheduleHydrationSlice();
    }
  }

  private tryRegisterFile(
    filePath: string,
    isLive: boolean,
    knownMtime?: number,
    maxBytesToRead?: number
  ): void {
    const key = path.normalize(filePath);
    if (this.tracked.has(key) || this.queued.has(key)) return;

    const mtime = knownMtime ?? safeMtime(key);
    if (mtime <= 0) return;

    const claudeCtx = parseClaudeFilePath(key);
    if (claudeCtx) {
      this.registerTrackedAndRead(
        {
          filePath: key,
          harness: "claude",
          offset: 0,
          remainder: "",
          lastMtimeMs: mtime,
          decoder: new StringDecoder("utf8"),
          claudeCtx,
        },
        isLive,
        maxBytesToRead
      );
      return;
    }

    const codexCtx = parseCodexFilePath(key);
    if (codexCtx && key.toLowerCase().includes(".codex")) {
      this.registerTrackedAndRead(
        {
          filePath: key,
          harness: "codex",
          offset: 0,
          remainder: "",
          lastMtimeMs: mtime,
          decoder: new StringDecoder("utf8"),
          codexCtx,
        },
        isLive,
        maxBytesToRead
      );
      return;
    }

    const agyCtx = parseAntigravityFilePath(key);
    if (agyCtx) {
      let resolvedKey = key;
      const normKey = key.replace(/\\/g, "/");
      if (normKey.endsWith("/transcript.jsonl")) {
        const fullVariant = path.normalize(
          key.replace(/transcript\.jsonl$/i, "transcript_full.jsonl")
        );
        if (safeMtime(fullVariant) > 0) {
          resolvedKey = fullVariant;
        }
      }
      if (this.tracked.has(resolvedKey) || this.queued.has(resolvedKey)) return;
      const actualMtime = resolvedKey === key ? mtime : safeMtime(resolvedKey) || mtime;
      this.registerTrackedAndRead(
        {
          filePath: resolvedKey,
          harness: "antigravity",
          offset: 0,
          remainder: "",
          lastMtimeMs: actualMtime,
          decoder: new StringDecoder("utf8"),
          agyCtx: {
            ...agyCtx,
            filePath: resolvedKey,
          },
        },
        isLive,
        maxBytesToRead
      );
      return;
    }

    if (key.endsWith(".zstd")) {
      this.queued.add(key);
      ingestStrataZstdFile(key, this.store, mtime, isLive)
        .catch(() => {})
        .finally(() => {
          this.queued.delete(key);
        });
      return;
    }

    const strataCtx = parseStrataFilePath(key);
    if (strataCtx) {
      this.registerTrackedAndRead(
        {
          filePath: key,
          harness: "strata",
          offset: 0,
          remainder: "",
          lastMtimeMs: mtime,
          decoder: new StringDecoder("utf8"),
          strataCtx,
        },
        isLive,
        maxBytesToRead
      );
    }
  }

  private pollActiveFiles(): void {
    const hotCutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const tf of this.tracked.values()) {
      if (tf.coldHydrating || tf.lastMtimeMs < hotCutoff) continue;
      this.readAppendedBytes(tf, true);
    }
  }

  private readAppendedBytes(
    tf: TrackedFile,
    isLive: boolean,
    maxBytesToRead?: number
  ): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(tf.filePath);
    } catch {
      return false;
    }

    if (stat.size < tf.offset) {
      tf.offset = 0;
      tf.remainder = "";
      tf.decoder = new StringDecoder("utf8");
    }
    if (stat.size === tf.offset) {
      tf.lastMtimeMs = stat.mtimeMs;
      return false;
    }

    tf.lastMtimeMs = stat.mtimeMs;
    const targetEnd =
      maxBytesToRead !== undefined && maxBytesToRead > 0
        ? Math.min(stat.size, tf.offset + maxBytesToRead)
        : stat.size;

    let fd: number | null = null;
    try {
      fd = fs.openSync(tf.filePath, "r");
      const buf = this.readBuf;
      let pos = tf.offset;

      while (pos < targetEnd) {
        const toRead = Math.min(CHUNK_SIZE, targetEnd - pos);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;

        const decoded = tf.decoder.write(buf.subarray(0, bytesRead));
        const chunkStr = tf.remainder + decoded;
        const lines = chunkStr.split("\n");
        tf.remainder = lines.pop() ?? "";

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          this.dispatchLine(tf, line, stat.mtimeMs, isLive);
        }
      }

      tf.offset = pos;
      return pos < stat.size;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }

  private dispatchLine(
    tf: TrackedFile,
    line: string,
    fallbackTs: number,
    isLive: boolean
  ): void {
    if (tf.claudeCtx) {
      ingestClaudeLine(tf.claudeCtx, line, this.store, fallbackTs, isLive);
    } else if (tf.codexCtx) {
      ingestCodexLine(tf.codexCtx, line, this.store, fallbackTs, isLive);
    } else if (tf.agyCtx) {
      ingestAntigravityLine(tf.agyCtx, line, this.store, fallbackTs, isLive);
    } else if (tf.strataCtx) {
      ingestStrataLine(tf.strataCtx, line, this.store, fallbackTs, isLive);
    }
  }
}

function safeMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

async function safeMtimeAsync(filePath: string): Promise<number> {
  try {
    const st = await fs.promises.stat(filePath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}
