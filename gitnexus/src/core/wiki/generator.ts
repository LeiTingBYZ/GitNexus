/**
 * Wiki Generator
 *
 * Orchestrates the full wiki generation pipeline:
 *   Phase 0: Validate prerequisites + gather graph structure
 *   Phase 1: Build module tree (one LLM call)
 *   Phase 2: Generate module pages (one LLM call per module, bottom-up)
 *   Phase 3: Generate overview page
 *
 * Supports incremental updates via git diff + module-file mapping.
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

import {
  initWikiDb,
  closeWikiDb,
  touchWikiDb,
  getFilesWithExports,
  getAllFiles,
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
  getAllProcesses,
  getInterModuleEdgesForOverview,
  type FileWithExports,
} from './graph-queries.js';
import { generateHTMLViewer } from './html-viewer.js';

import {
  callLLM,
  estimateTokens,
  type LLMConfig,
  type CallLLMOptions,
  type LLMResponse,
} from './llm-client.js';

import { callCursorLLM, resolveCursorConfig } from './cursor-client.js';

import {
  GROUPING_SYSTEM_PROMPT,
  GROUPING_USER_PROMPT,
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  fillTemplate,
  formatFileListForGrouping,
  formatDirectoryTree,
  formatCallEdges,
  formatProcesses,
} from './prompts.js';

import { shouldIgnorePath } from '../../config/ignore-service.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface WikiOptions {
  force?: boolean;
  maxTokensPerModule?: number;
  concurrency?: number;
  /** If true, stop after building module tree for user review */
  reviewOnly?: boolean;
}

export interface WikiMeta {
  fromCommit: string;
  generatedAt: string;
  model: string;
  moduleFiles: Record<string, string[]>;
  moduleTree: ModuleTreeNode[];
}

export interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

export type ProgressCallback = (phase: string, percent: number, detail?: string) => void;

export interface WikiRunResult {
  pagesGenerated: number;
  mode: 'full' | 'incremental' | 'up-to-date';
  failedModules: string[];
  moduleTree?: ModuleTreeNode[];
}

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_PER_MODULE = 30_000;
const WIKI_DIR = 'wiki';

/**
 * Clean LLM response content by removing reasoning/thinking tags.
 * Handles both <thinking>...</thinking> and similar patterns that MiniMax models use.
 */
function cleanLLMContent(content: string): string {
  // Remove <think...>...</think...> tags (handles <thinking>, <think>, etc.)
  let cleaned = content.replace(/<think[\s\S]*?>[\s\S]*?<\/think[\s\S]*?>/gi, '');

  // Also remove content between Chinese full-width brackets if present
  cleaned = cleaned.replace(/【 thinking 】[\s\S]*?【\/ thinking 】/gi, '');

  // Remove any leading/trailing whitespace and multiple blank lines
  cleaned = cleaned.replace(/^\s*\n\s*\n/, '\n').trim();

  return cleaned;
}

// ─── Generator Class ──────────────────────────────────────────────────

export class WikiGenerator {
  private repoPath: string;
  private storagePath: string;
  private wikiDir: string;
  private lbugPath: string;
  private llmConfig: LLMConfig;
  private maxTokensPerModule: number;
  private concurrency: number;
  private options: WikiOptions;
  private onProgress: ProgressCallback;
  private failedModules: string[] = [];
  private requiredModules: Array<{ name: string; paths?: string[] }> = [];

  constructor(
    repoPath: string,
    storagePath: string,
    lbugPath: string,
    llmConfig: LLMConfig,
    options: WikiOptions = {},
    onProgress?: ProgressCallback,
  ) {
    this.repoPath = repoPath;
    this.storagePath = storagePath;
    this.wikiDir = path.join(storagePath, WIKI_DIR);
    this.lbugPath = lbugPath;
    this.options = options;
    this.llmConfig = llmConfig;
    this.maxTokensPerModule = options.maxTokensPerModule ?? DEFAULT_MAX_TOKENS_PER_MODULE;
    this.concurrency = options.concurrency ?? 3;
    const progressFn = onProgress || (() => {});
    this.onProgress = (phase, percent, detail) => {
      if (percent > 0) this.lastPercent = percent;
      progressFn(phase, percent, detail);
    };
  }

  private lastPercent = 0;

  /**
   * Create streaming options that report LLM progress to the progress bar.
   *
   * Progress calculation:
   * - If fixedPercent is provided, we show incremental progress within that phase
   *   based on token generation (e.g., grouping at 15% → 15-28%)
   * - If fixedPercent is NOT provided, we only update the label with token count
   *   but keep the current percentage (avoids fluctuation during module generation)
   *
   * Also touches the DB connection periodically to prevent idle timeout.
   */
  private streamOpts(label: string, fixedPercent?: number, percentRange = 10): CallLLMOptions {
    const hasFixedStart = fixedPercent !== undefined;
    const startPercent = fixedPercent ?? this.lastPercent;
    const expectedTokens = 2000;
    let lastTouch = Date.now();

    return {
      onChunk: (chars: number) => {
        const tokens = Math.round(chars / 4);

        if (hasFixedStart) {
          // For fixed phases (like grouping), show incremental progress
          const progress = Math.min(1, tokens / expectedTokens);
          const pct = Math.round(startPercent + progress * percentRange);
          this.onProgress('stream', pct, `${label} (${tokens} tok)`);
        } else {
          // For module generation, only update the label, keep current percent
          this.onProgress('stream', this.lastPercent, `${label} (${tokens} tok)`);
        }

        // Touch DB every 60s to prevent idle timeout during long LLM calls
        const now = Date.now();
        if (now - lastTouch > 60_000) {
          touchWikiDb();
          lastTouch = now;
        }
      },
    };
  }

  /**
   * Route LLM call to the appropriate provider (OpenAI-compatible or Cursor CLI).
   */
  private async invokeLLM(
    prompt: string,
    systemPrompt: string,
    options?: CallLLMOptions,
  ): Promise<LLMResponse> {
    if (this.llmConfig.provider === 'cursor') {
      const cursorConfig = resolveCursorConfig({
        model: this.llmConfig.model,
        workingDirectory: this.repoPath,
      });
      return callCursorLLM(prompt, cursorConfig, systemPrompt, options);
    }
    return callLLM(prompt, this.llmConfig, systemPrompt, options);
  }

  /**
   * Main entry point. Runs the full pipeline or incremental update.
   */
  async run(): Promise<WikiRunResult> {
    await fs.mkdir(this.wikiDir, { recursive: true });

    const existingMeta = await this.loadWikiMeta();
    const currentCommit = this.getCurrentCommit();
    const forceMode = this.options.force;

    // Up-to-date check (skip if --force)
    if (!forceMode && existingMeta && existingMeta.fromCommit === currentCommit) {
      // Still regenerate the HTML viewer in case it's missing
      await this.ensureHTMLViewer();
      return { pagesGenerated: 0, mode: 'up-to-date', failedModules: [] };
    }

    // Force mode: delete snapshot to force full re-grouping
    if (forceMode) {
      try {
        await fs.unlink(path.join(this.wikiDir, 'first_module_tree.json'));
      } catch {}
      // Delete existing module pages so they get regenerated
      const existingFiles = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
      for (const f of existingFiles) {
        if (f.endsWith('.md')) {
          try {
            await fs.unlink(path.join(this.wikiDir, f));
          } catch {}
        }
      }
    }

    // Init graph
    this.onProgress('init', 2, 'Connecting to knowledge graph...');
    await initWikiDb(this.lbugPath);

    let result: WikiRunResult;
    try {
      if (!forceMode && existingMeta && existingMeta.fromCommit) {
        result = await this.incrementalUpdate(existingMeta, currentCommit);
      } else {
        result = await this.fullGeneration(currentCommit);
      }
    } finally {
      await closeWikiDb();
    }

    // Always generate the HTML viewer after wiki content changes
    await this.ensureHTMLViewer();

    return result;
  }

  // ─── HTML Viewer ─────────────────────────────────────────────────────

  private async ensureHTMLViewer(): Promise<void> {
    // Only generate if there are markdown pages to bundle
    const dirEntries = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
    const hasMd = dirEntries.some((f) => f.endsWith('.md'));
    if (!hasMd) return;

    this.onProgress('html', 98, 'Building HTML viewer...');
    const repoName = path.basename(this.repoPath);
    await generateHTMLViewer(this.wikiDir, repoName);
  }

  // ─── Full Generation ────────────────────────────────────────────────

  private async fullGeneration(currentCommit: string): Promise<WikiRunResult> {
    let pagesGenerated = 0;

    // Phase 0: Gather structure
    this.onProgress('gather', 5, 'Querying graph for file structure...');
    const filesWithExports = await getFilesWithExports();
    const allFiles = await getAllFiles();

    // Filter to source files only
    const sourceFiles = allFiles.filter((f) => !shouldIgnorePath(f));

    // Load RepoIgnoreFiles and RequiredModules from .gitnexus/meta.json
    let repoIgnorePatterns: string[] = [];
    let requiredModules: Array<{ name: string; paths?: string[] }> = [];
    try {
      const metaPath = path.join(this.repoPath, '.gitnexus', 'meta.json');
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);
      repoIgnorePatterns = meta.RepoIgnoreFiles || [];
      requiredModules = meta.RequiredModules || [];

      if (repoIgnorePatterns.length > 0) {
        this.onProgress('gather', 6, `Filtering ${repoIgnorePatterns.length} ignore patterns...`);
        const beforeCount = sourceFiles.length;
        const filteredFiles = sourceFiles.filter((f) => {
          for (const pattern of repoIgnorePatterns) {
            try {
              const regex = new RegExp(pattern);
              if (regex.test(f)) {
                return false;
              }
            } catch {
              // Invalid regex, skip
            }
          }
          return true;
        });
        sourceFiles.length = 0;
        sourceFiles.push(...filteredFiles);
      }
    } catch {
      // No meta.json or no fields, ignore
    }

    // Store for later use
    this.requiredModules = requiredModules;

    if (sourceFiles.length === 0) {
      throw new Error('No source files found in the knowledge graph. Nothing to document.');
    }

    // Build enriched file list (merge exports into all source files)
    const exportMap = new Map(filesWithExports.map((f) => [f.filePath, f]));
    const enrichedFiles: FileWithExports[] = sourceFiles.map((fp) => {
      return exportMap.get(fp) || { filePath: fp, symbols: [] };
    });

    this.onProgress('gather', 10, `Found ${sourceFiles.length} source files`);

    // Phase 1: Build module tree
    let moduleTree = await this.buildModuleTree(enrichedFiles);

    // Phase 1.5: Add required modules if specified
    if (this.requiredModules.length > 0) {
      moduleTree = this.ensureRequiredModules(moduleTree, enrichedFiles);
    }

    pagesGenerated = 0;

    // If reviewOnly mode, save tree and stop for user to review/edit
    if (this.options.reviewOnly) {
      await this.saveModuleTree(moduleTree);
      this.onProgress('review', 30, 'Module tree ready for review');
      const reviewResult: WikiRunResult = {
        pagesGenerated: 0,
        mode: 'full',
        failedModules: [],
        moduleTree,
      };
      return reviewResult;
    }

    // Phase 2: Generate module pages (parallel with concurrency limit)
    const totalModules = this.countModules(moduleTree);
    let modulesProcessed = 0;

    const reportProgress = (moduleName?: string) => {
      modulesProcessed++;
      const percent = 30 + Math.round((modulesProcessed / totalModules) * 55);
      const detail = moduleName
        ? `${modulesProcessed}/${totalModules} — ${moduleName}`
        : `${modulesProcessed}/${totalModules} modules`;
      this.onProgress('modules', percent, detail);
    };

    // Flatten tree into layers: leaves first, then parents
    // Leaves can run in parallel; parents must wait for their children
    const { leaves, parents } = this.flattenModuleTree(moduleTree);

    // Re-init DB connection before processing (may have been evicted by LRU)
    await initWikiDb(this.lbugPath);

    // Process all leaf modules in parallel
    pagesGenerated += await this.runParallel(leaves, async (node) => {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        return 0;
      }
      try {
        await this.generateLeafPage(node);
        reportProgress(node.name);
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        console.error(`[ERROR] Failed leaf module "${node.name}":`, err.message);
        reportProgress(`Failed: ${node.name}`);
        return 0;
      }
    });

    // Re-init DB before parent modules (may have been idle during leaf processing)
    touchWikiDb();

    // Process parent modules sequentially (they depend on child docs)
    for (const node of parents) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        continue;
      }
      try {
        await this.generateParentPage(node);
        pagesGenerated++;
        reportProgress(node.name);
      } catch (err: any) {
        this.failedModules.push(node.name);
        console.error(`[ERROR] Failed parent module "${node.name}":`, err.message);
        reportProgress(`Failed: ${node.name}`);
      }
    }

    // Phase 3: Generate overview
    this.onProgress('overview', 88, 'Generating overview page...');
    await this.generateOverview(moduleTree);
    pagesGenerated++;

    // Save metadata
    this.onProgress('finalize', 95, 'Saving metadata...');
    const moduleFiles = this.extractModuleFiles(moduleTree);
    await this.saveModuleTree(moduleTree);
    await this.saveWikiMeta({
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      moduleFiles,
      moduleTree,
    });

    this.onProgress('done', 100, 'Wiki generation complete');
    return { pagesGenerated, mode: 'full', failedModules: [...this.failedModules] };
  }

  // ─── Phase 1: Build Module Tree ────────────────────────────────────

  private async buildModuleTree(files: FileWithExports[]): Promise<ModuleTreeNode[]> {
    // First, check for user-edited module_tree.json (from --review workflow)
    const editablePath = path.join(this.wikiDir, 'module_tree.json');
    try {
      const edited = await fs.readFile(editablePath, 'utf-8');
      const parsed = JSON.parse(edited);
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.onProgress('grouping', 25, 'Using edited module tree');
        return parsed;
      }
    } catch {
      // No edited tree, check for original snapshot
    }

    // Check for existing immutable snapshot (resumability)
    const snapshotPath = path.join(this.wikiDir, 'first_module_tree.json');
    try {
      const existing = await fs.readFile(snapshotPath, 'utf-8');
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.onProgress('grouping', 25, 'Using existing module tree (resuming)');
        return parsed;
      }
    } catch {
      // No snapshot, generate new
    }

    this.onProgress('grouping', 15, 'Grouping files into modules (LLM)...');

    // Get file sizes directly from filesystem to batch by cumulative size
    // Target ~2MB of source code per batch for larger, more cohesive modules
    const TARGET_BATCH_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
    const sizeMap = new Map<string, number>();

    // Fetch file sizes in parallel (limit concurrency to avoid overwhelming the filesystem)
    const fetchSize = async (filePath: string): Promise<[string, number]> => {
      try {
        const stats = await fs.stat(path.join(this.repoPath, filePath));
        return [filePath, stats.size];
      } catch {
        return [filePath, 1024]; // Default 1KB if can't stat
      }
    };

    const sizeResults = await Promise.all(files.map((f) => fetchSize(f.filePath)));
    for (const [fp, size] of sizeResults) {
      sizeMap.set(fp, size);
    }

    // Add size to each file
    const filesWithSize = files.map((f) => ({
      ...f,
      size: sizeMap.get(f.filePath) || 1024,
    }));

    // Build batches by cumulative size
    type FileWithSize = FileWithExports & { size: number };
    const batches: FileWithSize[][] = [];
    let currentBatch: FileWithSize[] = [];
    let currentSize = 0;

    for (const file of filesWithSize) {
      // If adding this file would exceed the limit and batch is not empty, start new batch
      if (currentSize + file.size > TARGET_BATCH_SIZE_BYTES && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentSize = 0;
      }
      currentBatch.push(file);
      currentSize += file.size;
    }
    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    const allGroupings: Record<string, string[]> = {};
    const totalBatches = batches.length;

    // Track last DB touch time to prevent timeout during long batch processing
    let lastDbTouch = Date.now();
    const DB_TOUCH_INTERVAL = 60_000;

    // Process each batch
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchFiles = batches[batchIdx];
      const batchTotalSize = batchFiles.reduce((sum, f) => sum + f.size, 0);

      const fileList = formatFileListForGrouping(batchFiles);
      const dirTree = formatDirectoryTree(batchFiles.map((f) => f.filePath));

      this.onProgress(
        'grouping',
        15 + Math.floor(((batchIdx + 1) / totalBatches) * 10),
        `Grouping files (batch ${batchIdx + 1}/${totalBatches}, ${batchFiles.length} files, ${Math.round(batchTotalSize / 1024)}KB)...`,
      );

      const prompt = fillTemplate(GROUPING_USER_PROMPT, {
        FILE_LIST: fileList,
        DIRECTORY_TREE: dirTree,
      });

      // For grouping, use a silent stream that doesn't update the progress bar
      // to keep the overall batch progress clean
      let response;
      try {
        response = await this.invokeLLM(
          prompt,
          GROUPING_SYSTEM_PROMPT,
          undefined, // No streaming for grouping to avoid progress bar flickering
        );
      } catch (err: any) {
        console.error(`[ERROR] Batch ${batchIdx + 1}/${totalBatches} failed:`);
        console.error(
          `  - Files: ${batchFiles.length}, Size: ${Math.round(batchTotalSize / 1024)}KB`,
        );
        console.error(`  - First file: ${batchFiles[0]?.filePath}`);
        console.error(`  - Last file: ${batchFiles[batchFiles.length - 1]?.filePath}`);
        console.error(`  - Error: ${err.message || err}`);
        throw err;
      }

      // Touch DB every 60s to prevent idle timeout during long batch processing
      const now = Date.now();
      if (now - lastDbTouch > DB_TOUCH_INTERVAL) {
        touchWikiDb();
        lastDbTouch = now;
      }
      const batchGrouping = this.parseGroupingResponse(response.content, batchFiles);

      // Merge batch grouping into overall result
      for (const [moduleName, modulePaths] of Object.entries(batchGrouping)) {
        if (!allGroupings[moduleName]) {
          allGroupings[moduleName] = [];
        }
        allGroupings[moduleName].push(...modulePaths);
      }
    }

    const grouping = allGroupings;

    // Fallback: Check for unassigned files and add by top-level directory
    const assignedFiles = new Set<string>();
    for (const paths of Object.values(grouping)) {
      for (const p of paths) {
        assignedFiles.add(p);
      }
    }

    const unassignedFiles = files.filter((f) => !assignedFiles.has(f.filePath));
    if (unassignedFiles.length > 0) {
      this.onProgress(
        'grouping',
        25,
        `LLM missed ${unassignedFiles.length} files, adding by directory...`,
      );

      // Group unassigned files by top-level directory
      const dirGroups: Record<string, string[]> = {};
      for (const file of unassignedFiles) {
        const parts = file.filePath.replace(/\\/g, '/').split('/');
        const topDir = parts[0] || 'root';
        if (!dirGroups[topDir]) {
          dirGroups[topDir] = [];
        }
        dirGroups[topDir].push(file.filePath);
      }

      // Merge into grouping
      for (const [dir, paths] of Object.entries(dirGroups)) {
        const moduleName = `Other (${dir})`;
        if (!grouping[moduleName]) {
          grouping[moduleName] = [];
        }
        grouping[moduleName].push(...paths);
      }
    }

    // Convert to tree nodes
    const tree: ModuleTreeNode[] = [];
    for (const [moduleName, modulePaths] of Object.entries(grouping)) {
      const slug = this.slugify(moduleName);
      const node: ModuleTreeNode = { name: moduleName, slug, files: modulePaths };

      // Token budget check — split if too large
      const totalTokens = await this.estimateModuleTokens(modulePaths);
      if (totalTokens > this.maxTokensPerModule && modulePaths.length > 3) {
        const children = this.splitBySubdirectory(moduleName, modulePaths);
        // Only create hierarchy if we actually got multiple children
        // If splitting results in 1 child, keep files flat (avoid redundant nesting)
        if (children.length > 1) {
          node.children = children;
          node.files = []; // Parent doesn't own files directly when split
        }
        // If only 1 child, keep original flat structure (files stay in node.files)
      }

      tree.push(node);
    }

    // Fallback: If too few modules (less than 1/5 of files), split large modules by directory
    const MIN_MODULES_RATIO = 5; // At least 1 module per 5 files
    if (tree.length < files.length / MIN_MODULES_RATIO && files.length > 50) {
      this.onProgress(
        'grouping',
        27,
        `Only ${tree.length} modules for ${files.length} files, splitting by directory...`,
      );

      // Step 1: Split modules with >10 files into subdirectories
      let splitTree: ModuleTreeNode[] = [];
      for (const node of tree) {
        touchWikiDb();
        if (node.files.length > 10) {
          const subdirs = this.splitBySubdirectory(node.name, node.files);
          if (subdirs.length > 1) {
            splitTree.push({
              name: node.name,
              slug: node.slug,
              files: [],
              children: subdirs,
            });
            continue;
          }
        }
        splitTree.push(node);
      }

      // Step 2: Loop to split any children with >500 files (max 3 iterations)
      for (let iter = 0; iter < 3; iter++) {
        touchWikiDb();
        let hasLargeChild = false;
        const afterSplit: ModuleTreeNode[] = [];

        for (const node of splitTree) {
          if (node.children && node.children.length > 0) {
            const newChildren: ModuleTreeNode[] = [];
            for (const child of node.children) {
              if (child.files.length > 500) {
                const subdirs = this.splitBySubdirectory(child.name, child.files);
                if (subdirs.length > 1) {
                  hasLargeChild = true;
                  newChildren.push(...subdirs);
                } else {
                  newChildren.push(child);
                }
              } else {
                newChildren.push(child);
              }
            }
            afterSplit.push({ ...node, children: newChildren });
          } else {
            afterSplit.push(node);
          }
        }

        if (!hasLargeChild) break;
        splitTree = afterSplit;
      }

      if (splitTree.length > tree.length) {
        tree.length = 0;
        tree.push(...splitTree);
      }
    }

    // Save immutable snapshot for resumability
    await fs.writeFile(snapshotPath, JSON.stringify(tree, null, 2), 'utf-8');
    this.onProgress('grouping', 28, `Created ${tree.length} modules`);

    return tree;
  }

  /**
   * Parse LLM grouping response. Validates all files are assigned.
   */
  private parseGroupingResponse(
    content: string,
    files: FileWithExports[],
  ): Record<string, string[]> {
    // Extract JSON from response (handle markdown fences)
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    let parsed: Record<string, string[]>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Fallback: group by top-level directory
      return this.fallbackGrouping(files);
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.fallbackGrouping(files);
    }

    // Validate — ensure all files are assigned
    const allFilePaths = new Set(files.map((f) => f.filePath));
    const assignedFiles = new Set<string>();
    const validGrouping: Record<string, string[]> = {};

    for (const [mod, paths] of Object.entries(parsed)) {
      if (!Array.isArray(paths)) continue;
      const validPaths = paths.filter((p) => {
        if (allFilePaths.has(p) && !assignedFiles.has(p)) {
          assignedFiles.add(p);
          return true;
        }
        return false;
      });
      if (validPaths.length > 0) {
        validGrouping[mod] = validPaths;
      }
    }

    // Assign unassigned files to a "Miscellaneous" module
    const unassigned = files.map((f) => f.filePath).filter((fp) => !assignedFiles.has(fp));
    if (unassigned.length > 0) {
      validGrouping['Other'] = unassigned;
    }

    return Object.keys(validGrouping).length > 0 ? validGrouping : this.fallbackGrouping(files);
  }

  /**
   * Fallback grouping by top-level directory when LLM parsing fails.
   */
  private fallbackGrouping(files: FileWithExports[]): Record<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.filePath.replace(/\\/g, '/').split('/');
      const topDir = parts.length > 1 ? parts[0] : 'Root';
      let group = groups.get(topDir);
      if (!group) {
        group = [];
        groups.set(topDir, group);
      }
      group.push(f.filePath);
    }
    return Object.fromEntries(groups);
  }

  /**
   * Group files by top-level directory to preserve directory context.
   * Files without a clear top-level directory go into "root" group.
   */
  private groupByTopLevelDirectory(files: FileWithExports[]): Record<string, FileWithExports[]> {
    const groups: Record<string, FileWithExports[]> = {};

    for (const file of files) {
      const parts = file.filePath.replace(/\\/g, '/').split('/');
      // Top-level is the first directory (e.g., "packages", "src", "tools")
      // or "root" for files in the repo root
      let topLevel = parts.length > 1 ? parts[0] : 'root';

      // Normalize common variations
      if (topLevel === 'packages' && parts.length > 2) {
        // For monorepos, use second level as top-level (e.g., "packages/featurepack")
        topLevel = parts.slice(0, 2).join('/');
      }

      if (!groups[topLevel]) {
        groups[topLevel] = [];
      }
      groups[topLevel].push(file);
    }

    return groups;
  }

  /**
   * Ensure required modules exist in the tree, create if missing.
   */
  private ensureRequiredModules(
    tree: ModuleTreeNode[],
    allFiles: FileWithExports[],
  ): ModuleTreeNode[] {
    const newTree = [...tree];

    for (const required of this.requiredModules) {
      // Touch DB to prevent timeout
      touchWikiDb();

      const moduleName = required.name;
      const slug = this.slugify(moduleName);

      // Check if module already exists
      const exists = newTree.some(
        (n) => n.slug === slug || n.name.toLowerCase().includes(moduleName.toLowerCase()),
      );

      if (exists) {
        continue;
      }

      // Find matching files
      const matchedFiles: string[] = [];

      if (required.paths && required.paths.length > 0) {
        // Use specified paths
        for (const pattern of required.paths) {
          const regex = new RegExp(pattern);
          for (const file of allFiles) {
            if (regex.test(file.filePath) && !matchedFiles.includes(file.filePath)) {
              matchedFiles.push(file.filePath);
            }
          }
        }
      } else {
        // Auto-detect: search for files containing the module name
        const keyword = moduleName.toLowerCase();
        for (const file of allFiles) {
          if (file.filePath.toLowerCase().includes(keyword)) {
            matchedFiles.push(file.filePath);
          }
        }
      }

      // Create module if we found matching files
      if (matchedFiles.length > 0) {
        newTree.push({
          name: moduleName,
          slug,
          files: matchedFiles,
        });
      }
    }

    return newTree;
  }

  /**
   * Split a large module into sub-modules by subdirectory.
   * Uses the full subDir path for naming to avoid slug collisions
   * (e.g., "synapse-screen/src" vs "synapse-core/src").
   */
  private splitBySubdirectory(moduleName: string, files: string[]): ModuleTreeNode[] {
    const subGroups = new Map<string, string[]>();
    for (const fp of files) {
      const parts = fp.replace(/\\/g, '/').split('/');
      const subDir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      let group = subGroups.get(subDir);
      if (!group) {
        group = [];
        subGroups.set(subDir, group);
      }
      group.push(fp);
    }

    // Check if basenames are unique; if not, use the full subDir path
    const basenames = Array.from(subGroups.keys()).map((s) => path.basename(s));
    const hasCollisions = new Set(basenames).size < basenames.length;

    return Array.from(subGroups.entries()).map(([subDir, subFiles]) => {
      const label = hasCollisions ? subDir.replace(/\//g, '-') : path.basename(subDir);
      return {
        name: `${moduleName} — ${label}`,
        slug: this.slugify(`${moduleName}-${label}`),
        files: subFiles,
      };
    });
  }

  // ─── Phase 2: Generate Module Pages ─────────────────────────────────

  /**
   * Generate a leaf module page from source code + graph data.
   */
  private async generateLeafPage(node: ModuleTreeNode): Promise<void> {
    const filePaths = node.files;

    // Read source files from disk
    const sourceCode = await this.readSourceFiles(filePaths);

    // Token budget check — if too large, summarize in batches
    const totalTokens = estimateTokens(sourceCode);
    let finalSourceCode = sourceCode;
    if (totalTokens > this.maxTokensPerModule) {
      finalSourceCode = this.truncateSource(sourceCode, this.maxTokensPerModule);
    }

    // Get graph data - touch DB before to prevent timeout
    touchWikiDb();
    const [intraCalls, interCalls, processes] = await Promise.all([
      getIntraModuleCallEdges(filePaths),
      getInterModuleCallEdges(filePaths),
      getProcessesForFiles(filePaths, 5),
    ]);

    const prompt = fillTemplate(MODULE_USER_PROMPT, {
      MODULE_NAME: node.name,
      SOURCE_CODE: finalSourceCode,
      INTRA_CALLS: formatCallEdges(intraCalls),
      OUTGOING_CALLS: formatCallEdges(interCalls.outgoing),
      INCOMING_CALLS: formatCallEdges(interCalls.incoming),
      PROCESSES: formatProcesses(processes),
    });

    const response = await this.invokeLLM(prompt, MODULE_SYSTEM_PROMPT, this.streamOpts(node.name));

    // Clean the content and write page
    const cleanedContent = cleanLLMContent(response.content);
    const pageContent = `# ${node.name}\n\n${cleanedContent}`;
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  /**
   * Generate a parent module page from children's documentation.
   */
  private async generateParentPage(node: ModuleTreeNode): Promise<void> {
    if (!node.children || node.children.length === 0) return;

    // Read children's overview sections
    const childDocs: string[] = [];
    for (const child of node.children) {
      const childPage = path.join(this.wikiDir, `${child.slug}.md`);
      try {
        const content = await fs.readFile(childPage, 'utf-8');
        // Extract overview section (first ~500 chars or up to "### Architecture")
        const overviewEnd = content.indexOf('### Architecture');
        const overview =
          overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 800).trim();
        childDocs.push(`#### ${child.name}\n${overview}`);
      } catch {
        childDocs.push(`#### ${child.name}\n(Documentation not yet generated)`);
      }
    }

    // Get cross-child call edges
    const allChildFiles = node.children.flatMap((c) => c.files);
    const crossCalls = await getIntraModuleCallEdges(allChildFiles);
    const processes = await getProcessesForFiles(allChildFiles, 3);

    const prompt = fillTemplate(PARENT_USER_PROMPT, {
      MODULE_NAME: node.name,
      CHILDREN_DOCS: childDocs.join('\n\n'),
      CROSS_MODULE_CALLS: formatCallEdges(crossCalls),
      CROSS_PROCESSES: formatProcesses(processes),
    });

    const response = await this.invokeLLM(prompt, PARENT_SYSTEM_PROMPT, this.streamOpts(node.name));

    const cleanedContent = cleanLLMContent(response.content);
    const pageContent = `# ${node.name}\n\n${cleanedContent}`;
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  // ─── Phase 3: Generate Overview ─────────────────────────────────────

  private async generateOverview(moduleTree: ModuleTreeNode[]): Promise<void> {
    // Touch DB before starting to prevent timeout
    touchWikiDb();

    // Read module overview sections
    const moduleSummaries: string[] = [];
    for (const node of moduleTree) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      try {
        const content = await fs.readFile(pagePath, 'utf-8');
        const overviewEnd = content.indexOf('### Architecture');
        const overview =
          overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 600).trim();
        moduleSummaries.push(`#### ${node.name}\n${overview}`);
      } catch {
        moduleSummaries.push(`#### ${node.name}\n(Documentation pending)`);
      }
    }

    // Get inter-module edges for architecture diagram
    touchWikiDb();
    const moduleFiles = this.extractModuleFiles(moduleTree);
    const moduleEdges = await getInterModuleEdgesForOverview(moduleFiles);

    // Get top processes for key workflows
    touchWikiDb();
    const topProcesses = await getAllProcesses(5);

    // Read project config
    const projectInfo = await this.readProjectInfo();

    const edgesText =
      moduleEdges.length > 0
        ? moduleEdges.map((e) => `${e.from} → ${e.to} (${e.count} calls)`).join('\n')
        : 'No inter-module call edges detected';

    const prompt = fillTemplate(OVERVIEW_USER_PROMPT, {
      PROJECT_INFO: projectInfo,
      MODULE_SUMMARIES: moduleSummaries.join('\n\n'),
      MODULE_EDGES: edgesText,
      TOP_PROCESSES: formatProcesses(topProcesses),
    });

    const response = await this.invokeLLM(
      prompt,
      OVERVIEW_SYSTEM_PROMPT,
      this.streamOpts('Generating overview', 88),
    );

    const cleanedContent = cleanLLMContent(response.content);
    const pageContent = `# ${path.basename(this.repoPath)} — Wiki\n\n${cleanedContent}`;
    await fs.writeFile(path.join(this.wikiDir, 'overview.md'), pageContent, 'utf-8');
  }

  // ─── Incremental Updates ────────────────────────────────────────────

  private async incrementalUpdate(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<WikiRunResult> {
    this.onProgress('incremental', 5, 'Detecting changes...');

    // Get changed files since last generation
    const changedFiles = this.getChangedFiles(existingMeta.fromCommit, currentCommit);

    // If null, commits are on divergent branches (e.g., wiki generated on feature branch,
    // now running on main). Fall back to full generation.
    if (changedFiles === null) {
      this.onProgress('incremental', 10, 'Branch diverged, running full generation...');
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    if (changedFiles.length === 0) {
      // No file changes but commit differs (e.g. merge commit)
      await this.saveWikiMeta({
        ...existingMeta,
        fromCommit: currentCommit,
        generatedAt: new Date().toISOString(),
      });
      return { pagesGenerated: 0, mode: 'incremental', failedModules: [] };
    }

    this.onProgress('incremental', 10, `${changedFiles.length} files changed`);

    // Determine affected modules
    const affectedModules = new Set<string>();
    const newFiles: string[] = [];

    for (const fp of changedFiles) {
      let found = false;
      for (const [mod, files] of Object.entries(existingMeta.moduleFiles)) {
        if (files.includes(fp)) {
          affectedModules.add(mod);
          found = true;
          break;
        }
      }
      if (!found && !shouldIgnorePath(fp)) {
        newFiles.push(fp);
      }
    }

    // If significant new files exist, re-run full grouping
    if (newFiles.length > 5) {
      this.onProgress(
        'incremental',
        15,
        'Significant new files detected, running full generation...',
      );
      // Delete old snapshot to force re-grouping
      try {
        await fs.unlink(path.join(this.wikiDir, 'first_module_tree.json'));
      } catch {}
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    // Add new files to nearest module or "Other"
    if (newFiles.length > 0) {
      if (!existingMeta.moduleFiles['Other']) {
        existingMeta.moduleFiles['Other'] = [];
      }
      existingMeta.moduleFiles['Other'].push(...newFiles);
      affectedModules.add('Other');
    }

    // Regenerate affected module pages (parallel)
    let pagesGenerated = 0;
    const moduleTree = existingMeta.moduleTree;
    const affectedArray = Array.from(affectedModules);

    this.onProgress('incremental', 20, `Regenerating ${affectedArray.length} module(s)...`);

    const affectedNodes: ModuleTreeNode[] = [];
    for (const mod of affectedArray) {
      const modSlug = this.slugify(mod);
      const node = this.findNodeBySlug(moduleTree, modSlug);
      if (node) {
        try {
          await fs.unlink(path.join(this.wikiDir, `${node.slug}.md`));
        } catch {}
        affectedNodes.push(node);
      }
    }

    let incProcessed = 0;
    pagesGenerated += await this.runParallel(affectedNodes, async (node) => {
      try {
        if (node.children && node.children.length > 0) {
          await this.generateParentPage(node);
        } else {
          await this.generateLeafPage(node);
        }
        incProcessed++;
        const percent = 20 + Math.round((incProcessed / affectedNodes.length) * 60);
        this.onProgress(
          'incremental',
          percent,
          `${incProcessed}/${affectedNodes.length} — ${node.name}`,
        );
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        incProcessed++;
        return 0;
      }
    });

    // Regenerate overview if any pages changed
    if (pagesGenerated > 0) {
      this.onProgress('incremental', 85, 'Updating overview...');
      await this.generateOverview(moduleTree);
      pagesGenerated++;
    }

    // Save updated metadata
    this.onProgress('incremental', 95, 'Saving metadata...');
    await this.saveWikiMeta({
      ...existingMeta,
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
    });

    this.onProgress('done', 100, 'Incremental update complete');
    return { pagesGenerated, mode: 'incremental', failedModules: [...this.failedModules] };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getCurrentCommit(): string {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.repoPath }).toString().trim();
    } catch {
      return '';
    }
  }

  /**
   * Check if fromCommit is an ancestor of toCommit (reachable in git history).
   * Returns false if commits are on divergent branches or fromCommit doesn't exist.
   */
  private isCommitReachable(fromCommit: string, toCommit: string): boolean {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fromCommit, toCommit], {
        cwd: this.repoPath,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  private getChangedFiles(fromCommit: string, toCommit: string): string[] | null {
    // First check if fromCommit is reachable from toCommit
    // This handles the case where wiki was generated on a different branch
    if (!this.isCommitReachable(fromCommit, toCommit)) {
      return null; // Signal that we can't compute diff (divergent branches)
    }

    try {
      const output = execFileSync('git', ['diff', `${fromCommit}..${toCommit}`, '--name-only'], {
        cwd: this.repoPath,
      })
        .toString()
        .trim();
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return null; // Treat git errors as needing full regen
    }
  }

  private async readSourceFiles(filePaths: string[]): Promise<string> {
    const parts: string[] = [];
    for (const fp of filePaths) {
      const fullPath = path.join(this.repoPath, fp);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        parts.push(`\n--- ${fp} ---\n${content}`);
      } catch {
        parts.push(`\n--- ${fp} ---\n(file not readable)`);
      }
    }
    return parts.join('\n');
  }

  private truncateSource(source: string, maxTokens: number): string {
    // Rough truncation: keep first maxTokens*4 chars and add notice
    const maxChars = maxTokens * 4;
    if (source.length <= maxChars) return source;
    return source.slice(0, maxChars) + '\n\n... (source truncated for context window limits)';
  }

  private async estimateModuleTokens(filePaths: string[]): Promise<number> {
    let total = 0;
    for (const fp of filePaths) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, fp), 'utf-8');
        total += estimateTokens(content);
      } catch {
        // File not readable, skip
      }
    }
    return total;
  }

  private async readProjectInfo(): Promise<string> {
    const candidates = [
      'package.json',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
    ];
    const lines: string[] = [`Project: ${path.basename(this.repoPath)}`];

    for (const file of candidates) {
      const fullPath = path.join(this.repoPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (file === 'package.json') {
          const pkg = JSON.parse(content);
          if (pkg.name) lines.push(`Name: ${pkg.name}`);
          if (pkg.description) lines.push(`Description: ${pkg.description}`);
          if (pkg.scripts) lines.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
        } else {
          // Include first 500 chars of other config files
          lines.push(`\n${file}:\n${content.slice(0, 500)}`);
        }
        break; // Use first config found
      } catch {
        continue;
      }
    }

    // Read README excerpt
    for (const readme of ['README.md', 'readme.md', 'README.txt']) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, readme), 'utf-8');
        lines.push(`\nREADME excerpt:\n${content.slice(0, 1000)}`);
        break;
      } catch {
        continue;
      }
    }

    return lines.join('\n');
  }

  private extractModuleFiles(tree: ModuleTreeNode[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        result[node.name] = node.children.flatMap((c) => c.files);
        for (const child of node.children) {
          result[child.name] = child.files;
        }
      } else {
        result[node.name] = node.files;
      }
    }
    return result;
  }

  private countModules(tree: ModuleTreeNode[]): number {
    let count = 0;
    for (const node of tree) {
      count++;
      if (node.children) {
        count += node.children.length;
      }
    }
    return count;
  }

  /**
   * Flatten the module tree into leaf nodes and parent nodes.
   * Leaves can be processed in parallel; parents must wait for children.
   */
  private flattenModuleTree(tree: ModuleTreeNode[]): {
    leaves: ModuleTreeNode[];
    parents: ModuleTreeNode[];
  } {
    const leaves: ModuleTreeNode[] = [];
    const parents: ModuleTreeNode[] = [];

    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          leaves.push(child);
        }
        parents.push(node);
      } else {
        leaves.push(node);
      }
    }

    return { leaves, parents };
  }

  /**
   * Run async tasks in parallel with a concurrency limit and adaptive rate limiting.
   * If a 429 rate limit is hit, concurrency is temporarily reduced.
   */
  private async runParallel<T>(items: T[], fn: (item: T) => Promise<number>): Promise<number> {
    let total = 0;
    let activeConcurrency = this.concurrency;
    let running = 0;
    let idx = 0;

    return new Promise((resolve, reject) => {
      const next = () => {
        while (running < activeConcurrency && idx < items.length) {
          const item = items[idx++];
          running++;

          fn(item)
            .then((count) => {
              total += count;
              running--;
              if (idx >= items.length && running === 0) {
                resolve(total);
              } else {
                next();
              }
            })
            .catch((err) => {
              running--;
              // On rate limit, reduce concurrency temporarily
              if (err.message?.includes('429')) {
                activeConcurrency = Math.max(1, activeConcurrency - 1);
                this.onProgress(
                  'modules',
                  this.lastPercent,
                  `Rate limited — concurrency → ${activeConcurrency}`,
                );
                // Re-queue the item
                idx--;
                setTimeout(next, 5000);
              } else {
                if (idx >= items.length && running === 0) {
                  resolve(total);
                } else {
                  next();
                }
              }
            });
        }
      };

      if (items.length === 0) {
        resolve(0);
      } else {
        next();
      }
    });
  }

  private findNodeBySlug(tree: ModuleTreeNode[], slug: string): ModuleTreeNode | null {
    for (const node of tree) {
      if (node.slug === slug) return node;
      if (node.children) {
        const found = this.findNodeBySlug(node.children, slug);
        if (found) return found;
      }
    }
    return null;
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        // Keep ASCII alphanumerics + Chinese characters (\u4e00-\u9fff)
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
    );
  }

  private async fileExists(fp: string): Promise<boolean> {
    try {
      await fs.access(fp);
      return true;
    } catch {
      return false;
    }
  }

  private async loadWikiMeta(): Promise<WikiMeta | null> {
    try {
      const raw = await fs.readFile(path.join(this.wikiDir, 'meta.json'), 'utf-8');
      return JSON.parse(raw) as WikiMeta;
    } catch {
      return null;
    }
  }

  private async saveWikiMeta(meta: WikiMeta): Promise<void> {
    await fs.writeFile(
      path.join(this.wikiDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  private async saveModuleTree(tree: ModuleTreeNode[]): Promise<void> {
    await fs.writeFile(
      path.join(this.wikiDir, 'module_tree.json'),
      JSON.stringify(tree, null, 2),
      'utf-8',
    );
  }
}
