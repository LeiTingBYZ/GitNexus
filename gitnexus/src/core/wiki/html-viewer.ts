/**
 * Wiki Viewer Generator
 *
 * Generates either:
 * - HTML: self-contained index.html with embedded pages (interactive editing)
 * - Markdown: index.md + individual module .md files (easy to diff with git)
 */

import fs from 'fs/promises';
import path from 'path';

interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

interface WikiPage {
  slug: string;
  content: string;
}

/**
 * Generate the wiki HTML viewer (index.html) from existing markdown pages.
 */
export async function generateHTMLViewer(wikiDir: string, projectName: string): Promise<string> {
  // Load module tree
  let moduleTree: ModuleTreeNode[] = [];
  try {
    const raw = await fs.readFile(path.join(wikiDir, 'module_tree.json'), 'utf-8');
    moduleTree = JSON.parse(raw);
  } catch {
    /* will show empty nav */
  }

  // Load meta
  let meta: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf-8');
    meta = JSON.parse(raw);
  } catch {
    /* no meta */
  }

  // Read all markdown files into a { slug: content } map
  const pages: Record<string, string> = {};
  const dirEntries = await fs.readdir(wikiDir);
  for (const f of dirEntries.filter((f) => f.endsWith('.md'))) {
    const content = await fs.readFile(path.join(wikiDir, f), 'utf-8');
    pages[f.replace(/\.md$/, '')] = content;
  }

  const html = buildHTML(projectName, moduleTree, pages, meta);
  const outputPath = path.join(wikiDir, 'index.html');
  await fs.writeFile(outputPath, html, 'utf-8');
  return outputPath;
}

/**
 * Generate the wiki as Markdown files (index.md + individual .md files).
 * This format is easy to diff with git and edit directly.
 */
export async function generateMarkdownViewer(
  wikiDir: string,
  projectName: string,
): Promise<string> {
  // Load module tree
  let moduleTree: ModuleTreeNode[] = [];
  try {
    const raw = await fs.readFile(path.join(wikiDir, 'module_tree.json'), 'utf-8');
    moduleTree = JSON.parse(raw);
  } catch {
    /* will show empty nav */
  }

  // Load meta
  let meta: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf-8');
    meta = JSON.parse(raw);
  } catch {
    /* no meta */
  }

  // Read all markdown files into a { slug: content } map
  const pages: Record<string, string> = {};
  const dirEntries = await fs.readdir(wikiDir);
  for (const f of dirEntries.filter((f) => f.endsWith('.md'))) {
    const content = await fs.readFile(path.join(wikiDir, f), 'utf-8');
    pages[f.replace(/\.md$/, '')] = content;
  }

  // Build markdown index
  const indexMd = buildMarkdownIndex(projectName, moduleTree, pages, meta);

  // Write index.md
  const indexPath = path.join(wikiDir, 'index.md');
  await fs.writeFile(indexPath, indexMd, 'utf-8');

  return indexPath;
}

/**
 * Build the Markdown index file content.
 */
function buildMarkdownIndex(
  projectName: string,
  moduleTree: ModuleTreeNode[],
  pages: Record<string, string>,
  meta: Record<string, unknown> | null,
): string {
  const parts: string[] = [];

  // Header
  parts.push(`# ${projectName} — Wiki`);
  parts.push('');

  // Meta info
  if (meta) {
    if (meta.generatedAt) {
      parts.push(`> Generated: ${new Date(meta.generatedAt as string).toLocaleString()}`);
    }
    if (meta.model) {
      parts.push(`> Model: ${meta.model}`);
    }
    if (meta.fromCommit) {
      parts.push(`> From commit: ${meta.fromCommit as string}`);
    }
    parts.push('');
  }

  // Table of contents
  parts.push('## Table of Contents');
  parts.push('');
  parts.push('- [Overview](#overview)');
  if (moduleTree.length > 0) {
    parts.push('');
    parts.push('## Modules');
    buildModuleToc(moduleTree, parts, 0);
  }
  parts.push('');
  parts.push('---');
  parts.push('');

  // Divider with links
  parts.push('## Quick Links');
  parts.push('');
  parts.push('| Module | File |');
  parts.push('|--------|------|');
  parts.push('| Overview | [overview.md](./overview.md) |');
  if (moduleTree.length > 0) {
    buildModuleLinks(moduleTree, parts);
  }
  parts.push('');
  parts.push('---');
  parts.push('');

  // All page contents inline
  parts.push('## Full Content');
  parts.push('');
  parts.push('> **Note:** This file contains all wiki content for reference. ');
  parts.push('> For better readability, open the individual .md files listed above.');
  parts.push('');
  parts.push('---');
  parts.push('');

  // Overview content
  if (pages['overview']) {
    parts.push('### Overview');
    parts.push('');
    parts.push(pages['overview']);
    parts.push('');
  }

  // Module contents
  if (moduleTree.length > 0) {
    buildModuleContent(moduleTree, pages, parts);
  }

  return parts.join('\n');
}

/**
 * Build table of contents entries for modules.
 */
function buildModuleToc(nodes: ModuleTreeNode[], parts: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const bullet = depth === 0 ? '-' : '-';

  for (const node of nodes) {
    parts.push(`${indent}${bullet} [${node.name}](#${node.slug})`);
    if (node.children && node.children.length > 0) {
      buildModuleToc(node.children, parts, depth + 1);
    }
  }
}

/**
 * Build table links for modules.
 */
function buildModuleLinks(nodes: ModuleTreeNode[], parts: string[]): void {
  for (const node of nodes) {
    parts.push(`| ${node.name} | [${node.slug}.md](./${node.slug}.md) |`);
    if (node.children && node.children.length > 0) {
      buildModuleLinks(node.children, parts);
    }
  }
}

/**
 * Build content sections for modules.
 */
function buildModuleContent(
  nodes: ModuleTreeNode[],
  pages: Record<string, string>,
  parts: string[],
): void {
  for (const node of nodes) {
    parts.push(`### ${node.name}`);
    parts.push('');

    if (pages[node.slug]) {
      parts.push(pages[node.slug]);
    } else {
      parts.push(`*Content for ${node.slug} not found.*`);
    }

    parts.push('');
    parts.push(`[Back to top](#table-of-contents)`);
    parts.push('');
    parts.push('---');
    parts.push('');

    if (node.children && node.children.length > 0) {
      buildModuleContent(node.children, pages, parts);
    }
  }
}

// ─── HTML Builder ───────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHTML(
  projectName: string,
  moduleTree: ModuleTreeNode[],
  pages: Record<string, string>,
  meta: Record<string, unknown> | null,
): string {
  // Embed data as JSON inside the HTML.
  // Escape </script> sequences so they don't prematurely close the <script> tag.
  const escScript = (s: string) => s.replace(/<\//g, '<\\/');
  const pagesJSON = escScript(JSON.stringify(pages));
  const treeJSON = escScript(JSON.stringify(moduleTree));
  const metaJSON = escScript(JSON.stringify(meta));

  const parts: string[] = [];

  // ── Head ──
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push('<title>' + esc(projectName) + ' — Wiki</title>');
  parts.push('<script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"><\/script>');
  parts.push(
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>',
  );
  parts.push('<style>');
  parts.push(CSS);
  parts.push('</style>');
  parts.push('</head>');

  // ── Body ──
  parts.push('<body>');
  parts.push(
    '<button class="menu-toggle" id="menu-toggle" aria-label="Toggle menu">&#9776;</button>',
  );
  // Edit toolbar (contains all buttons - visible by default with cancel/save hidden)
  parts.push('<div class="edit-toolbar" id="edit-toolbar">');
  parts.push('<button class="btn-secondary hidden" id="btn-cancel">取消</button>');
  parts.push('<span class="edit-hint" id="edit-hint"></span>');
  parts.push('<button class="btn-secondary hidden" id="btn-save-page">保存本页</button>');
  parts.push('<button class="btn-save" id="btn-download">下载全部</button>');
  parts.push('<button class="btn-secondary" id="btn-clear">清除已保存</button>');
  parts.push('<button class="btn-edit" id="btn-edit">编辑</button>');
  parts.push('</div>');
  parts.push('<div class="layout">');

  // Sidebar
  parts.push('<nav class="sidebar" id="sidebar">');
  parts.push('<div class="sidebar-header">');
  parts.push('<div class="sidebar-title">');
  parts.push(BOOK_SVG);
  parts.push(esc(projectName));
  parts.push('</div>');
  parts.push('<div class="sidebar-meta" id="meta-info"></div>');
  parts.push('</div>');
  parts.push('<div id="nav-tree"></div>');
  parts.push('<div class="sidebar-footer">Generated by GitNexus</div>');
  parts.push('</nav>');

  // Content
  parts.push('<main class="content" id="content">');
  parts.push('<div class="empty-state"><h2>Loading…</h2></div>');
  parts.push('</main>');
  parts.push('</div>');

  // ── Script ──
  parts.push('<script>');
  parts.push('var PAGES = ' + pagesJSON + ';');
  parts.push('var TREE = ' + treeJSON + ';');
  parts.push('var META = ' + metaJSON + ';');
  // Store JS_APP source for regenerateHtml to use
  parts.push('var JS_APP_SOURCE = ' + JSON.stringify(JS_APP) + ';');
  parts.push(JS_APP);
  parts.push('<\/script>');

  parts.push('</body>');
  parts.push('</html>');

  return parts.join('\n');
}

// ─── Static Assets ────────────────────────────────────────────────────

const BOOK_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/>' +
  '<path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>' +
  '</svg>';

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#ffffff;--sidebar-bg:#f8f9fb;--border:#e5e7eb;
  --text:#1e293b;--text-muted:#64748b;--primary:#2563eb;
  --primary-soft:#eff6ff;--hover:#f1f5f9;--code-bg:#f1f5f9;
  --radius:8px;--shadow:0 1px 3px rgba(0,0,0,.08);
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  line-height:1.65;color:var(--text);background:var(--bg)}

.layout{display:flex;min-height:100vh}
.sidebar{width:280px;background:var(--sidebar-bg);border-right:1px solid var(--border);
  position:fixed;top:0;left:0;bottom:0;overflow-y:auto;padding:24px 16px;
  display:flex;flex-direction:column;z-index:10}
.content{margin-left:280px;flex:1;padding:48px 64px;max-width:960px}

.sidebar-header{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.sidebar-title{font-size:16px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}
.sidebar-title svg{flex-shrink:0}
.sidebar-meta{font-size:11px;color:var(--text-muted);margin-top:6px}
.nav-section{margin-bottom:2px}
.nav-item{display:block;padding:7px 12px;border-radius:var(--radius);cursor:pointer;
  font-size:13px;color:var(--text);text-decoration:none;transition:all .15s;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-item:hover{background:var(--hover)}
.nav-item.active{background:var(--primary-soft);color:var(--primary);font-weight:600}
.nav-item.overview{font-weight:600;margin-bottom:4px}
.nav-children{padding-left:14px;border-left:1px solid var(--border);margin-left:12px}
.nav-group-label{font-size:11px;font-weight:600;color:var(--text-muted);
  text-transform:uppercase;letter-spacing:.5px;padding:12px 12px 4px;user-select:none}
.sidebar-footer{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);
  font-size:11px;color:var(--text-muted);text-align:center}

.content h1{font-size:28px;font-weight:700;margin-bottom:8px;line-height:1.3}
.content h2{font-size:22px;font-weight:600;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.content h3{font-size:17px;font-weight:600;margin:24px 0 8px}
.content h4{font-size:15px;font-weight:600;margin:20px 0 6px}
.content p{margin:12px 0}
.content ul,.content ol{margin:12px 0 12px 24px}
.content li{margin:4px 0}
.content a{color:var(--primary);text-decoration:none}
.content a:hover{text-decoration:underline}
.content blockquote{border-left:3px solid var(--primary);padding:8px 16px;margin:16px 0;
  background:var(--primary-soft);border-radius:0 var(--radius) var(--radius) 0;
  color:var(--text-muted);font-size:14px}
.content code{font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:13px;
  background:var(--code-bg);padding:2px 6px;border-radius:4px}
.content pre{background:#1e293b;color:#e2e8f0;border-radius:var(--radius);padding:16px;
  overflow-x:auto;margin:16px 0}
.content pre code{background:none;padding:0;font-size:13px;line-height:1.6;color:inherit}
.content table{border-collapse:collapse;width:100%;margin:16px 0}
.content th,.content td{border:1px solid var(--border);padding:8px 12px;text-align:left;font-size:14px}
.content th{background:var(--sidebar-bg);font-weight:600}
.content img{max-width:100%;border-radius:var(--radius)}
.content hr{border:none;border-top:1px solid var(--border);margin:32px 0}
.content .mermaid{margin:20px 0;text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}

.menu-toggle{display:none;position:fixed;top:12px;left:12px;z-index:20;
  background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);
  padding:8px 12px;cursor:pointer;font-size:18px;box-shadow:var(--shadow)}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:transform .2s}
  .sidebar.open{transform:translateX(0);box-shadow:2px 0 12px rgba(0,0,0,.1)}
  .content{margin-left:0;padding:24px 20px;padding-top:56px}
  .menu-toggle{display:block}
}
.empty-state{text-align:center;padding:80px 20px;color:var(--text-muted)}
.empty-state h2{font-size:20px;margin-bottom:8px;border:none}

/* Edit mode styles */
.edit-toolbar{position:sticky;top:0;background:var(--bg);padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;z-index:15;align-items:center}
.edit-toolbar button{padding:8px 16px;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;flex-shrink:0}
.edit-toolbar .btn-secondary{background:var(--sidebar-bg);border:1px solid var(--border);color:var(--text)}
.edit-toolbar .btn-secondary:hover{background:var(--hover)}
.edit-toolbar .btn-save{background:#059669;color:#fff;border:none}
.edit-toolbar .btn-save:hover{background:#047857}
.edit-toolbar .btn-edit{background:var(--primary);color:#fff;border:none;margin-left:auto}
.edit-toolbar .btn-edit:hover{background:#1d4ed8}
.edit-toolbar .edit-hint{flex:1;text-align:center;font-size:13px;color:var(--text-muted)}
.hidden{display:none !important}
.editor-wrapper{display:none;padding:24px 0}
.editor-wrapper.active{display:block}
.editor-textarea{width:100%;min-height:500px;font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:14px;line-height:1.6;padding:16px;border:1px solid var(--border);border-radius:var(--radius);resize:vertical;background:var(--bg);color:var(--text)}
.editor-textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.preview-wrapper{display:block}
.preview-wrapper.hidden{display:none}
.save-success{position:fixed;bottom:24px;right:24px;background:#059669;color:#fff;padding:12px 20px;border-radius:var(--radius);font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:100;animation:fadeInUp .3s ease}
@keyframes fadeInUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
`;

// The client-side JS is kept as a plain string to avoid template literal conflicts
const JS_APP = `
var activePage = 'overview';
var pendingNavigateTo = null;  // Store the pending page to navigate to
var STORAGE_KEY = 'gitnexus_wiki_edits';
(function() {
  var editMode = false;
  var editedPages = {};  // { slug: { original, edited } }

  document.addEventListener('DOMContentLoaded', function() {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'loose',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
    });
    renderMeta();
    renderNav();
    document.getElementById('menu-toggle').addEventListener('click', function() {
      document.getElementById('sidebar').classList.toggle('open');
    });

    // Edit mode button
    document.getElementById('btn-edit').addEventListener('click', enterEditMode);
    document.getElementById('btn-cancel').addEventListener('click', cancelEditMode);
    document.getElementById('btn-save-page').addEventListener('click', saveCurrentPage);
    document.getElementById('btn-download').addEventListener('click', downloadAll);
    document.getElementById('btn-clear').addEventListener('click', clearSaved);

    // Load saved edits from localStorage
    loadEditsFromStorage();

    if (location.hash && location.hash.length > 1) {
      activePage = decodeURIComponent(location.hash.slice(1));
    }
    doNavigate(activePage);
  });

  function renderMeta() {
    if (!META) return;
    var el = document.getElementById('meta-info');
    var parts = [];
    if (META.generatedAt) {
      parts.push(new Date(META.generatedAt).toLocaleDateString());
    }
    if (META.model) parts.push(META.model);
    if (META.fromCommit) parts.push(META.fromCommit.slice(0, 8));
    el.textContent = parts.join(' \\u00b7 ');
  }

  function renderNav() {
    var container = document.getElementById('nav-tree');
    var html = '<div class="nav-section">';
    html += '<a class="nav-item overview" data-page="overview" href="#overview">Overview</a>';
    html += '</div>';
    if (TREE.length > 0) {
      html += '<div class="nav-group-label">Modules</div>';
      html += buildNavTree(TREE);
    }
    container.innerHTML = html;
    container.addEventListener('click', function(e) {
      var target = e.target;
      while (target && !target.dataset.page) { target = target.parentElement; }
      if (target && target.dataset.page) {
        e.preventDefault();
        checkAndNavigate(target.dataset.page);
      }
    });
  }

  function buildNavTree(nodes) {
    var html = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      html += '<div class="nav-section">';
      html += '<a class="nav-item" data-page="' + escH(node.slug) + '" href="#' + encodeURIComponent(node.slug) + '">' + escH(node.name) + '</a>';
      if (node.children && node.children.length > 0) {
        html += '<div class="nav-children">' + buildNavTree(node.children) + '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  function escH(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function isPageEdited(page) {
    return editedPages[page] && editedPages[page].original !== editedPages[page].edited;
  }

  function checkAndNavigate(page) {
    // If currently in edit mode, always exit edit mode when navigating
    if (editMode) {
      // Check if there are unsaved changes
      var hasUnsavedChanges = false;
      var textarea = document.getElementById('editor-textarea');
      if (textarea) {
        var currentValue = textarea.value;
        if (editedPages[activePage]) {
          hasUnsavedChanges = currentValue !== editedPages[activePage].edited;
        } else {
          hasUnsavedChanges = currentValue !== PAGES[activePage];
        }
      }

      if (hasUnsavedChanges) {
        pendingNavigateTo = page;
        var confirmed = confirm('当前页面有未保存的修改，是否保存？');
        if (confirmed) {
          // Save current page first
          saveCurrentPageSilent();
          saveEditsToStorage();
          // Then navigate after a short delay
          setTimeout(function() { exitEditModeAndNavigate(page); }, 50);
          return;
        }
      }
      // Either no changes or user chose not to save, exit edit mode and navigate
      exitEditModeAndNavigate(page);
    } else {
      doNavigate(page);
    }
  }

  function exitEditModeAndNavigate(page) {
    editMode = false;
    // Reset to normal state
    document.getElementById('edit-toolbar').classList.remove('hidden');
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('btn-cancel').classList.add('hidden');
    document.getElementById('btn-save-page').classList.add('hidden');
    document.getElementById('btn-download').classList.remove('hidden');
    doNavigate(page);
  }

  function doNavigate(page) {
    activePage = page;
    location.hash = encodeURIComponent(page);

    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.page === page) {
        items[i].classList.add('active');
      } else {
        items[i].classList.remove('active');
      }
    }

    var contentEl = document.getElementById('content');
    var md = PAGES[page];

    if (!md) {
      contentEl.innerHTML = '<div class="empty-state"><h2>Page not found</h2><p>' + escH(page) + '.md does not exist.</p></div>';
      return;
    }

    // If in edit mode, show editor for current page, otherwise show preview
    if (editMode) {
      // Show editor with existing content (or original if not edited)
      var existingData = editedPages[page];
      var contentToEdit = existingData ? existingData.edited : md;
      if (!editedPages[page]) {
        editedPages[page] = { original: md, edited: md };
      }
      var editorHtml = '<div class="editor-wrapper active">';
      editorHtml += '<textarea class="editor-textarea" id="editor-textarea" placeholder="在这里编辑 Markdown 内容...">' + escH(contentToEdit) + '</textarea>';
      editorHtml += '</div>';
      contentEl.innerHTML = editorHtml;
      updateEditHint();
    } else {
      // Use edited content if this page has been edited, otherwise use original
      var displayMd = md;
      if (editedPages[page] && editedPages[page].original !== editedPages[page].edited) {
        displayMd = editedPages[page].edited;
      }
      contentEl.innerHTML = marked.parse(displayMd);

      // Rewrite .md links to hash navigation
      var links = contentEl.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        if (href && href.endsWith('.md') && href.indexOf('://') === -1) {
          var slug = href.replace(/\\.md$/, '');
          links[i].setAttribute('href', '#' + encodeURIComponent(slug));
          (function(s) {
            links[i].addEventListener('click', function(e) {
              e.preventDefault();
              checkAndNavigate(s);
            });
          })(slug);
        }
      }

      // Convert mermaid code blocks into mermaid divs
      var mermaidBlocks = contentEl.querySelectorAll('pre code.language-mermaid');
      for (var i = 0; i < mermaidBlocks.length; i++) {
        var pre = mermaidBlocks[i].parentElement;
        var div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = mermaidBlocks[i].textContent;
        pre.parentNode.replaceChild(div, pre);
      }
      try { mermaid.run({ querySelector: '.mermaid' }); } catch(e) {}
    }

    window.scrollTo(0, 0);
    document.getElementById('sidebar').classList.remove('open');
  }

  function getEditedCount() {
    var count = 0;
    for (var slug in editedPages) {
      // Only count pages that are actually edited (different from original)
      if (editedPages[slug].original !== editedPages[slug].edited) {
        count++;
      }
    }
    return count;
  }

  function updateEditHint() {
    var hint = document.getElementById('edit-hint');
    if (!hint) return;
    var count = getEditedCount();
    if (count === 0) {
      hint.textContent = '';
    } else if (count === 1) {
      hint.textContent = '已编辑 1 个页面';
    } else {
      hint.textContent = '已编辑 ' + count + ' 个页面';
    }
  }

  function saveEditsToStorage() {
    try {
      var data = {};
      for (var slug in editedPages) {
        if (editedPages[slug].original !== editedPages[slug].edited) {
          data[slug] = editedPages[slug].edited;
        }
      }
      if (Object.keys(data).length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch(e) {
      console.warn('Could not save edits to localStorage:', e);
    }
  }

  function loadEditsFromStorage() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        var data = JSON.parse(saved);
        for (var slug in data) {
          if (PAGES[slug] !== undefined) {
            editedPages[slug] = { original: PAGES[slug], edited: data[slug] };
          }
        }
      }
    } catch(e) {
      console.warn('Could not load edits from localStorage:', e);
    }
  }

  function clearEditsFromStorage() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function clearSaved() {
    if (confirm('确定要清除所有已保存的修改吗？此操作不可撤销。')) {
      clearEditsFromStorage();
      editedPages = {};
      updateEditHint();
      // Refresh current page
      doNavigate(activePage);
      // Show feedback
      var successDiv = document.createElement('div');
      successDiv.className = 'save-success';
      successDiv.textContent = '已清除';
      successDiv.style.background = '#dc2626';
      document.body.appendChild(successDiv);
      setTimeout(function() { successDiv.remove(); }, 1500);
    }
  }

  function saveCurrentPageSilent() {
    var textarea = document.getElementById('editor-textarea');
    if (!textarea) return;
    var page = activePage;
    if (!editedPages[page]) {
      editedPages[page] = { original: PAGES[page] || '', edited: '' };
    }
    editedPages[page].edited = textarea.value;
    updateEditHint();
  }

  function saveCurrentPage() {
    saveCurrentPageSilent();

    // Save to localStorage
    saveEditsToStorage();

    // Exit edit mode and show preview
    editMode = false;

    // Show toolbar with edit and download, hide cancel/save
    document.getElementById('edit-toolbar').classList.remove('hidden');
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('btn-cancel').classList.add('hidden');
    document.getElementById('btn-save-page').classList.add('hidden');
    document.getElementById('btn-download').classList.remove('hidden');

    // Navigate back to current page to show preview
    doNavigate(activePage);

    // Show saved feedback
    var successDiv = document.createElement('div');
    successDiv.className = 'save-success';
    successDiv.textContent = '已保存';
    document.body.appendChild(successDiv);
    setTimeout(function() { successDiv.remove(); }, 1500);
  }

  function downloadAll() {
    // Save current page first (silent, no mode change)
    saveCurrentPageSilent();

    // Save to localStorage
    saveEditsToStorage();

    // Exit edit mode
    editMode = false;

    // Show toolbar with edit and download, hide cancel/save
    document.getElementById('edit-toolbar').classList.remove('hidden');
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('btn-cancel').classList.add('hidden');
    document.getElementById('btn-save-page').classList.add('hidden');
    document.getElementById('btn-download').classList.remove('hidden');

    // Check if there are any edits to download
    var count = getEditedCount();
    if (count === 0) {
      alert('没有需要保存的修改');
      return;
    }

    // Update PAGES with all edited content
    for (var slug in editedPages) {
      PAGES[slug] = editedPages[slug].edited;
    }

    // Generate new HTML with updated content
    var newHtml = generateDownloadHtml();

    // Download the new HTML file
    var blob = new Blob([newHtml], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function enterEditMode() {
    editMode = true;

    // Show toolbar with cancel and save only, hide edit and download
    document.getElementById('edit-toolbar').classList.remove('hidden');
    document.getElementById('btn-edit').classList.add('hidden');
    document.getElementById('btn-cancel').classList.remove('hidden');
    document.getElementById('btn-save-page').classList.remove('hidden');
    document.getElementById('btn-download').classList.add('hidden');

    // Show editor for current page
    var contentEl = document.getElementById('content');
    var md = PAGES[activePage] || '';

    if (!editedPages[activePage]) {
      editedPages[activePage] = { original: md, edited: md };
    }

    var editorHtml = '<div class="editor-wrapper active">';
    editorHtml += '<textarea class="editor-textarea" id="editor-textarea" placeholder="在这里编辑 Markdown 内容...">' + escH(editedPages[activePage].edited) + '</textarea>';
    editorHtml += '</div>';
    contentEl.innerHTML = editorHtml;

    updateEditHint();
  }

  function cancelEditMode() {
    editMode = false;

    // Show toolbar with edit and download, hide cancel/save
    document.getElementById('edit-toolbar').classList.remove('hidden');
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('btn-cancel').classList.add('hidden');
    document.getElementById('btn-save-page').classList.add('hidden');
    document.getElementById('btn-download').classList.remove('hidden');

    // Refresh page to exit edit mode and show preview
    doNavigate(activePage);
  }
})();

// Helper function outside the IIFE to generate download HTML
// This avoids JSON.stringify issues with regex patterns in JS_APP_SOURCE
function generateDownloadHtml() {
  // Use string split/join to avoid regex issues
  var escScript = function(s) {
    return s.split('<script').join('<scr" + "ipt').split('</script').join('</scr" + "ipt');
  };
  var escH = function(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  };

  var pagesJson = escScript(JSON.stringify(PAGES));
  var treeJson = escScript(JSON.stringify(TREE));
  var metaJson = escScript(JSON.stringify(META));

  // Use JS_APP_SOURCE directly since activePage is now global
  var jsAppSource = JS_APP_SOURCE;

  var html = '<!DOCTYPE html>';
  html += '<html lang="en">';
  html += '<head>';
  html += '<meta charset="UTF-8">';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
  html += '<title>' + escH(document.title) + '</title>';
  html += '<script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"><\\/script>';
  html += '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\\/script>';
  html += '<style>' + document.querySelector('style').textContent + '<\\/style>';
  html += '</head>';
  html += '<body>';
  html += '<button class="menu-toggle" id="menu-toggle" aria-label="Toggle menu">&#9776;</button>';
  html += '<div class="edit-toolbar" id="edit-toolbar">';
  html += '<button class="btn-secondary hidden" id="btn-cancel">取消</button>';
  html += '<span class="edit-hint" id="edit-hint"></span>';
  html += '<button class="btn-secondary hidden" id="btn-save-page">保存本页</button>';
  html += '<button class="btn-save" id="btn-download">下载全部</button>';
  html += '<button class="btn-secondary" id="btn-clear">清除已保存</button>';
  html += '<button class="btn-edit" id="btn-edit">编辑</button>';
  html += '</div>';
  html += '<div class="layout">';
  html += '<nav class="sidebar" id="sidebar">';
  html += '<div class="sidebar-header">';
  html += '<div class="sidebar-title"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>' + escH(document.querySelector('.sidebar-title').textContent) + '</div>';
  html += '<div class="sidebar-meta" id="meta-info"></div>';
  html += '</div>';
  html += '<div id="nav-tree"></div>';
  html += '<div class="sidebar-footer">Generated by GitNexus</div>';
  html += '</nav>';
  html += '<main class="content" id="content">';
  html += '<div class="empty-state"><h2>Loading…</h2></div>';
  html += '</main>';
  html += '</div>';
  html += '<script>';
  html += 'var PAGES = ' + pagesJson + ';';
  html += 'var TREE = ' + treeJson + ';';
  html += 'var META = ' + metaJson + ';';
  html += 'var JS_APP_SOURCE = ' + JSON.stringify(JS_APP_SOURCE) + ';';
  html += jsAppSource;
  html += '<\\/script>';
  html += '</body>';
  html += '</html>';
  return html;
}
`;
