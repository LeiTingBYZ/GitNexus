/**
 * Function-level Incremental Wiki Update
 *
 * Detects changed functions from git diff, generates documentation for them,
 * and updates the corresponding wiki pages.
 *
 * Workflow:
 * 1. Parse git diff to get changed file + line ranges
 * 2. Use tree-sitter to extract functions with their line ranges
 * 3. Match changed lines to affected functions
 * 4. Generate doc for changed functions via LLM
 * 5. Update existing wiki pages (replace or append function docs)
 */

import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import Parser from 'tree-sitter';

import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { shouldIgnorePath } from '../../config/ignore-service.js';

import { callLLM, type LLMConfig, type LLMResponse } from './llm-client.js';

import { FUNCTION_DOC_SYSTEM_PROMPT, FUNCTION_DOC_USER_PROMPT, fillTemplate } from './prompts.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface ChangedFile {
  filePath: string;
  /** Line ranges that changed (1-indexed) */
  changedRanges: Array<{ start: number; end: number }>;
}

export interface FunctionInfo {
  name: string;
  /** Start line number (1-indexed) */
  startLine: number;
  /** End line number (1-indexed) */
  endLine: number;
  /** Full function signature for reference */
  signature: string;
}

/**
 * Result of updating a wiki page for changed functions.
 */
export interface UpdateResult {
  filePath: string;
  functionsUpdated: number;
  functionsAdded: number;
  errors: string[];
}

// ─── Diff Parser ──────────────────────────────────────────────────────

export interface DiffResult {
  changedFiles: ChangedFile[];
  /** Whether the commits are on divergent branches (not ancestor relationship) */
  isDivergent: boolean;
}

/**
 * Parse git diff to extract changed files and their line ranges.
 * Handles divergent branches by finding the merge base.
 */
export function parseGitDiff(repoPath: string, fromCommit: string, toCommit: string): DiffResult {
  const result: DiffResult = {
    changedFiles: [],
    isDivergent: false,
  };

  if (!fromCommit || !toCommit) {
    return result;
  }

  try {
    // Check if fromCommit is an ancestor of toCommit
    let isAncestor = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fromCommit, toCommit], {
        cwd: repoPath,
        stdio: 'ignore',
      });
      isAncestor = true;
    } catch {
      isAncestor = false;
    }

    if (isAncestor) {
      // Normal case: fromCommit is ancestor of toCommit
      // Use git log to find all commits between fromCommit and toCommit
      const commits = getCommitRange(repoPath, fromCommit, toCommit);
      if (commits.length === 0) {
        return result;
      }
      result.changedFiles = getChangedFilesFromCommits(repoPath, commits);
    } else {
      // Divergent case: fromCommit is not an ancestor of toCommit
      // This can happen when wiki was generated on a feature branch, now on main
      // Find the merge base and diff against that
      result.isDivergent = true;

      const mergeBase = getMergeBase(repoPath, fromCommit, toCommit);
      if (mergeBase) {
        // Get all commits from merge base to current HEAD
        const commits = getCommitRange(repoPath, mergeBase, toCommit);
        if (commits.length > 0) {
          result.changedFiles = getChangedFilesFromCommits(repoPath, commits);
        }
      } else {
        // No common ancestor found, use direct diff between commits
        result.changedFiles = getDirectDiff(repoPath, fromCommit, toCommit);
      }
    }

    return result;
  } catch (err) {
    console.error('[ERROR] parseGitDiff failed:', err);
    return result;
  }
}

/**
 * Get all commits between two commits (excluding fromCommit, including toCommit).
 */
function getCommitRange(repoPath: string, fromCommit: string, toCommit: string): string[] {
  try {
    const output = execFileSync('git', ['log', '--format=%H', `${fromCommit}..${toCommit}`], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).toString();

    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the merge base of two commits.
 */
function getMergeBase(repoPath: string, commit1: string, commit2: string): string | null {
  try {
    const output = execFileSync('git', ['merge-base', commit1, commit2], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).toString();

    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get changed files from a list of individual commits.
 * Each commit contributes its diff, allowing us to track per-commit changes.
 */
function getChangedFilesFromCommits(repoPath: string, commits: string[]): ChangedFile[] {
  const fileChanges = new Map<string, Set<number>>();

  for (const commit of commits) {
    try {
      // Get files changed in this commit
      const output = execFileSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', commit],
        { cwd: repoPath, encoding: 'utf-8' },
      ).toString();

      const files = output.trim().split('\n').filter(Boolean);
      for (const file of files) {
        if (!fileChanges.has(file)) {
          fileChanges.set(file, new Set());
        }
        // Mark that this file was changed (we'll calculate ranges later)
        fileChanges.get(file)!.add(commits.indexOf(commit));
      }
    } catch {
      // Skip this commit
    }
  }

  // Now get the full diff to get line ranges for all changed files
  if (commits.length > 0) {
    // commits are ordered from newest to oldest, so we need oldest..newest for diff
    const oldestCommit = commits[commits.length - 1];
    const newestCommit = commits[0];

    try {
      const diffOutput = execFileSync(
        'git',
        ['diff', '-U10', `${oldestCommit}^..${newestCommit}`, '--'],
        { cwd: repoPath, encoding: 'utf-8' },
      ).toString();

      return parseDiffOutput(diffOutput);
    } catch {
      // Fallback: return files without line ranges
      return Array.from(fileChanges.keys()).map((filePath) => ({
        filePath,
        changedRanges: [{ start: 1, end: 100 }], // Conservative estimate
      }));
    }
  }

  return [];
}

/**
 * Get direct diff between two commits (when no common ancestor exists).
 */
function getDirectDiff(repoPath: string, fromCommit: string, toCommit: string): ChangedFile[] {
  try {
    const output = execFileSync('git', ['diff', '-U10', fromCommit, toCommit, '--'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).toString();

    return parseDiffOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse unified diff output to extract file changes and line ranges.
 */
function parseDiffOutput(diffOutput: string): ChangedFile[] {
  const result: ChangedFile[] = [];
  const lines = diffOutput.split('\n');

  let currentFile: string | null = null;
  let currentRanges: Array<{ start: number; end: number }> = [];

  for (const line of lines) {
    // New file starting
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      // Save previous file
      if (currentFile && currentRanges.length > 0) {
        result.push({ filePath: currentFile, changedRanges: currentRanges });
      }
      currentFile = fileMatch[1];
      currentRanges = [];
      continue;
    }

    // @@ pattern: -X,Y +X,Y @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      // Convert to 1-indexed, add context range
      const newStart = parseInt(hunkMatch[2], 10);
      currentRanges.push({ start: newStart, end: newStart + 10 });
    }
  }

  // Don't forget the last file
  if (currentFile && currentRanges.length > 0) {
    result.push({ filePath: currentFile, changedRanges: currentRanges });
  }

  return result;
}

// ─── Tree-sitter Function Extraction ─────────────────────────────────

/**
 * Extract functions from a source file with their line ranges.
 * Handles large files by parsing in chunks to work around tree-sitter WASM 32KB limit.
 */
export async function extractFunctions(
  filePath: string,
  repoPath: string,
): Promise<FunctionInfo[]> {
  const ext = path.extname(filePath).toLowerCase();
  const langInfo = getLanguageFromExtension(ext);

  if (!langInfo) {
    return [];
  }

  try {
    const fullPath = path.join(repoPath, filePath);
    const content = await fs.readFile(fullPath, 'utf-8');

    // tree-sitter WASM has a ~32KB limit per parse call
    // For large files, we use line-based chunking and merge results
    const MAX_PARSE_SIZE = 30000; // Conservative limit below 32KB

    if (content.length <= MAX_PARSE_SIZE) {
      // Small file: parse directly
      return parseAndExtractFunctions(content, langInfo.language, filePath);
    }

    // Large file: split by lines and parse in chunks
    const lines = content.split('\n');
    const functions: FunctionInfo[] = [];
    let currentPos = 0;

    while (currentPos < lines.length) {
      const startLine = currentPos + 1; // 1-indexed
      let chunk = '';
      let endLine = currentPos;

      // Build chunk that stays under size limit
      while (endLine < lines.length) {
        const testChunk = chunk + lines[endLine] + '\n';
        if (testChunk.length > MAX_PARSE_SIZE && chunk.length > 0) {
          break;
        }
        chunk = testChunk;
        endLine++;
      }

      try {
        const chunkFunctions = await parseAndExtractFunctions(chunk, langInfo.language, filePath);
        // Adjust line numbers to be absolute
        for (const func of chunkFunctions) {
          func.startLine += currentPos;
          func.endLine += currentPos;
        }
        functions.push(...chunkFunctions);
      } catch {
        // Skip failed chunks
      }

      currentPos = endLine;
      // Ensure progress
      if (endLine === currentPos && currentPos < lines.length) {
        currentPos++;
      }
    }

    return functions;
  } catch (err) {
    console.error(`[ERROR] Failed to extract functions from ${filePath}:`, err);
    return [];
  }
}

/**
 * Parse content and extract functions.
 */
async function parseAndExtractFunctions(
  content: string,
  language: SupportedLanguages,
  filePath: string,
): Promise<FunctionInfo[]> {
  const parser = await loadParser();
  await loadLanguage(language, filePath);

  const tree = parser.parse(content);
  const functions: FunctionInfo[] = [];

  extractFunctionsFromNode(tree.rootNode, language, content, functions, []);

  return functions;
}

/**
 * Find a variable_declarator ancestor for an arrow function.
 */
function findVariableDeclarator(
  node: Parser.SyntaxNode,
  ancestors: Parser.SyntaxNode[],
): Parser.SyntaxNode | null {
  // Search from most recent ancestor to oldest
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type === 'variable_declarator') {
      return ancestors[i];
    }
  }
  return null;
}

/**
 * Recursively extract function declarations from AST nodes.
 */
function extractFunctionsFromNode(
  node: Parser.SyntaxNode,
  language: SupportedLanguages,
  content: string,
  out: FunctionInfo[],
  ancestors: Parser.SyntaxNode[],
): void {
  const functionNodeTypes = getFunctionNodeTypes(language);

  if (functionNodeTypes.has(node.type)) {
    const funcInfo = buildFunctionInfoFromAncestors(node, content, ancestors);
    if (funcInfo) {
      out.push(funcInfo);
    }
  }

  // Recurse into children, passing updated ancestor chain
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      extractFunctionsFromNode(child, language, content, out, [...ancestors, node]);
    }
  }
}

/**
 * Get the AST node types that represent function declarations for a language.
 */
function getFunctionNodeTypes(language: SupportedLanguages): Set<string> {
  switch (language) {
    case SupportedLanguages.JavaScript:
    case SupportedLanguages.TypeScript:
      return new Set(['function_declaration', 'method_definition', 'function', 'arrow_function']);
    case SupportedLanguages.Python:
      return new Set(['function_definition', 'class']);
    case SupportedLanguages.Java:
      return new Set(['method_declaration', 'constructor_declaration']);
    case SupportedLanguages.C:
    case SupportedLanguages.CPlusPlus:
      return new Set(['function_definition', 'method_definition']);
    case SupportedLanguages.CSharp:
      return new Set(['method_declaration', 'constructor_declaration']);
    case SupportedLanguages.Go:
      return new Set(['function_declaration', 'method_declaration']);
    case SupportedLanguages.Rust:
      return new Set(['function_item', 'method_declaration']);
    case SupportedLanguages.PHP:
      return new Set(['function_definition', 'method']);
    case SupportedLanguages.Ruby:
      return new Set(['method', 'singleton_method']);
    case SupportedLanguages.Kotlin:
      return new Set(['function_declaration', 'method_declaration']);
    case SupportedLanguages.Swift:
      return new Set(['function_declaration', 'method_declaration']);
    case SupportedLanguages.Dart:
      return new Set(['function_declaration', 'method_declaration']);
    default:
      return new Set(['function_declaration']);
  }
}

/**
 * Build FunctionInfo from a function AST node using ancestor chain.
 * Handles different language-specific AST structures.
 */
function buildFunctionInfoFromAncestors(
  node: Parser.SyntaxNode,
  content: string,
  ancestors: Parser.SyntaxNode[],
): FunctionInfo | null {
  const name = extractFunctionNameWithAncestors(node, ancestors);
  if (!name || name.length > 200) return null; // Skip anonymous/binary functions

  // Get line range (tree-sitter uses 0-indexed lines)
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // Extract signature for context
  const signature = extractSignature(node, content);

  return { name, startLine, endLine, signature };
}

/**
 * Extract the function name from an AST node using ancestor chain.
 */
function extractFunctionNameWithAncestors(
  node: Parser.SyntaxNode,
  ancestors: Parser.SyntaxNode[],
): string | null {
  // For C/C++ function_definition and method_definition
  if (node.type === 'function_definition' || node.type === 'method_definition') {
    const declarator =
      node.childForFieldName('declarator') ?? node.childForFieldName('declaratorNode');
    if (declarator) {
      const identifier = findIdentifierInNode(declarator);
      if (identifier) return identifier;
    }
    const text = node.text;
    const match = text.match(/(\w+(?:::\w+)*)\s*\(/);
    if (match) return match[1];
    return null;
  }

  // For JavaScript/TypeScript arrow functions like: const name = () => ...
  // The arrow function itself has no name, we need to look at the enclosing variable_declarator
  if (node.type === 'arrow_function') {
    const varDeclarator = findVariableDeclarator(node, ancestors);
    if (varDeclarator) {
      const varName = varDeclarator.childForFieldName('name');
      if (varName && varName.type === 'identifier') {
        return varName.text;
      }
    }
    return null;
  }

  // For method_definition in TypeScript
  if (node.type === 'method_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;
    return null;
  }

  // For function_declaration (JavaScript/TypeScript)
  if (node.type === 'function_declaration') {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text ?? null;
  }

  return null;
}

/**
 * Recursively find an identifier node within a declarator tree.
 */
function findIdentifierInNode(node: Parser.SyntaxNode): string | null {
  // Direct identifier
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return node.text;
  }

  // Qualified identifier like std::string::method
  if (node.type === 'qualified_identifier') {
    // Get the last part (the actual function name)
    const children = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type === 'identifier' || child.type === 'field_identifier') {
        children.push(child.text);
      }
    }
    if (children.length > 0) {
      return children[children.length - 1]; // Return last identifier
    }
  }

  // For pointer/declarator nodes, look in children
  if (
    node.type === 'pointer_declarator' ||
    node.type === 'reference_declarator' ||
    node.type === 'init_declarator' ||
    node.type === 'company_def declarator'
  ) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const result = findIdentifierInNode(node.namedChild(i));
      if (result) return result;
    }
  }

  // Check nested nodes
  for (let i = 0; i < node.namedChildCount; i++) {
    const result = findIdentifierInNode(node.namedChild(i));
    if (result) return result;
  }

  return null;
}

/**
 * Extract a readable function signature from the AST node.
 */
function extractSignature(node: Parser.SyntaxNode, content: string): string {
  const lines = content.split('\n');
  if (node.startPosition.row < lines.length) {
    for (let i = node.startPosition.row; i <= node.endPosition.row && i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length > 0) {
        return line.slice(0, 200);
      }
    }
  }

  const nodeText = node.text;
  const firstLine = nodeText.split('\n')[0];
  return firstLine.slice(0, 200);
}

/**
 * Map file extension to SupportedLanguage.
 */
function getLanguageFromExtension(
  ext: string,
): { language: SupportedLanguages; isTsx: boolean } | null {
  const map: Record<string, { language: SupportedLanguages; isTsx: boolean }> = {
    '.js': { language: SupportedLanguages.JavaScript, isTsx: false },
    '.jsx': { language: SupportedLanguages.JavaScript, isTsx: false },
    '.mjs': { language: SupportedLanguages.JavaScript, isTsx: false },
    '.cjs': { language: SupportedLanguages.JavaScript, isTsx: false },
    '.ts': { language: SupportedLanguages.TypeScript, isTsx: false },
    '.tsx': { language: SupportedLanguages.TypeScript, isTsx: true },
    '.py': { language: SupportedLanguages.Python, isTsx: false },
    '.java': { language: SupportedLanguages.Java, isTsx: false },
    '.c': { language: SupportedLanguages.C, isTsx: false },
    '.h': { language: SupportedLanguages.C, isTsx: false },
    '.cpp': { language: SupportedLanguages.CPlusPlus, isTsx: false },
    '.cc': { language: SupportedLanguages.CPlusPlus, isTsx: false },
    '.cxx': { language: SupportedLanguages.CPlusPlus, isTsx: false },
    '.hpp': { language: SupportedLanguages.CPlusPlus, isTsx: false },
    '.cs': { language: SupportedLanguages.CSharp, isTsx: false },
    '.go': { language: SupportedLanguages.Go, isTsx: false },
    '.rs': { language: SupportedLanguages.Rust, isTsx: false },
    '.php': { language: SupportedLanguages.PHP, isTsx: false },
    '.rb': { language: SupportedLanguages.Ruby, isTsx: false },
    '.kt': { language: SupportedLanguages.Kotlin, isTsx: false },
    '.swift': { language: SupportedLanguages.Swift, isTsx: false },
    '.dart': { language: SupportedLanguages.Dart, isTsx: false },
  };

  return map[ext] ?? null;
}

// ─── Function-to-Doc Matching ─────────────────────────────────────────

/**
 * Find functions that are affected by the changed lines.
 */
export function findAffectedFunctions(
  changedFiles: ChangedFile[],
  functionsByFile: Map<string, FunctionInfo[]>,
): Map<string, FunctionInfo[]> {
  const affected = new Map<string, FunctionInfo[]>();

  for (const changedFile of changedFiles) {
    const filePath = changedFile.filePath;

    if (shouldIgnorePath(filePath)) continue;

    const functions = functionsByFile.get(filePath);
    if (!functions || functions.length === 0) continue;

    const affectedFunctions = functions.filter((func) => {
      return changedFile.changedRanges.some((range) => {
        return func.startLine <= range.end && func.endLine >= range.start;
      });
    });

    if (affectedFunctions.length > 0) {
      affected.set(filePath, affectedFunctions);
    }
  }

  return affected;
}

/**
 * Parse a wiki markdown file to find existing function documentation sections.
 * Extracts function names from titles like "## functionName()" or "## 函数名"
 */
export async function findExistingFunctionDocs(wikiPath: string): Promise<Map<string, number>> {
  const existingDocs = new Map<string, number>();

  try {
    const content = await fs.readFile(wikiPath, 'utf-8');
    const lines = content.split('\n');

    // Pattern to match ## functionName() or ## 函数名
    // Group 1 captures the function name (word characters, ::, <>, &, *, spaces)
    const sectionPattern = /^#{2,3}\s+([\w:<\>&\*\s]+?)(?:\s*\(\)|函数|$)/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(sectionPattern);
      if (match) {
        let funcName = match[1].trim();
        // Remove trailing () if present
        funcName = funcName.replace(/\(\)$/, '').trim();
        // Skip if name is empty or looks like just a type (single word starting with lowercase)
        // Accept names with :: (C++ qualified names) or multiple words
        if (
          funcName &&
          (funcName.includes('::') ||
            funcName.includes(' ') ||
            funcName.match(/\s/) ||
            funcName.length > 20)
        ) {
          existingDocs.set(funcName, i + 1);
        }
      }
    }
  } catch {
    // File doesn't exist
  }

  return existingDocs;
}

// ─── Documentation Generation ─────────────────────────────────────────

/**
 * Generate documentation for a list of changed functions.
 */
export async function generateFunctionDocs(
  functions: Array<{ func: FunctionInfo; filePath: string }>,
  repoPath: string,
  llmConfig: LLMConfig,
  onProgress?: (current: number, total: number, funcName: string) => void,
): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  const total = functions.length;

  for (let i = 0; i < functions.length; i++) {
    const { func, filePath } = functions[i];
    try {
      onProgress?.(i + 1, total, func.name);

      const sourceCode = await readFunctionSource(repoPath, filePath, func);
      const doc = await generateDocForFunction(func, sourceCode, llmConfig);
      docs.set(func.name, doc);
    } catch (err: any) {
      console.error(`[ERROR] Failed to generate doc for ${func.name}:`, err.message);
      docs.set(func.name, '');
    }
  }

  return docs;
}

/**
 * Read the source code for a specific function.
 */
async function readFunctionSource(
  repoPath: string,
  filePath: string,
  func: FunctionInfo,
): Promise<string> {
  const fullPath = path.join(repoPath, filePath);
  const content = await fs.readFile(fullPath, 'utf-8');
  const lines = content.split('\n');

  const start = Math.max(0, func.startLine - 1);
  const end = Math.min(lines.length, func.endLine);
  const contextStart = Math.max(0, start - 3);

  return lines.slice(contextStart, end).join('\n');
}

/**
 * Call LLM to generate documentation for a single function.
 */
async function generateDocForFunction(
  func: FunctionInfo,
  sourceCode: string,
  llmConfig: LLMConfig,
): Promise<string> {
  const prompt = fillTemplate(FUNCTION_DOC_USER_PROMPT, {
    FUNCTION_NAME: func.name,
    FUNCTION_SIGNATURE: func.signature,
    SOURCE_CODE: sourceCode,
  });

  let response: LLMResponse;
  try {
    response = await callLLM(prompt, llmConfig, FUNCTION_DOC_SYSTEM_PROMPT);
  } catch (err: any) {
    throw new Error(`LLM call failed: ${err.message}`);
  }

  return cleanLLMContent(response.content);
}

/**
 * Clean LLM response content.
 * Removes thinking/reasoning tags and extra whitespace.
 */
function cleanLLMContent(content: string): string {
  // Remove thinking/reasoning tags using a helper function
  let cleaned = removeThinkingTags(content);

  // Remove Chinese full-width thinking brackets
  cleaned = cleaned.replace(/【 thinking 】[\s\S]*?【\/ thinking 】/gi, '');

  // Remove any leading/trailing whitespace and multiple blank lines
  cleaned = cleaned.replace(/^\s*\n\s*\n/, '\n').trim();

  return cleaned;
}

/**
 * Remove thinking/reasoning tags from LLM output.
 */
function removeThinkingTags(content: string): string {
  // Patterns to remove (order matters - remove outer tags first)
  const patterns = [
    /<think[\s\S]*?>[\s\S]*?<\/think[\s\S]*?>/gi,
    /<think>[\s\S]*?<\/think>/gi,
    /<think>[\s\S]*?<\/planning>/gi,
    /<ooc>[\s\S]*?<\/ooc>/gi,
    /<response>[\s\S]*?<\/response>/gi,
  ];

  let result = content;
  for (const pattern of patterns) {
    result = result.replace(pattern, '');
  }
  return result;
}

// ─── Document Updating ────────────────────────────────────────────────

/**
 * Update a wiki page with new/updated function documentation.
 */
export async function updateWikiPage(
  wikiPath: string,
  existingDocs: Map<string, number>,
  newDocs: Map<string, string>,
  onProgress?: (current: number, total: number, funcName: string) => void,
): Promise<UpdateResult> {
  const result: UpdateResult = {
    filePath: wikiPath,
    functionsUpdated: 0,
    functionsAdded: 0,
    errors: [],
  };

  if (newDocs.size === 0) {
    return result;
  }

  try {
    let content: string;
    try {
      content = await fs.readFile(wikiPath, 'utf-8');
    } catch {
      content = '';
    }

    const lines = content.split('\n');
    const funcEntries = Array.from(newDocs.entries());
    const total = funcEntries.length;

    for (let i = 0; i < funcEntries.length; i++) {
      const [funcName, doc] = funcEntries[i];
      onProgress?.(i + 1, total, funcName);

      if (!doc) {
        result.errors.push(`Empty doc for ${funcName}`);
        continue;
      }

      const existingLine = existingDocs.get(funcName);

      if (existingLine !== undefined) {
        try {
          content = updateExistingSection(content, lines, existingLine, funcName, doc);
          result.functionsUpdated++;
        } catch (err: any) {
          result.errors.push(`Failed to update ${funcName}: ${err.message}`);
        }
      } else {
        try {
          content = appendNewSection(content, doc);
          result.functionsAdded++;
        } catch (err: any) {
          result.errors.push(`Failed to add ${funcName}: ${err.message}`);
        }
      }
    }

    await fs.writeFile(wikiPath, content, 'utf-8');
  } catch (err: any) {
    result.errors.push(`Failed to update wiki page: ${err.message}`);
  }

  return result;
}

/**
 * Update an existing function section in the document.
 */
function updateExistingSection(
  content: string,
  lines: string[],
  startLine: number,
  funcName: string,
  newDoc: string,
): string {
  const startIdx = startLine - 1;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].match(/^#{1,3}\s+/)) {
      endIdx = i;
      break;
    }
  }

  let titleIdx = startIdx;
  while (titleIdx > 0 && !lines[titleIdx].match(/^#{2,3}\s+/)) {
    titleIdx--;
  }

  const beforeSection = content.split('\n').slice(0, titleIdx).join('\n');
  const afterSection = content.split('\n').slice(endIdx).join('\n');

  return beforeSection + '\n' + newDoc + '\n' + afterSection;
}

/**
 * Append a new function section to the document.
 */
function appendNewSection(content: string, newDoc: string): string {
  const summaryMatch = content.match(/^#{2,3}\s+(总结|概览|Architecture|Summary)/m);

  if (summaryMatch) {
    const summaryIdx = content.indexOf(summaryMatch[0]);
    const before = content.slice(0, summaryIdx);
    return before + newDoc + '\n\n' + content.slice(summaryIdx);
  }

  return content + '\n\n' + newDoc;
}

// ─── Main Orchestration ───────────────────────────────────────────────

export interface IncrementalUpdateOptions {
  repoPath: string;
  wikiDir: string;
  moduleFiles: Record<string, string[]>;
  fromCommit: string;
  toCommit: string;
  llmConfig: LLMConfig;
  onProgress?: (phase: string, percent: number, detail: string) => void;
  /** If true, update all functions even if no git changes detected */
  rebuildAll?: boolean;
}

/**
 * Result of running incremental update.
 */
export interface IncrementalUpdateResult {
  updatedModules: string[];
  results: UpdateResult[];
  /** Whether the commits were on divergent branches */
  isDivergent: boolean;
  /** The base commit used for diffing (may differ from original fromCommit if divergent) */
  baseCommit: string | null;
}

/**
 * Main entry point for incremental wiki update.
 */
export async function runIncrementalUpdate(
  options: IncrementalUpdateOptions,
): Promise<IncrementalUpdateResult> {
  const {
    repoPath,
    wikiDir,
    moduleFiles,
    fromCommit,
    toCommit,
    llmConfig,
    onProgress,
    rebuildAll,
  } = options;

  const progress = (phase: string, percent: number, detail: string) => {
    onProgress?.(phase, percent, detail);
  };

  // Build module-by-file map for later use
  const moduleByFile = buildModuleByFileMap(moduleFiles);

  // If rebuildAll is true, update all files in all modules
  if (rebuildAll) {
    progress('functions', 5, 'Rebuilding all function docs...');

    const allFiles: string[] = [];
    for (const files of Object.values(moduleFiles)) {
      allFiles.push(...files);
    }
    progress('functions', 6, `Processing ${allFiles.length} files for function extraction...`);

    const functionsByFile = new Map<string, FunctionInfo[]>();
    let fileCount = 0;

    for (const filePath of allFiles) {
      if (shouldIgnorePath(filePath)) continue;

      fileCount++;
      progress(
        'functions',
        10 + Math.round((fileCount / allFiles.length) * 15),
        `${fileCount}/${allFiles.length} — ${filePath}`,
      );

      try {
        const funcs = await extractFunctions(filePath, repoPath);
        if (funcs.length > 0) {
          functionsByFile.set(filePath, funcs);
        }
      } catch (err) {
        console.error(`[ERROR] extractFunctions failed for ${filePath}:`, err);
      }
    }

    progress('functions', 26, `Extracted functions from ${functionsByFile.size} files`);

    if (functionsByFile.size === 0) {
      progress('functions', 100, 'No functions found');
      return { updatedModules: [], results: [], isDivergent: false, baseCommit: null };
    }

    const totalFunctions = [...functionsByFile.values()].flat().length;
    progress('functions', 28, `Found ${totalFunctions} functions in ${functionsByFile.size} files`);

    // Group functions by module, deduplicate by function name+signature
    const functionsToProcess: Array<{ func: FunctionInfo; filePath: string; moduleSlug: string }> =
      [];
    const seenFunctions = new Set<string>();

    for (const [filePath, funcs] of functionsByFile) {
      const moduleSlug = moduleByFile.get(filePath);
      if (moduleSlug) {
        for (const func of funcs) {
          // Deduplicate: prefer .cpp files over .hpp for function definitions
          const key = `${func.name}:${func.signature}`;
          const isCpp = filePath.endsWith('.cpp');
          const existingEntry = seenFunctions.has(key);

          if (!existingEntry) {
            functionsToProcess.push({ func, filePath, moduleSlug });
            seenFunctions.add(key);
          } else if (isCpp) {
            // Replace .hpp entry with .cpp entry (more complete definition)
            const idx = functionsToProcess.findIndex(
              (f) => f.func.name === func.name && f.func.signature === func.signature,
            );
            if (idx >= 0 && !functionsToProcess[idx].filePath.endsWith('.cpp')) {
              functionsToProcess[idx] = { func, filePath, moduleSlug };
            }
          }
        }
      }
    }

    if (functionsToProcess.length === 0) {
      progress('functions', 100, 'No functions to update');
      return { updatedModules: [], results: [], isDivergent: false, baseCommit: null };
    }

    progress('functions', 30, `Generating ${totalFunctions} function documentations...`);

    const docs = await generateFunctionDocs(
      functionsToProcess.map((f) => ({ func: f.func, filePath: f.filePath })),
      repoPath,
      llmConfig,
      (current, total, funcName) => {
        const percent = Math.round(30 + (current / total) * 55);
        progress('functions', percent, `${current}/${total} — ${funcName}`);
      },
    );

    const docsByModule = new Map<string, Map<string, string>>();
    for (const { func, moduleSlug } of functionsToProcess) {
      const doc = docs.get(func.name);
      if (doc) {
        if (!docsByModule.has(moduleSlug)) {
          docsByModule.set(moduleSlug, new Map());
        }
        docsByModule.get(moduleSlug)!.set(func.name, doc);
      }
    }

    if (docsByModule.size === 0) {
      progress('functions', 100, 'No function docs generated');
      return { updatedModules: [], results: [], isDivergent: false, baseCommit: fromCommit };
    }

    progress('functions', 86, 'Writing wiki pages...');

    const results: UpdateResult[] = [];
    const updatedModules: string[] = [];

    let processed = 0;
    for (const [moduleSlug, moduleDocs] of docsByModule) {
      const wikiPath = path.join(wikiDir, `${moduleSlug}.md`);

      // For rebuildAll mode:
      // 1. Read existing content to preserve non-function sections
      // 2. Remove old function documentation (sections starting with ## followed by lowercase)
      // 3. Replace with new function documentation

      let content = '';
      try {
        content = await fs.readFile(wikiPath, 'utf-8');
      } catch {
        content = '';
      }

      // Combine all new function docs
      let newFuncDocs = '';
      for (const [, doc] of moduleDocs) {
        newFuncDocs += doc + '\n\n';
      }

      // Remove old function documentation sections
      // Keep everything before the first function section (## followed by lowercase)
      const lines = content.split('\n');
      let functionStartIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Start of function documentation: ## followed by lowercase (function name)
        if (/^## [a-z]/.test(line)) {
          functionStartIdx = i;
          break;
        }
      }

      let preservedContent = '';
      if (functionStartIdx >= 0) {
        // Keep header/overview/architecture sections, remove function docs
        preservedContent = lines.slice(0, functionStartIdx).join('\n');
      } else {
        // No function section found, keep everything (will append)
        preservedContent = content;
      }

      // Write new content
      const finalContent = (preservedContent + '\n\n' + newFuncDocs).trim();
      await fs.writeFile(wikiPath, finalContent, 'utf-8');

      results.push({
        filePath: wikiPath,
        functionsUpdated: 0,
        functionsAdded: moduleDocs.size,
        errors: [],
      });
      updatedModules.push(moduleSlug);

      processed++;
      const percent = 87 + Math.round((processed / docsByModule.size) * 12);
      progress('functions', percent, `${processed}/${docsByModule.size} modules`);
    }

    progress('functions', 100, `${updatedModules.length} modules with ${totalFunctions} functions`);
    return {
      updatedModules,
      results,
      isDivergent: false,
      baseCommit: fromCommit,
    };
  }

  // Normal incremental update: use git diff
  progress('incremental', 5, 'Parsing git diff...');

  const diffResult = parseGitDiff(repoPath, fromCommit, toCommit);
  const changedFiles = diffResult.changedFiles;

  if (diffResult.isDivergent) {
    progress('incremental', 8, 'Branch diverged from wiki base, finding merge base...');
  }

  if (changedFiles.length === 0) {
    progress('incremental', 100, 'No changes detected');
    return {
      updatedModules: [],
      results: [],
      isDivergent: diffResult.isDivergent,
      baseCommit: null,
    };
  }

  progress('incremental', 10, `${changedFiles.length} files changed`);

  progress('incremental', 15, 'Extracting functions from changed files...');
  const functionsByFile = new Map<string, FunctionInfo[]>();

  for (const changedFile of changedFiles) {
    if (shouldIgnorePath(changedFile.filePath)) continue;

    const funcs = await extractFunctions(changedFile.filePath, repoPath);
    if (funcs.length > 0) {
      functionsByFile.set(changedFile.filePath, funcs);
    }
  }

  const affectedFunctions = findAffectedFunctions(changedFiles, functionsByFile);
  if (affectedFunctions.size === 0) {
    progress('incremental', 100, 'No functions affected by changes');
    return {
      updatedModules: [],
      results: [],
      isDivergent: diffResult.isDivergent,
      baseCommit: null,
    };
  }

  progress(
    'incremental',
    30,
    `Found ${[...affectedFunctions.values()].flat().length} affected functions`,
  );

  const functionsToProcess: Array<{ func: FunctionInfo; filePath: string; moduleSlug: string }> =
    [];

  for (const [filePath, funcs] of affectedFunctions) {
    const moduleSlug = moduleByFile.get(filePath);
    if (moduleSlug) {
      for (const func of funcs) {
        functionsToProcess.push({ func, filePath, moduleSlug });
      }
    }
  }

  if (functionsToProcess.length === 0) {
    progress('functions', 100, 'No functions to update');
    return {
      updatedModules: [],
      results: [],
      isDivergent: diffResult.isDivergent,
      baseCommit: null,
    };
  }

  const totalFunctions = functionsToProcess.length;
  progress('functions', 40, `Generating ${totalFunctions} function documentations...`);

  const docs = await generateFunctionDocs(
    functionsToProcess.map((f) => ({ func: f.func, filePath: f.filePath })),
    repoPath,
    llmConfig,
    (current, total, funcName) => {
      const percent = Math.round(40 + (current / total) * 40);
      progress('functions', percent, `${current}/${total} — ${funcName}`);
    },
  );

  const docsByModule = new Map<string, Map<string, string>>();
  for (const { func, moduleSlug } of functionsToProcess) {
    const doc = docs.get(func.name);
    if (doc) {
      if (!docsByModule.has(moduleSlug)) {
        docsByModule.set(moduleSlug, new Map());
      }
      docsByModule.get(moduleSlug)!.set(func.name, doc);
    }
  }

  progress('functions', 82, 'Updating wiki pages...');

  const results: UpdateResult[] = [];
  const updatedModules: string[] = [];

  let processed = 0;
  for (const [moduleSlug, moduleDocs] of docsByModule) {
    const wikiPath = path.join(wikiDir, `${moduleSlug}.md`);
    const existingDocs = await findExistingFunctionDocs(wikiPath);

    const result = await updateWikiPage(
      wikiPath,
      existingDocs,
      moduleDocs,
      (current, total, funcName) => {
        const percent = Math.round(83 + (current / total) * 10);
        progress('functions', percent, `${current}/${total} — ${funcName}`);
      },
    );

    results.push(result);
    if (result.functionsUpdated > 0 || result.functionsAdded > 0) {
      updatedModules.push(moduleSlug);
    }

    processed++;
    const percent = 93 + Math.round((processed / docsByModule.size) * 6);
    progress('functions', percent, `${processed}/${docsByModule.size} modules`);
  }

  progress('functions', 100, `${updatedModules.length} modules with ${totalFunctions} functions`);
  return {
    updatedModules,
    results,
    isDivergent: diffResult.isDivergent,
    baseCommit: diffResult.isDivergent ? getMergeBase(repoPath, fromCommit, toCommit) : fromCommit,
  };
}

/**
 * Build a reverse map from file path to module slug.
 */
function buildModuleByFileMap(moduleFiles: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();

  for (const [moduleName, files] of Object.entries(moduleFiles)) {
    const slug = moduleName
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    for (const file of files) {
      map.set(file, slug);
    }
  }

  return map;
}
