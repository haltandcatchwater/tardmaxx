/* ============================================================
   Mind Map Tool — Complete Application Logic
   Vanilla JS, no dependencies, no build step.
   Open index.html in any modern browser.
   ============================================================ */

// ============================================================================
// UTILITY HELPERS
// ============================================================================

/** Generate a short unique ID (not RFC UUID, but collision-resistant enough for local use) */
function uid() {
  return 'n' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Clamp a value between min and max */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Debounce: only call fn after `ms` of quiet */
function debounce(fn, ms) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const NODE_MIN_WIDTH  = 200;
const NODE_MIN_HEIGHT = 36;
const NODE_MAX_WIDTH  = 220;  // text wraps beyond this; node grows taller instead
const NODE_PADDING_X  = 16;   // horizontal padding inside node rect
const NODE_PADDING_Y  = 10;   // vertical padding inside node rect
const NODE_IMAGE_SIZE = 48;   // max image thumbnail size within a node
const H_GAP           = 100;  // horizontal spacing between parent and child columns
const V_GAP           = 18;   // vertical spacing between adjacent sibling subtrees
const PAD_TOP         = 50;   // top padding for the layout
const PAD_LEFT        = 50;   // left padding for the layout

const ZOOM_MIN   = 0.1;
const ZOOM_MAX   = 5.0;
const ZOOM_STEP  = 0.1;
const ZOOM_WHEEL_FACTOR = 0.001;

// ============================================================================
// MIND MAP DATA MODEL
// ============================================================================

/**
 * A MindMap is a tree.  Each node stores:
 *   id, text, color (hex), image (data URL | null),
 *   fontSize, fontFamily, bold, italic,
 *   notes (string), collapsed (bool),
 *   children (array of Node).
 *
 * The `root` is the single top-level Node.  There is exactly one root.
 *
 * "Auto-layout" means positions are computed by the LayoutEngine.
 * "Manual layout" means the user has dragged a node; that node and its
 *   subtree keep their manual x/y until auto-layout is reapplied.
 */
class MindMapData {
  constructor(title) {
    this.title = title || 'Untitled';
    this.root = this._createNode('Inquire Within');
    this.autoLayoutEnabled = true;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  _createNode(text, color) {
    return {
      id: uid(),
      text: text || '',
      color: color || null,         // null = use theme default
      image: null,                  // legacy — quick-display thumbnail
      files: [],                    // [{name, type, size, data (base64), addedAt}]
      fontSize: 14,
      fontFamily: null,             // null = use theme font
      bold: false,
      italic: false,
      notes: '',
      collapsed: false,
      children: []
    };
  }

  /** Find a node by ID via DFS */
  findNode(id) {
    return this._findDFS(this.root, id);
  }
  _findDFS(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = this._findDFS(child, id);
      if (found) return found;
    }
    return null;
  }

  /** Find the parent of a node (or null if it's the root) */
  findParent(id) {
    return this._findParentDFS(this.root, id);
  }
  _findParentDFS(node, targetId) {
    for (const child of node.children) {
      if (child.id === targetId) return node;
      const found = this._findParentDFS(child, targetId);
      if (found) return found;
    }
    return null;
  }

  /** Add a child to the given parent node. Returns the new child. */
  addChild(parentId, text, color) {
    const parent = this.findNode(parentId);
    if (!parent) return null;
    const child = this._createNode(text || '', color);
    parent.children.push(child);
    this._touch();
    return child;
  }

  /** Add a sibling after the given node. Returns the new sibling. */
  addSibling(nodeId, text, color) {
    const parent = this.findParent(nodeId);
    if (!parent) return null; // root has no siblings
    const idx = parent.children.findIndex(c => c.id === nodeId);
    const sibling = this._createNode(text || '', color);
    parent.children.splice(idx + 1, 0, sibling);
    this._touch();
    return sibling;
  }

  /** Delete a node (and its subtree). Cannot delete root. */
  deleteNode(id) {
    if (id === this.root.id) return false;
    const parent = this.findParent(id);
    if (!parent) return false;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx === -1) return false;
    parent.children.splice(idx, 1);
    this._touch();
    return true;
  }

  /** Move nodeId to be a child of newParentId, at the given index */
  moveNode(nodeId, newParentId, index) {
    if (nodeId === this.root.id) return false;
    // Prevent moving a node into its own subtree
    if (this._isDescendant(nodeId, newParentId)) return false;
    const node = this.findNode(nodeId);
    if (!node) return false;
    const oldParent = this.findParent(nodeId);
    if (!oldParent) return false;

    // Remove from old parent
    const oldIdx = oldParent.children.findIndex(c => c.id === nodeId);
    oldParent.children.splice(oldIdx, 1);

    // Add to new parent
    const newParent = this.findNode(newParentId);
    if (!newParent) return false;
    if (index === undefined || index < 0 || index > newParent.children.length) {
      index = newParent.children.length;
    }
    newParent.children.splice(index, 0, node);
    this._touch();
    return true;
  }

  _isDescendant(ancestorId, nodeId) {
    const ancestor = this.findNode(ancestorId);
    if (!ancestor) return false;
    return this._findDFS(ancestor, nodeId) !== null;
  }

  /** Count total nodes (for status bar) */
  countNodes() {
    return this._countDFS(this.root);
  }
  _countDFS(node) {
    let n = 1;
    for (const child of node.children) n += this._countDFS(child);
    return n;
  }

  /** Deep-clone a node and its subtree (used for copy-paste) */
  cloneSubtree(node) {
    return JSON.parse(JSON.stringify(node));
  }

  /** Reassign all IDs in a subtree (so pasted nodes don't collide) */
  reIdSubtree(node) {
    node.id = uid();
    for (const child of node.children) this.reIdSubtree(child);
  }

  /** Serialize to JSON — strips computed props and binary file data (metadata only) */
  toJSON() {
    const cleanRoot = JSON.parse(JSON.stringify(this.root, (key, val) => {
      if (key.startsWith('_')) return undefined;
      // Strip base64 blobs from file entries (binary is in IndexedDB 'files' store)
      if (key === 'data' && typeof val === 'string' && val.startsWith('data:')) return undefined;
      return val;
    }));
    return {
      title: this.title,
      root: cleanRoot,
      autoLayoutEnabled: this.autoLayoutEnabled,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString()
    };
  }

  /** Deserialize from JSON */
  static fromJSON(json) {
    const mm = new MindMapData(json.title);
    mm.root = json.root;
    mm.autoLayoutEnabled = json.autoLayoutEnabled !== false;
    mm.createdAt = json.createdAt || new Date().toISOString();
    mm.updatedAt = json.updatedAt || new Date().toISOString();
    return mm;
  }

  _touch() {
    this.updatedAt = new Date().toISOString();
  }
}

// ============================================================================
// LAYOUT ENGINE  (Horizontal tree — left-to-right, top-down fan-out)
// ============================================================================

/**
 * Two-pass recursive tree layout.
 *
 *   Pass 1 (post-order / bottom-up):
 *     Compute each node's _subtreeH — the total vertical extent needed
 *     for its entire subtree, including all descendants with gaps.
 *
 *   Pass 2 (pre-order / top-down):
 *     Given a node's (x, yCenter), place the node, then stack its children
 *     vertically within the node's subtree extent.  Each child's yCenter
 *     is the middle of its own _subtreeH band.
 *
 * Root starts at (PAD_LEFT, yCenter) where yCenter is derived from the
 * total tree height after pass 1.
 *
 * Terminology:
 *   - subtree height: the vertical span from the top of the highest
 *     descendant to the bottom of the lowest, including this node.
 *     Think of it like measuring how tall a family portrait needs to be
 *     to fit everyone — you count all rows of descendants plus the gaps
 *     between branches.
 */
class LayoutEngine {
  /**
   * @param {MindMapData} mindmap
   * @returns {Map<string, {x:number, y:number, w:number, h:number}>}
   */
  static layout(mindmap) {
    const sizes = new Map();
    LayoutEngine._computeNodeSizes(mindmap.root, sizes);
    LayoutEngine._computeSubtreeHeights(mindmap.root, sizes);

    const positions = new Map();
    const rootH = mindmap.root._subtreeH;
    // Root's vertical center = top padding + half the total tree height
    const rootYCenter = PAD_TOP + rootH / 2;
    LayoutEngine._assignPositions(mindmap.root, PAD_LEFT, rootYCenter, sizes, positions);
    return positions;
  }

  // ---- Node measurement ----

  static _computeNodeSizes(node, sizes) {
    // Wrap text for display — deep dive nodes get wider max
    const effectiveMaxW = (node._deepDive ? 420 : NODE_MAX_WIDTH) - NODE_PADDING_X * 2;
    node._lines = LayoutEngine._wrapText(node.text || 'New Node', node, effectiveMaxW);
    sizes.set(node.id, {
      w: LayoutEngine._measureWidth(node),
      h: LayoutEngine._measureHeight(node)
    });
    for (const child of node.children) {
      LayoutEngine._computeNodeSizes(child, sizes);
    }
  }

  static _measureWidth(node) {
    const lines = node._lines || [node.text];
    const maxTextW = NODE_MAX_WIDTH - NODE_PADDING_X * 2;
    // Width = longest line, capped at max
    let longest = 0;
    for (const line of lines) {
      const lw = LayoutEngine._measureTextWidth(line, node);
      if (lw > longest) longest = lw;
    }
    let w = NODE_PADDING_X * 2 + Math.min(longest, maxTextW) + 2;
    if (node.image) w = Math.max(w, NODE_IMAGE_SIZE + NODE_PADDING_X * 2);
    return Math.max(w, NODE_MIN_WIDTH);
  }

  static _measureHeight(node) {
    const lines = node._lines || [node.text];
    const lineH = LayoutEngine._lineHeight(node);
    let h = NODE_PADDING_Y * 2 + lines.length * lineH;
    if (node.image) h += NODE_IMAGE_SIZE + 4;
    // Deep dive nodes: compact box, scrollbar for overflow
    if (node._deepDive) h = Math.min(h, 160);
    if (node._semiDeepDive) h = Math.min(h, 90);
    return Math.max(h, NODE_MIN_HEIGHT);
  }

  /** Wrapped line height */
  static _lineHeight(node) {
    return Math.round((node.fontSize || 14) * 1.5);
  }

  /** Greedy word-wrap: split text into lines that fit within maxWidth.
   *  Respects explicit newlines as hard breaks. */
  static _wrapText(text, node, maxWidth) {
    // First split by explicit newlines (hard breaks from multi-line editing)
    const paragraphs = text.split('\n');
    const allLines = [];

    for (const para of paragraphs) {
      const words = para.split(' ');
      let current = '';

      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (LayoutEngine._measureRawWidth(test, node) <= maxWidth) {
          current = test;
        } else {
          if (current) allLines.push(current);
          current = word; // single long word forces its own line
        }
      }
      if (current) allLines.push(current);
    }
    return allLines.length > 0 ? allLines : [text];
  }

  /** Measure a single string's SVG rendered width */
  static _measureRawWidth(text, node) {
    return LayoutEngine._measureTextWidth(text, node);
  }

  /** Measure text width using SVG getComputedTextLength — same renderer as visible text */
  static _measureTextWidth(text, node) {
    if (!LayoutEngine._measureSVG) {
      LayoutEngine._measureSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      LayoutEngine._measureSVG.style.position = 'absolute';
      LayoutEngine._measureSVG.style.visibility = 'hidden';
      LayoutEngine._measureSVG.style.width = '0';
      LayoutEngine._measureSVG.style.height = '0';
      document.body.appendChild(LayoutEngine._measureSVG);
      LayoutEngine._measureTextEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      LayoutEngine._measureSVG.appendChild(LayoutEngine._measureTextEl);
    }
    const el = LayoutEngine._measureTextEl;
    const fontSize = (node.fontSize || 14);
    el.setAttribute('font-size', fontSize + 'px');
    el.setAttribute('font-family', node.fontFamily ||
      getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() ||
      'Segoe UI, sans-serif');
    el.setAttribute('font-weight', node.bold ? 'bold' : 'normal');
    el.setAttribute('font-style', node.italic ? 'italic' : 'normal');
    el.textContent = text || '';
    return Math.max(el.getComputedTextLength() + 6, 30);
  }

  // ---- Pass 1: post-order subtree heights ----

  static _computeSubtreeHeights(node, sizes) {
    if (node.children.length === 0) {
      node._subtreeH = sizes.get(node.id).h;
      return;
    }
    // Sum children's subtree heights plus gaps between them
    let total = 0;
    for (let i = 0; i < node.children.length; i++) {
      LayoutEngine._computeSubtreeHeights(node.children[i], sizes);
      total += node.children[i]._subtreeH;
      if (i < node.children.length - 1) total += V_GAP;
    }
    // A parent must be at least as tall as its own node height
    node._subtreeH = Math.max(total, sizes.get(node.id).h);
  }

  // ---- Pass 2: pre-order position assignment ----

  /**
   * @param {number} x       — left edge of this node
   * @param {number} yCenter — vertical centre-line of this node
   */
  static _assignPositions(node, x, yCenter, sizes, positions) {
    const sz = sizes.get(node.id);
    positions.set(node.id, {
      x: x,
      y: yCenter - sz.h / 2,
      w: sz.w,
      h: sz.h
    });

    if (node.children.length === 0) return;

    // Children are stacked top-to-bottom inside this node's subtree band.
    // `childTop` crawls downward as we place each child.
    const bandTop = yCenter - node._subtreeH / 2;
    let childTop = bandTop;

    for (const child of node.children) {
      const childYCenter = childTop + child._subtreeH / 2;
      LayoutEngine._assignPositions(
        child,
        x + sz.w + H_GAP,
        childYCenter,
        sizes,
        positions
      );
      childTop += child._subtreeH + V_GAP;
    }
  }
}

// ============================================================================
// SVG RENDERER
// ============================================================================

/**
 * Renders the mind map tree to SVG.
 * Uses two layers inside the main <svg>:
 *   #connections-layer — bezier curves between nodes
 *   #nodes-layer        — <g> groups for each node
 */
class SVGRenderer {
  constructor(svgEl, app) {
    this.svg = svgEl;
    this.app = app;
    this.connectionsLayer = svgEl.querySelector('#connections-layer');
    this.nodesLayer = svgEl.querySelector('#nodes-layer');
    this.editingNodeId = null; // set when a node is being edited in-place
  }

  /** Full render of the mind map. Pass skipViewBox=true to preserve user's zoom/pan. */
  render(mindmap, positions, selectedId, skipViewBox) {
    // Clear
    this.connectionsLayer.innerHTML = '';
    this.nodesLayer.innerHTML = '';

    // Render recursively
    this._renderNode(mindmap.root, positions, selectedId, mindmap);

    // On fresh map with "TardMaxx", show the quote above the root
    if (mindmap.root.text === 'Inquire Within' && mindmap.root.children.length === 0) {
      const rootPos = positions.get(mindmap.root.id);
      if (rootPos) {
        const quoteEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        quoteEl.setAttribute('x', rootPos.x + rootPos.w / 2);
        quoteEl.setAttribute('y', rootPos.y - 18);
        quoteEl.setAttribute('text-anchor', 'middle');
        quoteEl.setAttribute('fill', '#999999');
        quoteEl.setAttribute('font-size', '12');
        quoteEl.setAttribute('font-style', 'italic');
        quoteEl.setAttribute('font-family', 'Segoe UI, system-ui, sans-serif');
        quoteEl.textContent = 'Let the tardmaxxing begin';
        this.nodesLayer.appendChild(quoteEl);
      }
    }

    // Only reset viewBox for structural layout changes, not edits or drags
    if (!skipViewBox) {
      this._updateViewBox(positions);
    }
  }

  _renderNode(node, positions, selectedId, mindmap) {
    if (!positions.has(node.id)) return;

    const pos = positions.get(node.id);
    const isSelected = node.id === selectedId;
    const isCollapsed = node.collapsed;

    // --- Connection from parent (if not root) ---
    const parent = mindmap.findParent(node.id);
    if (parent && positions.has(parent.id)) {
      this._drawConnection(parent, node, positions);
    }

    // --- Node group ---
    const g = this._svgEl('g', {
      class: 'mm-node-group' + (isSelected ? ' selected' : ''),
      'data-node-id': node.id
    });
    this.nodesLayer.appendChild(g);

    // Background rect — glass effect with SVG gradients
    const globalColor = (this.app && this.app.settings && this.app.settings.defaultNodeColor) || null;
    const themeColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--node-default-color').trim() || '#5b9bd5';
    const color = node.color || globalColor || themeColor;

    // Glass effect: gradient fill + shine overlay
    const defs = this.svg.querySelector('defs');
    // Helper to create a linear gradient with stops
    const makeGrad = (id, stops) => {
      let g = document.getElementById(id);
      if (g) return g;
      g = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
      g.id = id;
      g.setAttribute('x1', '0'); g.setAttribute('y1', '0');
      g.setAttribute('x2', '0'); g.setAttribute('y2', '1');
      stops.forEach(([offset, color, opacity]) => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s.setAttribute('offset', offset);
        s.setAttribute('stop-color', color);
        s.setAttribute('stop-opacity', opacity);
        g.appendChild(s);
      });
      defs.appendChild(g);
      return g;
    };

    const gradId = 'glass-' + node.id;
    makeGrad(gradId, [
      ['0%', color, '0.9'],
      ['100%', color, '0.65']
    ]);
    const rect = this._svgEl('rect', {
      class: 'mm-node-rect',
      x: pos.x, y: pos.y,
      width: pos.w, height: pos.h,
      rx: 8, ry: 8,
      fill: 'url(#' + gradId + ')'
    });
    g.appendChild(rect);

    const shineId = 'shine-' + node.id;
    makeGrad(shineId, [
      ['0%', 'white', '0.35'],
      ['30%', 'white', '0.05'],
      ['100%', 'white', '0']
    ]);
    const shine = this._svgEl('rect', {
      x: pos.x + 2, y: pos.y + 1,
      width: pos.w - 4, height: pos.h * 0.45,
      rx: 6, ry: 6,
      fill: 'url(#' + shineId + ')',
      'pointer-events': 'none'
    });
    g.appendChild(shine);

    // Image (if any)
    if (node.image) {
      const imgH = Math.min(NODE_IMAGE_SIZE, pos.h - NODE_PADDING_Y * 2 - 20);
      const imgW = imgH; // square thumbnails
      const imgX = pos.x + (pos.w - imgW) / 2;
      const imgY = pos.y + NODE_PADDING_Y;
      const image = this._svgEl('image', {
        class: 'mm-node-image',
        href: node.image,
        x: imgX, y: imgY,
        width: imgW, height: imgH,
        preserveAspectRatio: 'xMidYMid slice'
      });
      g.appendChild(image);
    }

    // Text — or in-place editor if this node is being edited
    if (this.editingNodeId === node.id) {
      const fo = this._svgEl('foreignObject', {
        x: pos.x + NODE_PADDING_X,
        y: pos.y + NODE_PADDING_Y,
        width: pos.w - NODE_PADDING_X * 2,
        height: pos.h - NODE_PADDING_Y * 2
      });
      fo.setAttribute('data-editing-fo', node.id);
      // XHTML div inside foreignObject — xmlns is REQUIRED
      const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      div.setAttribute('contenteditable', 'true');
      div.setAttribute('data-editing-node-id', node.id);
      div.style.cssText = `
        width:100%; min-height:100%; outline:none; border:none;
        font-size:${node.fontSize || 14}px;
        font-family:${node.fontFamily || 'inherit'};
        font-weight:${node.bold ? 'bold' : 'normal'};
        font-style:${node.italic ? 'italic' : 'normal'};
        color:#ffffff; background:transparent;
        text-align:center; word-wrap:break-word;
        white-space:pre-wrap; line-height:1.3;
        padding:2px 0;
      `;
      div.textContent = node.text;
      // Auto-grow: on each input, resize foreignObject and node rect
      const self = this;
      div.addEventListener('input', function() {
        const scrollH = this.scrollHeight;
        const foEl = this.parentElement;
        if (!foEl) return;
        const curH = parseFloat(foEl.getAttribute('height'));
        if (scrollH > curH + 4 || scrollH < curH - 8) {
          const newH = Math.max(scrollH + 4, NODE_MIN_HEIGHT - NODE_PADDING_Y * 2);
          foEl.setAttribute('height', newH);
          // Grow the node rect too
          const nodeGroup = foEl.closest('[data-node-id]');
          if (nodeGroup) {
            const rect = nodeGroup.querySelector('.mm-node-rect');
            if (rect) {
              const rectH = newH + NODE_PADDING_Y * 2;
              rect.setAttribute('height', rectH);
              // Update positions map so layout stays consistent
              const pos = self.app.positions.get(node.id);
              if (pos) pos.h = rectH;
            }
          }
        }
      });
      fo.appendChild(div);
      g.appendChild(fo);
      requestAnimationFrame(() => { div.focus(); _selectAll(div); });
    } else if (node._semiDeepDive) {
      // Semi-deep dive — show summary with fade, expandable to full markdown
      const maxH = Math.min(pos.h, 90);
      // Text portion
      const fo = this._svgEl('foreignObject', {
        x: pos.x + NODE_PADDING_X,
        y: pos.y + NODE_PADDING_Y,
        width: pos.w - NODE_PADDING_X * 2,
        height: maxH - NODE_PADDING_Y * 2
      });
      const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      div.style.cssText = `
        width:100%; height:100%; overflow:hidden; position:relative;
        font-size:${node.fontSize || 13}px;
        font-family:${node.fontFamily || 'inherit'};
        color:#ffffff; text-align:left; line-height:1.4;
        word-wrap:break-word; white-space:pre-wrap;
      `;
      div.textContent = node.notes || node.text;
      // Fade overlay at bottom
      const fade = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      fade.style.cssText = `
        position:absolute; bottom:0; left:0; right:0; height:30px;
        background:linear-gradient(transparent, ${color});
        pointer-events:none;
      `;
      div.appendChild(fade);
      // Expand button
      const expandBtn = document.createElementNS('http://www.w3.org/1999/xhtml', 'button');
      expandBtn.textContent = 'Read more';
      expandBtn.style.cssText = `
        position:absolute; bottom:2px; right:4px;
        background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.25);
        border-radius:3px; padding:1px 5px; font-size:8px; cursor:pointer;
        font-family:inherit; z-index:1;
      `;
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const fullText = node.notes || node.text;
        const panel = document.getElementById('dive-panel');
        const body = document.getElementById('dive-panel-body');
        document.getElementById('dive-panel-title').textContent = node.text;
        body.innerHTML = '<div style="max-width:700px;margin:0 auto;">' +
          fullText.split('\n').map(line =>
            line.startsWith('#') ? `<h3>${line.replace(/^#+\s*/, '')}</h3>` :
            line.startsWith('- ') ? `<li>${line.slice(2)}</li>` :
            line.trim() === '' ? '<br>' : `<p>${line}</p>`
          ).join('') + '</div>';
        panel.classList.add('open');
      });
      div.appendChild(expandBtn);
      fo.appendChild(div);
      g.appendChild(fo);
    } else if (node._deepDive) {
      // Deep dive node — scrollable prose box, left-aligned
      const maxH = Math.min(pos.h, 300);
      const fo = this._svgEl('foreignObject', {
        x: pos.x + NODE_PADDING_X,
        y: pos.y + NODE_PADDING_Y,
        width: pos.w - NODE_PADDING_X * 2,
        height: maxH - NODE_PADDING_Y * 2
      });
      const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      div.style.cssText = `
        width:100%; height:100%; overflow-y:auto;
        font-size:${node.fontSize || 13}px;
        font-family:${node.fontFamily || 'inherit'};
        color:#ffffff; text-align:left; line-height:1.5;
        padding-right:4px; word-wrap:break-word; white-space:pre-wrap;
      `;
      div.textContent = node.text;
      fo.appendChild(div);
      g.appendChild(fo);
    } else {
      const isEmpty = !node.text || node.text.trim() === '';
      const lines = isEmpty ? [''] : (node._lines || [node.text]);
      const lineH = LayoutEngine._lineHeight(node);
      const totalTextH = isEmpty ? lineH : lines.length * lineH;
      const textTopY = pos.y + (pos.h - totalTextH) / 2;

      const textEl = this._svgEl('text', {
        class: 'mm-node-text',
        x: pos.x + pos.w / 2,
        y: textTopY,
        style: `font-size:${node.fontSize || 14}px;` +
          (node.fontFamily ? `font-family:${node.fontFamily};` : '') +
          (node.bold ? 'font-weight:bold;' : '') +
          (node.italic ? 'font-style:italic;' : '')
      });
      if (isEmpty) {
        const tspan = this._svgEl('tspan', {
          x: pos.x + pos.w / 2,
          dy: '1.05em',
          fill: 'rgba(255,255,255,0.4)',
          'font-style': 'italic'
        });
        tspan.textContent = 'Type something...';
        textEl.appendChild(tspan);
      } else {
        lines.forEach((line, i) => {
          const tspan = this._svgEl('tspan', {
            x: pos.x + pos.w / 2,
            dy: i === 0 ? '1.05em' : '1.5em'
          });
          tspan.textContent = line;
          textEl.appendChild(tspan);
        });
      }
      g.appendChild(textEl);
    }

    // File attachment badge (if node has files)
    if (node.files && node.files.length > 0) {
      const badgeR = 8;
      const badgeX = pos.x + pos.w - badgeR;
      const badgeY = pos.y + badgeR;
      const badge = this._svgEl('circle', {
        cx: badgeX, cy: badgeY, r: badgeR,
        fill: '#f0a040', stroke: '#c08020', 'stroke-width': '1'
      });
      const badgeText = this._svgEl('text', {
        x: badgeX, y: badgeY + 1,
        fill: '#ffffff', 'font-size': '8', 'font-weight': 'bold',
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'pointer-events': 'none'
      });
      badgeText.textContent = node.files.length > 9 ? '9+' : String(node.files.length);
      g.appendChild(badge);
      g.appendChild(badgeText);
    }

    // Unified expand/collapse dot — every node gets one
    {
      const btnR = 3.2, gap = 2;
      const btnX = pos.x + pos.w + gap + btnR;
      const btnY = pos.y + pos.h / 2;
      const hasKids = node.children.length > 0;
      const action = hasKids ? 'toggle-collapse' : 'ai-expand';

      const btn = this._svgEl('circle', {
        class: 'mm-collapse-btn',
        cx: btnX, cy: btnY, r: btnR,
        fill: color,
        'data-action': action,
        'data-node-id': node.id
      });
      const tip = this._svgEl('title', {});
      tip.textContent = hasKids ? (isCollapsed ? 'Expand' : 'Collapse') : 'AI Expand';
      btn.appendChild(tip);
      // SVG path arrow — pixel-perfect, no font centering issues
      const arrow = this._svgEl('path', {
        d: hasKids
          ? (isCollapsed
            ? 'M1,-1.5 L-1,0 L1,1.5'    // < (collapsed — expand)
            : 'M-1,-1.5 L1,0 L-1,1.5')   // > (expanded — collapse)
          : 'M1,-1.5 L-1,0 L1,1.5',      // < (leaf — AI expand)
        stroke: '#ffffff',
        'stroke-width': '1',
        fill: 'none',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'data-action': action,
        'data-node-id': node.id
      });
      arrow.setAttribute('transform', `translate(${btnX},${btnY})`);
      g.appendChild(btn);
      g.appendChild(arrow);
    }

    // Deep dive — diving mask + ring, both light up together
    {
      const cx = pos.x + pos.w - 12;
      const cy = pos.y + 12;
      const wrap = this._svgEl('g', {
        class: 'mm-dive-wrap',
        'data-action': 'deep-dive',
        'data-node-id': node.id
      });
      const title = this._svgEl('title', {});
      title.textContent = 'Deep Dive';
      wrap.appendChild(title);
      // Spinning ring — wrapped in <g> so rotation is around local origin
      const ringWrap = this._svgEl('g', {
        transform: `translate(${cx},${cy})`
      });
      ringWrap.classList.add('mm-dive-ring');
      const ring = this._svgEl('circle', {
        cx: 0, cy: 0, r: '7',
        fill: 'none', stroke: 'rgba(255,255,255,0.3)', 'stroke-width': '1.2'
      });
      ringWrap.appendChild(ring);
      wrap.appendChild(ringWrap);
      // Diving mask
      const mask = this._svgEl('g', {
        transform: `translate(${cx - 7},${cy - 7}) scale(0.22)`
      });
      const frame = this._svgEl('path', {
        d: 'M 10 24 C 10 16, 54 16, 54 24 L 54 36 C 54 48, 44 50, 38 50 C 35 50, 34 44, 32 44 C 30 44, 29 50, 26 50 C 20 50, 10 48, 10 36 Z',
        fill: 'rgba(255,255,255,0.25)', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': '2'
      });
      const strap = this._svgEl('path', {
        d: 'M 8 28 C 4 12, 60 12, 56 28',
        fill: 'none', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': '2.5', 'stroke-linecap': 'round'
      });
      // Bubbles below mask — animate upward when thinking
      const bubbles = this._svgEl('g', { class: 'mm-dive-bubbles' });
      [{dx:-4, dy:8, r:1.2, d:0}, {dx:2, dy:12, r:0.8, d:0.3}, {dx:-1, dy:16, r:1.5, d:0.6}].forEach(b => {
        const bubble = this._svgEl('circle', {
          cx: cx + b.dx, cy: cy + b.dy, r: b.r,
          fill: 'none', stroke: 'rgba(255,255,255,0.25)', 'stroke-width': '0.8'
        });
        bubble.style.animationDelay = b.d + 's';
        bubbles.appendChild(bubble);
      });
      mask.appendChild(strap);
      mask.appendChild(frame);
      wrap.appendChild(mask);
      wrap.appendChild(bubbles);
      g.appendChild(wrap);
    }

    // Render children (if not collapsed)
    if (!isCollapsed) {
      for (const child of node.children) {
        this._renderNode(child, positions, selectedId, mindmap);
      }
    }
  }

  /** Count all descendants (children + grandchildren + ...) of a node */
  _countDescendants(node) {
    let count = 0;
    for (const child of node.children) {
      count += 1 + this._countDescendants(child);
    }
    return count;
  }

  /** Draw a cubic bezier connection from parent right edge to child left edge */
  _drawConnection(parent, child, positions) {
    const pp = positions.get(parent.id);
    const cp = positions.get(child.id);
    if (!pp || !cp) return;

    const x1 = pp.x + pp.w;
    const y1 = pp.y + pp.h / 2;
    const x2 = cp.x;
    const y2 = cp.y + cp.h / 2;

    const dx = Math.abs(x2 - x1) * 0.45;
    const s = (this.app && this.app.settings) || {};
    const connColor = s.connectorColor || null;
    const connWidth = s.connectorWidth || 2;
    let style = '';
    if (connColor) style += `stroke:${connColor};`;
    if (connWidth !== 2) style += `stroke-width:${connWidth};`;
    const path = this._svgEl('path', {
      class: 'mm-connection',
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      style: style || ''
    });
    this.connectionsLayer.appendChild(path);
  }

  _updateViewBox(positions) {
    if (positions.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [_, pos] of positions) {
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + pos.w > maxX) maxX = pos.x + pos.w;
      if (pos.y + pos.h > maxY) maxY = pos.y + pos.h;
    }
    const pad = 60;
    const vbX = minX - pad;
    const vbY = minY - pad;
    const vbW = maxX - minX + pad * 2;
    const vbH = maxY - minY + pad * 2;

    // Only update viewBox if it doesn't match current (prevents jumpy re-renders)
    const currentVB = this.svg.getAttribute('viewBox');
    const newVB = `${vbX} ${vbY} ${vbW} ${vbH}`;
    if (currentVB !== newVB) {
      this.svg.setAttribute('viewBox', newVB);
    }
  }

  /** Set viewBox explicitly (for zoom/pan) */
  setViewBox(x, y, w, h) {
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
  getViewBox() {
    const vb = this.svg.getAttribute('viewBox');
    if (!vb) return { x: 0, y: 0, w: 1200, h: 800 };
    const parts = vb.split(/\s+/).map(Number);
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  /** Get the SVG element's screen bounding rect */
  getScreenRect() {
    return this.svg.getBoundingClientRect();
  }

  /** Convert screen coordinates to SVG coordinates using current viewBox */
  screenToSVG(screenX, screenY) {
    const rect = this.getScreenRect();
    const vb = this.getViewBox();
    const scaleX = vb.w / rect.width;
    const scaleY = vb.h / rect.height;
    return {
      x: vb.x + (screenX - rect.left) * scaleX,
      y: vb.y + (screenY - rect.top) * scaleY
    };
  }

  /** Find which node (if any) is at the given SVG coordinates */
  hitTest(svgX, svgY, positions) {
    // Iterate in reverse (nodes rendered later are on top) — but our render is
    // pre-order, so children come after parents.  We want the deepest/front-most node.
    // Build a list of all positioned nodes and check bounding boxes.
    let best = null;
    let bestArea = Infinity;
    for (const [id, pos] of positions) {
      if (svgX >= pos.x && svgX <= pos.x + pos.w &&
          svgY >= pos.y && svgY <= pos.y + pos.h) {
        const area = pos.w * pos.h;
        if (area < bestArea) { // pick the smallest (deepest) node containing the point
          best = id;
          bestArea = area;
        }
      }
    }
    return best;
  }

  /** Helper: create an SVG element with attributes */
  _svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') { el.setAttribute('class', v); }
      else if (k === 'style') { el.setAttribute('style', v); }
      else if (k === 'textContent') { /* handled separately */ }
      else if (k.startsWith('data-')) { el.setAttribute(k, v); }
      else { el.setAttribute(k, v); }
    }
    return el;
  }

  /** Serialize the SVG to a string (for export) */
  serialize() {
    // Clone the SVG so we can modify without affecting the display
    const clone = this.svg.cloneNode(true);
    // Remove any non-content elements if needed
    // Set a fixed, clean viewBox
    const vb = this.getViewBox();
    clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    clone.setAttribute('width', vb.w);
    clone.setAttribute('height', vb.h);
    // Inline all computed styles
    this._inlineStyles(clone);
    return new XMLSerializer().serializeToString(clone);
  }

  /** Recursively inline computed styles into style attributes (needed for export) */
  _inlineStyles(el) {
    if (el.nodeType !== 1) return;
    const computed = getComputedStyle(el);
    // Only copy relevant properties
    const props = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size',
      'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'filter', 'opacity'];
    let styleStr = '';
    for (const prop of props) {
      const val = computed.getPropertyValue(prop);
      if (val && val !== 'auto' && val !== 'normal') {
        styleStr += `${prop}:${val};`;
      }
    }
    if (styleStr) el.setAttribute('style', styleStr);
    for (const child of el.children) this._inlineStyles(child);
  }
}

// ============================================================================
// INTERACTION MANAGER  (mouse, touch, keyboard)
// ============================================================================

class InteractionManager {
  constructor(app) {
    this.app = app;

    // Pan state
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.panStartVB = { x: 0, y: 0 };

    // Drag state
    this.isDragging = false;
    this.dragNodeId = null;
    this.dragStartSVG = { x: 0, y: 0 };
    this.dragOriginalPositions = null; // snapshot of positions before drag

    // Track whether mouse moved (to distinguish click from drag)
    this.mouseMoved = false;

    this._bindEvents();
  }

  _bindEvents() {
    const svg = this.app.renderer.svg;

    // --- Mouse ---
    svg.addEventListener('mousedown', this._onMouseDown.bind(this));
    window.addEventListener('mousemove', this._onMouseMove.bind(this));
    window.addEventListener('mouseup', this._onMouseUp.bind(this));

    // --- Wheel (zoom) ---
    svg.addEventListener('wheel', this._onWheel.bind(this), { passive: false });

    // --- Double-click (edit) ---
    svg.addEventListener('dblclick', this._onDblClick.bind(this));

    // --- Context menu ---
    svg.addEventListener('contextmenu', this._onContextMenu.bind(this));

    // --- Touch ---
    svg.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: false });
    svg.addEventListener('touchmove', this._onTouchMove.bind(this), { passive: false });
    svg.addEventListener('touchend', this._onTouchEnd.bind(this));
    svg.addEventListener('touchcancel', this._onTouchEnd.bind(this));

    // --- Keyboard ---
    window.addEventListener('keydown', this._onKeyDown.bind(this));

    // --- Paste image ---
    window.addEventListener('paste', this._onPaste.bind(this));

    // --- Global click to close menus ---
    window.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) {
        this.app.hideContextMenu();
      }
    });

    // --- Resize ---
    window.addEventListener('resize', debounce(() => this.app.fitToView(), 200));
  }

  // ---- Mouse Handlers ----

  _onMouseDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this._startPan(e);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // DOM-based hit detection — walk up from e.target to find a node group.
    // More reliable than coordinate math when layouts are deep/wide.
    const nodeEl = e.target.closest('[data-node-id]');
    const domHitId = nodeEl ? nodeEl.getAttribute('data-node-id') : null;

    // Collapse button
    const collapseEl = e.target.closest('[data-action="toggle-collapse"]');
    if (collapseEl) {
      this.app.toggleCollapse(collapseEl.dataset.nodeId);
      return;
    }
    // Deep dive (scuba) icon
    const diveEl = e.target.closest('[data-action="deep-dive"]');
    if (diveEl) {
      e.preventDefault();
      e.stopPropagation();
      this.app._startDeepDive(diveEl.dataset.nodeId);
      return;
    }

    // AI expand sparkle — walk up to find the data-action attribute
    const sparkleEl = e.target.closest('[data-action="ai-expand"]');
    if (sparkleEl) {
      const nodeId = sparkleEl.dataset.nodeId;
      e.preventDefault();
      e.stopPropagation();
      this.app._aiExpandLeafNode(nodeId);
      return;
    }

    // Prefer DOM hit over coordinate hit — DOM knows exactly what was clicked
    const svgPos = this.app.renderer.screenToSVG(e.clientX, e.clientY);
    const coordHitId = this.app.renderer.hitTest(svgPos.x, svgPos.y, this.app.positions);
    const hitId = domHitId || coordHitId;

    if (hitId && this.app.mindmap.findNode(hitId)) {
      this.app.selectNode(hitId);
      // Don't start drag on initial placeholder root — it auto-edits on click
      const isPlaceholderRoot = hitId === this.app.mindmap.root.id &&
        this.app.mindmap.root.text === 'Inquire Within' &&
        this.app.mindmap.root.children.length === 0;
      if (!isPlaceholderRoot) {
        this._startDrag(e, hitId);
      }
    } else {
      this.app.selectNode(null);
      this._startPan(e);
    }
  }

  _onMouseMove(e) {
    if (this.isPanning) {
      this.mouseMoved = true;
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      const rect = this.app.renderer.getScreenRect();
      const vb = this.app.renderer.getViewBox();
      const scaleX = vb.w / rect.width;
      const scaleY = vb.h / rect.height;
      this.app.renderer.setViewBox(
        this.panStartVB.x - dx * scaleX,
        this.panStartVB.y - dy * scaleY,
        vb.w, vb.h
      );
      this.app._updateZoomStatus();
      return;
    }
    if (this.isDragging) {
      this.mouseMoved = true;
      const svgPos = this.app.renderer.screenToSVG(e.clientX, e.clientY);
      // Incremental delta from the previous frame — NOT total from drag start
      const dx = svgPos.x - this._lastMouseSVG.x;
      const dy = svgPos.y - this._lastMouseSVG.y;
      this._lastMouseSVG = { x: svgPos.x, y: svgPos.y };
      if (dx !== 0 || dy !== 0) {
        this._applyDragOffset(this.dragNodeId, dx, dy);
      }
      return;
    }
  }

  _onMouseUp(e) {
    if (this.isDragging && this.mouseMoved) {
      this._endDrag();
    }
    this.isPanning = false;
    this.isDragging = false;
    this.mouseMoved = false;
  }

  // ---- Pan ----

  _startPan(e) {
    this.isPanning = true;
    this.panStart = { x: e.clientX, y: e.clientY };
    const vb = this.app.renderer.getViewBox();
    this.panStartVB = { x: vb.x, y: vb.y };
    this.mouseMoved = false;
  }

  // ---- Drag ----

  _startDrag(e, nodeId) {
    if (nodeId === this.app.mindmap.root.id) return; // can't drag root
    this.isDragging = true;
    this.dragNodeId = nodeId;
    this.mouseMoved = false;
    const svgPos = this.app.renderer.screenToSVG(e.clientX, e.clientY);
    this.dragStartSVG = { x: svgPos.x, y: svgPos.y };
    // Track last mouse position for per-frame incremental deltas
    this._lastMouseSVG = { x: svgPos.x, y: svgPos.y };

    // Snapshot positions for all nodes in the dragged subtree
    this.dragOriginalPositions = new Map();
    const node = this.app.mindmap.findNode(nodeId);
    this._snapshotPositions(node, this.app.positions);

    // Record the drag origin — node is constrained to MAX_DRAG radius from here
    const pos = this.app.positions.get(nodeId);
    this.dragOriginCenter = { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 };

    // Disable auto-layout when user manually drags
    this.app.mindmap.autoLayoutEnabled = false;
    this.app._updateModified();
  }

  _snapshotPositions(node, positions) {
    if (positions.has(node.id)) {
      const p = positions.get(node.id);
      this.dragOriginalPositions.set(node.id, { x: p.x, y: p.y });
    }
    for (const child of node.children) this._snapshotPositions(child, positions);
  }

  _applyDragOffset(nodeId, dx, dy) {
    const node = this.app.mindmap.findNode(nodeId);
    if (!node) return;

    const MAX_DRAG = 2000; // px in SVG coords — plenty of room, but prevents losing nodes

    // Where would the node center land after applying this frame's dx,dy?
    const pos = this.app.positions.get(nodeId);
    const proposedCX = pos.x + pos.w / 2 + dx;
    const proposedCY = pos.y + pos.h / 2 + dy;

    // Clamp to a box ±MAX_DRAG around the drag-start origin
    const clampedCX = clamp(proposedCX,
      this.dragOriginCenter.x - MAX_DRAG, this.dragOriginCenter.x + MAX_DRAG);
    const clampedCY = clamp(proposedCY,
      this.dragOriginCenter.y - MAX_DRAG, this.dragOriginCenter.y + MAX_DRAG);

    // Convert back to a delta from the current position
    const actualDX = clampedCX - (pos.x + pos.w / 2);
    const actualDY = clampedCY - (pos.y + pos.h / 2);

    this._shiftNode(node, actualDX, actualDY);
    this.app.renderer.render(this.app.mindmap, this.app.positions, this.app.selectedNodeId, true);
  }

  _shiftNode(node, dx, dy) {
    const pos = this.app.positions.get(node.id);
    if (pos) { pos.x += dx; pos.y += dy; }
    for (const child of node.children) this._shiftNode(child, dx, dy);
  }

  _endDrag() {
    if (this.dragNodeId) {
      // Snap back to original positions if auto-layout was on?
      // No — user dragged, so manual mode.  Keep positions.
      this.app._pushUndo();
      this.dragNodeId = null;
      this.dragOriginalPositions = null;
    }
  }

  // ---- Wheel Zoom ----

  _onWheel(e) {
    e.preventDefault();
    const vb = this.app.renderer.getViewBox();
    const factor = e.deltaY > 0 ? (1 + ZOOM_WHEEL_FACTOR * Math.abs(e.deltaY)) :
      (1 - ZOOM_WHEEL_FACTOR * Math.abs(e.deltaY));

    const newW = clamp(vb.w * factor, 100, 50000);
    const newH = clamp(vb.h * factor, 100, 50000);
    if (newW === vb.w && newH === vb.h) return;

    // Zoom toward mouse position
    const rect = this.app.renderer.getScreenRect();
    const mouseX = (e.clientX - rect.left) / rect.width;
    const mouseY = (e.clientY - rect.top) / rect.height;

    const newX = vb.x + vb.w * mouseX - newW * mouseX;
    const newY = vb.y + vb.h * mouseY - newH * mouseY;

    this.app.renderer.setViewBox(newX, newY, newW, newH);
    this.app._updateZoomStatus();
  }

  // ---- Double-click (inline edit) ----

  _onDblClick(e) {
    // DOM-first: walk up from the clicked element to find the enclosing node group
    const nodeEl = e.target.closest('[data-node-id]');
    const domHitId = nodeEl ? nodeEl.getAttribute('data-node-id') : null;
    // Coordinate fallback
    const svgPos = this.app.renderer.screenToSVG(e.clientX, e.clientY);
    const coordHitId = this.app.renderer.hitTest(svgPos.x, svgPos.y, this.app.positions);
    const hitId = domHitId || coordHitId;
    if (hitId) {
      this.app.startInlineEdit(hitId);
    }
  }

  // ---- Context Menu ----

  _onContextMenu(e) {
    e.preventDefault();
    const svgPos = this.app.renderer.screenToSVG(e.clientX, e.clientY);
    const hitId = this.app.renderer.hitTest(svgPos.x, svgPos.y, this.app.positions);
    if (hitId) this.app.selectNode(hitId);
    this.app.showContextMenu(e.clientX, e.clientY, hitId);
  }

  // ---- Touch ----

  _onTouchStart(e) {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const svgPos = this.app.renderer.screenToSVG(t.clientX, t.clientY);
      const hitId = this.app.renderer.hitTest(svgPos.x, svgPos.y, this.app.positions);
      if (hitId) {
        this.app.selectNode(hitId);
        this._startDrag({ clientX: t.clientX, clientY: t.clientY }, hitId);
      } else {
        this._startPan({ clientX: t.clientX, clientY: t.clientY });
      }
      e.preventDefault();
    } else if (e.touches.length === 2) {
      // Pinch-to-zoom
      this.isPanning = false;
      this.isDragging = false;
      this._pinchStart = this._getPinchDist(e.touches);
      this._pinchStartVB = this.app.renderer.getViewBox();
      e.preventDefault();
    }
  }

  _onTouchMove(e) {
    if (e.touches.length === 1 && this.isDragging) {
      const t = e.touches[0];
      this._onMouseMove({ clientX: t.clientX, clientY: t.clientY });
      e.preventDefault();
    } else if (e.touches.length === 1 && this.isPanning) {
      const t = e.touches[0];
      this._onMouseMove({ clientX: t.clientX, clientY: t.clientY });
      e.preventDefault();
    } else if (e.touches.length === 2 && this._pinchStart) {
      const dist = this._getPinchDist(e.touches);
      const scale = this._pinchStart / dist;
      const vb = this._pinchStartVB;
      const newW = clamp(vb.w * scale, 100, 50000);
      const newH = clamp(vb.h * scale, 100, 50000);
      this.app.renderer.setViewBox(vb.x, vb.y, newW, newH);
      this.app._updateZoomStatus();
      e.preventDefault();
    }
  }

  _onTouchEnd(e) {
    if (this.isDragging) this._endDrag();
    this.isPanning = false;
    this.isDragging = false;
    this._pinchStart = null;
  }

  _getPinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---- Keyboard ----

  _onKeyDown(e) {
    const app = this.app;
    // Don't trap shortcuts when editing text (input, textarea, or contenteditable)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === 'z') { e.preventDefault(); app.undo(); }
    else if (ctrl && e.key === 'y') { e.preventDefault(); app.redo(); }
    else if (ctrl && e.key === 'n') { e.preventDefault(); app.newMindMap(); }
    else if (ctrl && e.key === 's') { e.preventDefault(); app.saveToStorage(); }
    else if (ctrl && e.key === 'o') { e.preventDefault(); app.openFromFile(); }
    else if (ctrl && e.key === 'l') { e.preventDefault(); app.autoLayout(); }
    else if (ctrl && e.key === '0') { e.preventDefault(); app.fitToView(); }
    else if (ctrl && e.key === 'x') { e.preventDefault(); app.cutNode(); }
    else if (ctrl && e.key === 'c') { e.preventDefault(); app.copyNode(); }
    else if (ctrl && e.key === 'v') { e.preventDefault(); app.pasteNode(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!app.selectedNodeId) {
        app.selectNode(app.mindmap.root.id);
      }
      app.addChildNode();
    }
    else if (e.key === 'Enter') { e.preventDefault(); app.addSiblingNode(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); app.deleteSelectedNode(); }
    else if (e.key === 'F2') { e.preventDefault(); app.startInlineEdit(app.selectedNodeId); }
    else if (e.key === 'Escape') { app.selectNode(null); app.hideContextMenu(); }
  }

  // ---- Paste Image ----

  _onPaste(e) {
    if (!this.app.selectedNodeId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          const node = this.app.mindmap.findNode(this.app.selectedNodeId);
          if (node) {
            this.app._pushUndo();
            node.image = reader.result;
            this.app._updateAll();
            this.app.toast('Image pasted onto node', 'success');
          }
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  }
}

// ============================================================================
// STORAGE MANAGER  (IndexedDB)
// ============================================================================

class StorageManager {
  constructor() {
    this.dbName = 'MindMapDB';
    this.dbVersion = 2;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.dbVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('mindmaps')) {
          db.createObjectStore('mindmaps', { keyPath: 'title' });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        resolve(this.db);
      };
      req.onerror = () => reject(new Error('IndexedDB unavailable'));
      req.onblocked = () => reject(new Error('Close other mindmap tabs and refresh'));
    });
  }

  // ---- Mind map records ----

  async save(mindmap) {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('mindmaps', 'readwrite');
      const store = tx.objectStore('mindmaps');
      const record = {
        title: mindmap.title,
        data: mindmap.toJSON(),
        savedAt: new Date().toISOString()
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async load(title) {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('mindmaps', 'readonly');
      const store = tx.objectStore('mindmaps');
      const req = store.get(title);
      req.onsuccess = () => {
        if (req.result) {
          resolve(MindMapData.fromJSON(req.result.data));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async listAll() {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('mindmaps', 'readonly');
      const store = tx.objectStore('mindmaps');
      const req = store.getAll();
      req.onsuccess = () => {
        resolve(req.result.map(r => ({
          title: r.title,
          savedAt: r.savedAt,
          nodeCount: r.data.root ? '?' : 0
        })));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async delete(title) {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('mindmaps', 'readwrite');
      const store = tx.objectStore('mindmaps');
      store.delete(title);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

}

// ============================================================================
// EXPORT MANAGER
// ============================================================================

class ExportManager {
  constructor(app) { this.app = app; }

  /** Export the current mind map as a PNG image and trigger download */
  async exportPNG() {
    const svgString = this.app.renderer.serialize();
    const canvas = await this._svgToCanvas(svgString, 2); // 2x for high-DPI
    canvas.toBlob((blob) => {
      this._downloadBlob(blob, this.app.mindmap.title + '.png');
      this.app.toast('Exported as PNG', 'success');
    }, 'image/png');
  }

  /** Export as JPEG */
  async exportJPEG(quality = 0.92) {
    const svgString = this.app.renderer.serialize();
    const canvas = await this._svgToCanvas(svgString, 2);
    canvas.toBlob((blob) => {
      this._downloadBlob(blob, this.app.mindmap.title + '.jpg');
      this.app.toast('Exported as JPEG', 'success');
    }, 'image/jpeg', quality);
  }

  /** Export as PDF using browser print */
  async exportPDF() {
    // Strategy: open a new window with just the SVG rendered at full size,
    // then trigger print (user can save as PDF).
    const vb = this.app.renderer.getViewBox();
    const svgString = this.app.renderer.serialize();

    const printWindow = window.open('', '_blank', 'width=1200,height=800');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head><title>${this.app.mindmap.title}</title>
      <style>
        @page { size: auto; margin: 10mm; }
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        svg { max-width: 100%; height: auto; }
        @media print { body { margin: 0; } }
      </style>
      </head>
      <body>${svgString}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    // Delay print to allow rendering
    setTimeout(() => {
      printWindow.print();
      this.app.toast('PDF export ready — use browser Print > Save as PDF', 'success');
    }, 300);
  }

  /** Convert SVG string to an HTML Canvas (for raster export) */
  async _svgToCanvas(svgString, scale) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        // White background (SVG might be transparent)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to render SVG'));
      };
      img.src = url;
    });
  }

  /** Export as Markdown — hierarchical outline with notes and file references */
  exportMarkdown() {
    const mm = this.app.mindmap;
    let md = '# ' + mm.title + '\n\n';
    md += this._nodeToMarkdown(mm.root, 2);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    this._downloadBlob(blob, mm.title.replace(/[^a-zA-Z0-9 _-]/g, '') + '.md');
    this.app.toast('Exported as Markdown', 'success');
  }

  _nodeToMarkdown(node, depth) {
    const prefix = '#'.repeat(Math.min(depth, 6));
    let md = prefix + ' ' + node.text + '\n';
    if (node.notes) {
      md += '\n' + node.notes + '\n';
    }
    if (node.files && node.files.length > 0) {
      md += '\n';
      for (const f of node.files) {
        md += '- 📎 **' + f.name + '**';
        if (f.path) md += ' — `' + f.path + '`';
        md += '\n';
      }
    }
    md += '\n';
    for (const child of node.children) {
      md += this._nodeToMarkdown(child, depth + 1);
    }
    return md;
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// IMPORT MANAGER
// ============================================================================

class ImportManager {
  constructor(app) { this.app = app; }

  /**
   * Parse a file (CSV or JSON) and return a new MindMapData.
   * CSV format:
   *   id,parent_id,text,color
   *   (first row is header; root is the row with empty parent_id)
   *
   * JSON format: same as MindMapData.toJSON() output.
   */
  async importFile(file) {
    const text = await file.text();
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'json') {
      return this._importJSON(text);
    } else if (ext === 'csv') {
      return this._importCSV(text);
    } else {
      throw new Error('Unsupported file format. Use .json or .csv');
    }
  }

  _importJSON(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) {
      throw new Error('Invalid JSON: ' + e.message);
    }
    if (!json.root) throw new Error('JSON must have a "root" property');
    return MindMapData.fromJSON(json);
  }

  _importCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV must have a header row plus data');

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idIdx = headers.indexOf('id');
    const parentIdx = headers.indexOf('parent_id');
    const textIdx = headers.indexOf('text');
    const colorIdx = headers.indexOf('color');

    if (idIdx === -1 || parentIdx === -1 || textIdx === -1) {
      throw new Error('CSV must have "id", "parent_id", and "text" columns');
    }

    // Parse rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this._parseCSVLine(lines[i]);
      if (cols.length < headers.length) continue;
      rows.push({
        id: cols[idIdx].trim(),
        parentId: cols[parentIdx].trim(),
        text: cols[textIdx].trim(),
        color: colorIdx !== -1 ? cols[colorIdx].trim() : null
      });
    }

    // Build tree
    const nodeMap = new Map();
    let rootRow = null;

    for (const row of rows) {
      const node = {
        id: uid(), // generate new IDs to avoid conflicts
        text: row.text,
        color: row.color || null,
        image: null,
        fontSize: 14,
        fontFamily: null,
        bold: false,
        italic: false,
        notes: '',
        collapsed: false,
        children: []
      };
      nodeMap.set(row.id, node);
      if (!row.parentId) rootRow = row;
    }

    if (!rootRow) throw new Error('CSV must have one row with empty parent_id (the root)');

    // Link children
    for (const row of rows) {
      if (!row.parentId) continue;
      const child = nodeMap.get(row.id);
      const parent = nodeMap.get(row.parentId);
      if (child && parent) {
        parent.children.push(child);
      }
    }

    const mm = new MindMapData('Imported from CSV');
    mm.root = nodeMap.get(rootRow.id);
    return mm;
  }

  _parseCSVLine(line) {
    // Simple CSV parser: split by comma, respecting quotes
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current);
    return cols;
  }
}

// ============================================================================
// THEME MANAGER
// ============================================================================

class ThemeManager {
  static setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('mindmap-theme', name);
    const select = document.getElementById('theme-select');
    if (select) select.value = name;
  }

  static loadTheme() {
    const saved = localStorage.getItem('mindmap-theme') || 'light';
    ThemeManager.setTheme(saved);
  }

  static getThemes() {
    return ['light', 'dark', 'forest', 'ocean', 'sunset'];
  }
}

/** Select all text in a contenteditable element */
function _selectAll(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ============================================================================
// APP CONTROLLER
// ============================================================================

class App {
  constructor() {
    // Core state
    this.mindmap = new MindMapData('Untitled');
    this.positions = new Map();         // id -> {x, y, w, h}
    this.selectedNodeId = null;
    this.clipboard = null;              // deep clone of a node subtree (for cut/copy/paste)
    this.clipboardCut = false;          // true = cut, false = copy

    // Undo stack
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndo = 100;

    // Global visual settings (persisted to localStorage)
    this.settings = this._loadSettings();

    // Managers
    this.renderer = new SVGRenderer(document.getElementById('mindmap-svg'), this);
    this.storage = new StorageManager();
    this.exporter = new ExportManager(this);
    this.importer = new ImportManager(this);
    this.interactions = new InteractionManager(this);

    // UI refs
    this.contextMenu = document.getElementById('context-menu');
    this.sidebar = document.getElementById('sidebar');
    this.inlineEditor = document.getElementById('inline-editor');
    this.inlineInput = document.getElementById('inline-editor-input');
    this.modalOverlay = document.getElementById('modal-overlay');

    this._initUI();
    this._pushUndo(); // initial state baseline (not a user change)
    this._updateAll();
    this.fitToView();
    this._clearModified();
    // Show walkthrough on first visit
    if (!localStorage.getItem('mindmap-walkthrough-done')) {
      setTimeout(() => this._showWalkthrough(), 500);
    }

    // Auto-edit root — "TardMaxx" with blinking cursor, clears on first input
    setTimeout(() => {
      this.startInlineEdit(this.mindmap.root.id);
      const rootId = this.mindmap.root.id;
      setTimeout(() => {
        const div = document.querySelector('[data-editing-node-id="' + rootId + '"]');
        if (div && div.textContent === 'Inquire Within') {
          // Place cursor at the end of "TardMaxx"
          const range = document.createRange();
          range.setStartAfter(div.lastChild || div);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          // One-time handler: clear placeholder on first interaction
          const clear = () => {
            if (div.textContent === 'Inquire Within') div.textContent = '';
            div.removeEventListener('keydown', clear);
            div.removeEventListener('mousedown', clear);
          };
          div.addEventListener('keydown', clear);
          div.addEventListener('mousedown', clear);
        }
      }, 80);
    }, 300);

    // Auto-save warning on unload
    window.addEventListener('beforeunload', (e) => {
      if (this._hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  _initUI() {
    // Toolbar buttons
    this._bindBtn('btn-new', () => this.newMindMap());
    this._bindBtn('btn-open', () => this.showOpenDialog());
    this._bindBtn('btn-save', () => this.saveToStorage());
    this._bindBtn('btn-save-file', () => this.downloadFile());
    this._bindBtn('btn-undo', () => this.undo());
    this._bindBtn('btn-redo', () => this.redo());
    this._bindBtn('btn-add-child', () => this.addChildNode());
    this._bindBtn('btn-add-sibling', () => this.addSiblingNode());
    this._bindBtn('btn-delete-node', () => this.deleteSelectedNode());
    this._bindBtn('btn-edit-node', () => this.startInlineEdit(this.selectedNodeId));
    this._bindBtn('btn-auto-layout', () => this.autoLayout());
    this._bindBtn('btn-zoom-in', () => this.zoomIn());
    this._bindBtn('btn-zoom-out', () => this.zoomOut());
    this._bindBtn('btn-zoom-fit', () => this.fitToView());
    this._bindBtn('btn-export-png', () => this.exporter.exportPNG());
    this._bindBtn('btn-export-jpg', () => this.exporter.exportJPEG());
    this._bindBtn('btn-export-pdf', () => this.exporter.exportPDF());
    this._bindBtn('btn-export-md', () => this.exporter.exportMarkdown());
    this._bindBtn('btn-import-file', () => this.importFromFile());
    this._bindBtn('btn-toggle-sidebar', () => this.toggleSidebar());
    this._bindBtn('btn-close-sidebar', () => this.closeSidebar());
    this._bindBtn('btn-close-dive', () => document.getElementById('dive-panel').classList.remove('open'));
    this._bindBtn('btn-settings', () => this._showSettings());
    this._bindBtn('btn-ai-ask', () => {
      if (this.selectedNodeId) {
        this._aiExpandDialog(this.selectedNodeId);
      } else {
        this._showNewMapDialog();
      }
    });
    // Sidebar collapse
    document.getElementById('btn-collapse-sidebar').addEventListener('click', () => {
      document.getElementById('sidebar-left').classList.toggle('collapsed');
    });

    // Theme select
    document.getElementById('theme-select').addEventListener('change', (e) => {
      ThemeManager.setTheme(e.target.value);
    });

    // Context menu actions
    this.contextMenu.querySelectorAll('.ctx-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        this._handleContextAction(action);
        this.hideContextMenu();
      });
    });

    // Inline editor (legacy — now unused, in-place foreignObject editing replaced this)
    if (this.inlineInput) {
      this.inlineInput.addEventListener('blur', () => this._finishInlineEdit());
      this.inlineInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._finishInlineEdit(); }
        else if (e.key === 'Escape') { this._cancelInlineEdit(); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          const editingId = this.inlineInput.getAttribute('data-editing-node-id');
          this._finishInlineEdit();
          if (editingId) { this.selectNode(editingId); this.addChildNode(); }
        }
      });
    }

    // Inline editor event delegation (contenteditable div inside foreignObject)
    const svgEl = document.getElementById('mindmap-svg');
    svgEl.addEventListener('keydown', (e) => {
      if (!e.target.hasAttribute || !e.target.hasAttribute('data-editing-node-id')) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        // Enter = commit edit (save text). Shift+Enter = new line. Use < for AI.
        e.preventDefault();
        this._finishInlineEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._cancelInlineEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const editingId = this.renderer.editingNodeId;
        this._finishInlineEdit();
        if (editingId) {
          setTimeout(() => { this.selectNode(editingId); this.addChildNode(); }, 50);
        }
      }
    });
    // Blur = commit when clicking away from the editor
    document.addEventListener('mousedown', (e) => {
      if (this.renderer.editingNodeId && !e.target.hasAttribute ||
          !e.target.hasAttribute('data-editing-node-id')) {
        // Clicked outside the editor — commit
        // Small delay so the click target is evaluated first
        setTimeout(() => {
          if (this.renderer.editingNodeId) this._finishInlineEdit();
        }, 0);
      }
    });

    // File drop on workspace
    const workspace = document.getElementById('workspace');
    workspace.addEventListener('dragover', (e) => { e.preventDefault(); });
    workspace.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.name.match(/\.(json|csv)$/i)) {
        this._importFileAndLoad(file);
      }
    });

    // Modal close
    document.getElementById('modal-close').addEventListener('click', () => {
      this._hideModal();
    });

    // Theme
    ThemeManager.loadTheme();

    // Apply persisted global settings
    this._applySettings();

    // Clickable project title in toolbar
    const titleEl = document.getElementById('project-title');
    if (titleEl) {
      titleEl.addEventListener('click', () => this._renameProject());
      this._updateTitleDisplay();
    }

    // Model switcher in sidebar
    const modelSwitcher = document.getElementById('model-switcher');
    if (modelSwitcher) {
      const populateSwitcher = () => {
        const profiles = this.settings.aiProfiles || [];
        const activeIdx = this.settings.activeProfile || 0;
        modelSwitcher.innerHTML = profiles.map((p, i) =>
          `<option value="${i}" ${i === activeIdx ? 'selected' : ''}>${p.name.replace(/ \(.*$/, '')}${p.apiKey ? ' ✓' : ''}</option>`
        ).join('');
      };
      populateSwitcher();
      modelSwitcher.addEventListener('change', () => {
        this.settings.activeProfile = parseInt(modelSwitcher.value) || 0;
        this._saveSettings();
        this.toast('Switched to ' + this._activeProfile().name, 'success');
      });
    }

    // Project search filter + initial load
    const searchInput = document.getElementById('project-search');
    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => this._loadProjectList(), 250));
    }
    // Load project list — handle promise rejection so errors don't silently vanish
    this._loadProjectList().catch(e => {
      const container = document.getElementById('project-list');
      if (container) container.innerHTML = '<div style="color:var(--danger);font-size:11px;padding:8px;">Storage unavailable</div>';
    });

    // Close sidebar on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSidebar();
    });
  }

  _bindBtn(id, fn) {
    document.getElementById(id).addEventListener('click', fn);
  }

  // ==========================================================================
  // CORE ACTIONS
  // ==========================================================================

  /** Select a node by ID (null = deselect) */
  selectNode(id) {
    // Guard: reject IDs that don't exist in the tree (stale from a previous render)
    if (id && !this.mindmap.findNode(id)) {
      id = null;
    }
    // Remove 'selected' class from previously selected node in the DOM
    if (this.selectedNodeId) {
      const prevEl = document.querySelector(`[data-node-id="${CSS.escape(this.selectedNodeId)}"]`);
      if (prevEl) prevEl.classList.remove('selected');
    }
    this.selectedNodeId = id;
    // Add 'selected' class to newly selected node — no full re-render needed
    if (id) {
      const newEl = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
      if (newEl) newEl.classList.add('selected');
    }
    // Single-click on initial "TardMaxx" root → start editing, clears on input
    if (id === this.mindmap.root.id && this.mindmap.root.text === 'Inquire Within' && this.mindmap.root.children.length === 0) {
      setTimeout(() => {
        this.startInlineEdit(id);
        setTimeout(() => {
          const div = document.querySelector('[data-editing-node-id="' + id + '"]');
          if (div && div.textContent === 'Inquire Within') {
            const range = document.createRange();
            range.setStartAfter(div.lastChild || div);
            range.collapse(true);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            const clear = () => {
              if (div.textContent === 'Inquire Within') div.textContent = '';
              div.removeEventListener('keydown', clear);
              div.removeEventListener('mousedown', clear);
            };
            div.addEventListener('keydown', clear);
            div.addEventListener('mousedown', clear);
          }
        }, 80);
      }, 150);
    }
    this._updateSidebar();
    this._updateToolbarButtons();

    // Status bar
    const selSpan = document.getElementById('status-selected');
    if (id) {
      selSpan.textContent = 'Selected: ' + this.mindmap.findNode(id).text;
    } else {
      selSpan.textContent = 'Selected: none';
    }
  }

  addChildNode() {
    // Ensure dive panel is closed — Tab = child, never deep dive
    const divePanel = document.getElementById('dive-panel');
    if (divePanel) divePanel.classList.remove('open');
    const parentId = this.selectedNodeId || this.mindmap.root.id;
    const parent = this.mindmap.findNode(parentId);
    if (parent && parent.collapsed) parent.collapsed = false;
    this._pushUndo();
    const child = this.mindmap.addChild(parentId);
    if (child) {
      this.selectNode(child.id);
      this.autoLayout(true);
      setTimeout(() => this.startInlineEdit(child.id), 100);
    }
  }

  addSiblingNode() {
    if (!this.selectedNodeId || this.selectedNodeId === this.mindmap.root.id) {
      this.toast('Cannot add a sibling to the root node', 'warning');
      return;
    }
    this._pushUndo();
    const sibling = this.mindmap.addSibling(this.selectedNodeId);
    if (sibling) {
      this.selectNode(sibling.id);
      this.autoLayout(true); // preserve zoom
      setTimeout(() => this.startInlineEdit(sibling.id), 100);
    }
  }

  deleteSelectedNode() {
    if (!this.selectedNodeId) {
      this.toast('No node selected', 'warning');
      return;
    }
    if (this.selectedNodeId === this.mindmap.root.id) {
      this.toast('Cannot delete the root node', 'warning');
      return;
    }
    // Guard against stale selection
    if (!this.mindmap.findNode(this.selectedNodeId)) {
      this.selectNode(null);
      this.toast('Selection was stale — please re-select', 'warning');
      return;
    }
    this._pushUndo();
    const deleted = this.mindmap.deleteNode(this.selectedNodeId);
    if (deleted) {
      this.selectNode(null);
      this.autoLayout();
      this.toast('Node deleted', 'success');
    }
  }

  autoLayout(skipViewBox) {
    this.mindmap.autoLayoutEnabled = true;
    this.positions = LayoutEngine.layout(this.mindmap);
    this._updateAll(skipViewBox);
    this._updateModified();
  }

  zoomIn() {
    const vb = this.renderer.getViewBox();
    const factor = 1 - ZOOM_STEP;
    this.renderer.setViewBox(vb.x, vb.y, vb.w * factor, vb.h * factor);
    this._updateZoomStatus();
  }

  zoomOut() {
    const vb = this.renderer.getViewBox();
    const factor = 1 + ZOOM_STEP;
    this.renderer.setViewBox(vb.x, vb.y, vb.w * factor, vb.h * factor);
    this._updateZoomStatus();
  }

  fitToView() {
    if (this.positions.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [_, pos] of this.positions) {
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + pos.w > maxX) maxX = pos.x + pos.w;
      if (pos.y + pos.h > maxY) maxY = pos.y + pos.h;
    }
    const pad = 60;
    this.renderer.setViewBox(
      minX - pad, minY - pad,
      maxX - minX + pad * 2, maxY - minY + pad * 2
    );
    this._updateZoomStatus();
  }

  toggleCollapse(nodeId) {
    const node = this.mindmap.findNode(nodeId);
    if (!node || node.children.length === 0) return;
    this._pushUndo();
    node.collapsed = !node.collapsed;
    this.autoLayout();
  }

  // ==========================================================================
  // INLINE EDITING
  // ==========================================================================

  startInlineEdit(nodeId) {
    if (!nodeId) return;
    this.renderer.editingNodeId = nodeId;
    this._updateAll(true); // skipViewBox — preserve user's zoom/pan during edit
  }

  _finishInlineEdit() {
    const editingId = this.renderer.editingNodeId;
    if (!editingId) { this._updateAll(true); return; }

    // Read text from the contenteditable div inside the foreignObject
    const div = document.querySelector('[data-editing-node-id="' + editingId + '"]');
    const newText = div ? div.textContent.trim() : '';
    this.renderer.editingNodeId = null;

    if (newText) {
      const node = this.mindmap.findNode(editingId);
      if (node && node.text !== newText) {
        this._pushUndo();
        node.text = newText;
        this._updateModified();
        this.mindmap.autoLayoutEnabled = true;
      }
    }
    this._updateAll(true); // preserve zoom, re-render
    this._updateSidebar();
  }

  _cancelInlineEdit() {
    this.renderer.editingNodeId = null;
    this._updateAll(true); // preserve zoom with normal text, discarding changes
  }

  // ==========================================================================
  // CUT / COPY / PASTE
  // ==========================================================================

  cutNode() {
    if (!this.selectedNodeId || this.selectedNodeId === this.mindmap.root.id) return;
    this.clipboard = this.mindmap.cloneSubtree(
      this.mindmap.findNode(this.selectedNodeId)
    );
    this.clipboardCut = true;
    this.toast('Node cut to clipboard', 'success');
  }

  copyNode() {
    if (!this.selectedNodeId) return;
    this.clipboard = this.mindmap.cloneSubtree(
      this.mindmap.findNode(this.selectedNodeId)
    );
    this.clipboardCut = false;
    this.toast('Node copied to clipboard', 'success');
  }

  pasteNode() {
    if (!this.clipboard || !this.selectedNodeId) {
      this.toast('Select a parent node first, then paste', 'warning');
      return;
    }
    this._pushUndo();

    const clone = JSON.parse(JSON.stringify(this.clipboard));
    this.mindmap.reIdSubtree(clone);

    const parent = this.mindmap.findNode(this.selectedNodeId);
    parent.children.push(clone);

    if (this.clipboardCut) {
      // Cut: remove the original
      const originalId = this.clipboard.id;
      // The original might have been re-ID'd; find the parent of the original
      this.mindmap.deleteNode(originalId);
      this.clipboard = null;
      this.clipboardCut = false;
    }

    this.selectNode(clone.id);
    this.autoLayout();
    this.toast('Node pasted', 'success');
  }

  // ==========================================================================
  // UNDO / REDO
  // ==========================================================================

  _pushUndo() {
    const snapshot = JSON.stringify(this.mindmap.toJSON());
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = []; // invalidate redo on new action
    this._updateToolbarButtons();
    this._updateModified();
  }

  undo() {
    if (this.undoStack.length <= 1) return; // keep initial state
    // Push current to redo
    this.redoStack.push(JSON.stringify(this.mindmap.toJSON()));
    // Pop undo
    this.undoStack.pop();
    const snapshot = this.undoStack[this.undoStack.length - 1];
    this._restoreSnapshot(snapshot);
    this.toast('Undo', 'success');
  }

  redo() {
    if (this.redoStack.length === 0) return;
    // Push current to undo
    this.undoStack.push(JSON.stringify(this.mindmap.toJSON()));
    const snapshot = this.redoStack.pop();
    this._restoreSnapshot(snapshot);
    this.toast('Redo', 'success');
  }

  _restoreSnapshot(snapshot) {
    const json = JSON.parse(snapshot);
    this.mindmap = MindMapData.fromJSON(json);
    this.selectedNodeId = null;
    this.positions = LayoutEngine.layout(this.mindmap);
    this._updateAll();
    this._updateToolbarButtons();
    this._updateModified();
    this.closeSidebar();
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  _updateTitleDisplay() {
    const el = document.getElementById('project-title');
    if (el) el.textContent = this.mindmap.title;
  }

  async _renameProject() {
    const oldTitle = this.mindmap.title;
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = 'Rename Project';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Project Name</label>
        <input type="text" id="rename-input" value="${this._escapeHTML(oldTitle)}" style="width:100%;padding:8px 12px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);font-size:14px;">
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="rename-cancel">Cancel</button>
      <button class="btn primary" id="rename-ok">Rename</button>
    `;

    document.getElementById('rename-cancel').addEventListener('click', () => this._hideModal());
    document.getElementById('rename-ok').addEventListener('click', async () => {
      const newTitle = document.getElementById('rename-input').value.trim();
      this._hideModal();
      if (!newTitle || newTitle === oldTitle) return;
      // Delete old storage entry, save under new title
      try {
        await this.storage.delete(oldTitle);
      } catch (e) { /* old entry may not exist */ }
      this.mindmap.title = newTitle;
      this._updateTitleDisplay();
      this._updateModified();
      await this.saveToStorage();
      this.toast('Renamed to "' + newTitle + '"', 'success');
    });
    setTimeout(() => { const inp = document.getElementById('rename-input'); if (inp) { inp.focus(); inp.select(); } }, 100);
  }

  async saveToStorage() {
    try {
      await this.storage.save(this.mindmap);
      this._updateTitleDisplay();
      this._loadProjectList(); // refresh sidebar immediately
      this.toast('Saved — ' + this.mindmap.title, 'success');
      this._clearModified();
    } catch (e) {
      this.toast('Save failed: ' + e.message, 'error');
    }
  }

  async showOpenDialog() {
    try {
      const list = await this.storage.listAll();
      this._showOpenDialog(list);
    } catch (e) {
      this.toast('Failed to list saved maps: ' + e.message, 'error');
    }
  }

  async openFromStorage() {
    this.showOpenDialog();
  }

  downloadFile() {
    const json = JSON.stringify(this.mindmap.toJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.mindmap.title.replace(/[^a-zA-Z0-9 _-]/g, '') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this._clearModified();
    this.toast('File downloaded', 'success');
  }

  openFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) this._importFileAndLoad(file);
    };
    input.click();
  }

  importFromFile() {
    this.openFromFile(); // same flow
  }

  async _importFileAndLoad(file) {
    try {
      const mm = await this.importer.importFile(file);
      this._pushUndo();
      this.mindmap = mm;
      this.selectedNodeId = null;
      this._sanitizeTree(mm.root);
      this._updateTitleDisplay();
      this.autoLayout();
      this.toast('Imported: ' + mm.title, 'success');
    } catch (e) {
      this.toast('Import failed: ' + e.message, 'error');
    }
  }

  async newMindMap() {
    if (this._hasUnsavedChanges()) {
      const ok = await this._confirm('You have unsaved changes. Discard them and start new?');
      if (!ok) return;
    }
    // Show prompt dialog — user can type a prompt or click "Blank" to skip
    this._showNewMapDialog();
  }

  _showNewMapDialog() {
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = 'TardMaxx';
    document.getElementById('modal-body').innerHTML = `
      <p style="text-align:center;color:var(--text-secondary);font-size:13px;margin-bottom:12px;font-style:italic;">Let the tardmaxxing begin</p>
      <textarea id="ai-prompt" rows="3" placeholder="What do you want to explore?" style="width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-family:var(--font-sans);resize:vertical;line-height:1.5;"></textarea>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;" id="ai-suggestions">
        <span class="ai-chip" data-prompt="Explain the key concepts of">Explain a concept</span>
        <span class="ai-chip" data-prompt="Compare and contrast">Compare things</span>
        <span class="ai-chip" data-prompt="Break down the fundamentals of">Break down fundamentals</span>
        <span class="ai-chip" data-prompt="What are the most important things to know about">Key things to know</span>
      </div>
      <div id="ai-status" style="display:none;text-align:center;padding:12px;color:var(--accent);font-size:13px;">
        <span id="ai-status-text">Thinking...</span>
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="newmap-blank">Start blank</button>
      <button class="btn primary" id="newmap-generate">Inquire</button>
    `;

    // Suggestion chips
    document.querySelectorAll('.ai-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const ta = document.getElementById('ai-prompt');
        ta.value = (ta.value ? ta.value + ' ' : '') + chip.dataset.prompt + ' ';
        ta.focus();
      });
    });

    document.getElementById('newmap-blank').addEventListener('click', () => {
      this._hideModal();
      this._createBlankMap();
    });
    document.getElementById('newmap-generate').addEventListener('click', async () => {
      const prompt = document.getElementById('ai-prompt').value.trim();
      if (!prompt) { this._createBlankMap(); this._hideModal(); return; }
      // Show loading
      document.getElementById('ai-status').style.display = 'block';
      document.getElementById('newmap-generate').disabled = true;
      document.getElementById('newmap-blank').disabled = true;
      try {
        await this._aiGenerateMap(prompt);
        this._hideModal();
      } catch (e) {
        document.getElementById('ai-status-text').textContent = 'Failed: ' + e.message;
        document.getElementById('newmap-generate').disabled = false;
        document.getElementById('newmap-blank').disabled = false;
      }
    });
    setTimeout(() => { const ta = document.getElementById('ai-prompt'); if (ta) ta.focus(); }, 100);
  }

  _createBlankMap() {
    this._pushUndo();
    this.mindmap = new MindMapData('Untitled');
    this.selectedNodeId = null;
    this.clipboard = null;
    this.undoStack = [JSON.stringify(this.mindmap.toJSON())];
    this.redoStack = [];
    this._updateTitleDisplay();
    this.autoLayout();
    this.toast('New mind map created', 'success');
  }

  /** Call LLM API to generate a mind map tree from a prompt */
  async _aiGenerateMap(prompt) {
    const title = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
    const systemPrompt = `You are a first-principles thinker who calibrates to the user's knowledge level. Return ONLY valid JSON.

First, assess the user's prompt: are they using basic language ("how does X work", "what is Y") or expert terminology? Match your response depth to theirs. If they ask a beginner question, answer at a beginner level. If they use domain jargon, they can handle domain depth.

A first-principles tree reveals the underlying architecture:
- What are the irreducible building blocks of this topic?
- What questions must someone answer to truly understand it?
- What relationships hold it together?

Bad (surface taxonomy): "Medicare Parts" → "Part A" / "Part B" / "Part C" / "Part D"
Good (first principles): "What Medicare covers" / "How you access care" / "What you pay"

Rules:
- Create 4-8 children MAXIMUM. Only 1 level deep.
- Node text: insight, not label. Notes: teach something real (2-4 sentences).
- Calibrate depth: a beginner asking "what's medicare" gets clear, foundational nodes. An expert asking about "Part D risk corridors" gets technical precision. Never talk down, never talk over their head.
- Use plain English unless the user's prompt signals they know the terminology.
- If you're unsure of their level, err on the side of accessible but not condescending.`;

    const treeJSON = await this._callLLM(systemPrompt, prompt);

    // Parse and build the tree
    this._pushUndo();
    this.mindmap = new MindMapData(title);
    const rootData = typeof treeJSON === 'string' ? JSON.parse(treeJSON) : treeJSON;
    this.mindmap.root.text = rootData.text || title;
    this.mindmap.root.notes = rootData.notes || '';
    if (rootData.children && Array.isArray(rootData.children)) {
      for (const child of rootData.children) {
        this._aiBuildSubtree(this.mindmap.root, child);
      }
    }
    this.selectedNodeId = null;
    this.clipboard = null;
    this.undoStack = [JSON.stringify(this.mindmap.toJSON())];
    this.redoStack = [];
    this._updateTitleDisplay();
    this.autoLayout();
    this.toast('AI responded — explore and curate the branches', 'success');
  }

  /** Recursively build subtree from AI JSON response */
  _aiBuildSubtree(parentNode, data) {
    const child = this.mindmap.addChild(parentNode.id, data.text || 'New Node');
    if (!child) return;
    if (data.notes) child.notes = data.notes;
    if (data.children && Array.isArray(data.children)) {
      for (const sub of data.children) {
        this._aiBuildSubtree(child, sub);
      }
    }
  }

  /** Tree expansion — AI generates child nodes */
  async _aiExpandNode(nodeId, prompt) {
    const node = this.mindmap.findNode(nodeId);
    if (!node) return;
    const parent = this.mindmap.findParent(nodeId);
    const existingContext = node.children.map(c => c.text).join(', ');

    const systemPrompt = `Drill into ONE concept. Return ONLY valid JSON. Each child should be a RICH SYNOPSIS, not a label.

The concept: "${node.text}"${node.notes ? ' — ' + node.notes : ''}.
${existingContext ? 'Already has: ' + existingContext + '. Don\'t duplicate.' : 'No sub-topics yet.'}
${parent ? 'Broader context: "' + parent.text + '"' : ''}

Return a JSON object with a "children" array of 3-5 items:
{
  "children": [
    {
      "text": "A rich synopsis sentence or two that actually teaches something (40-100 words). Not a label — a mini-paragraph.",
      "notes": "Additional context, examples, or nuance (2-4 more sentences).",
      "children": []
    }
  ]
}

Rules: 3-5 children MAXIMUM. Text must be informative standalone synopses. Notes should add depth. Match the user's sophistication. Don't duplicate: ${existingContext || 'none'}`;

    const result = await this._callLLM(systemPrompt, prompt || 'Expand this topic');
    const children = typeof result === 'string' ? JSON.parse(result) : result;
    const arr = Array.isArray(children) ? children : (children.children || [children]);
    if (!arr || arr.length === 0) {
      this.toast('AI returned nothing — try rephrasing', 'warning');
      return;
    }
    this._pushUndo();
    for (const childData of arr) {
      const child = this.mindmap.addChild(nodeId, childData.text || 'New Node');
      if (!child) continue;
      if (childData.notes) child.notes = childData.notes;
      child._semiDeepDive = true; // fade + expand on every tree child
      child.fontSize = 13;
      if (childData.children && Array.isArray(childData.children)) {
        for (const sub of childData.children) this._aiBuildSubtree(child, sub);
      }
    }
    this.autoLayout();
    this._updateSidebar();
    setTimeout(() => { this._centerOnSubtree(nodeId); }, 80);
    this.toast('AI responded under: ' + node.text, 'success');
  }

  /** One-click AI expand on any node — reads live editor text if node is being edited */
  async _aiExpandLeafNode(nodeId) {
    const node = this.mindmap.findNode(nodeId);
    if (!node) return;
    if (!this.settings.aiApiKey) {
      this.toast('Add an API key in Settings first', 'warning');
      return;
    }
    // If node is currently being edited, capture live text from the editor
    if (this.renderer.editingNodeId === nodeId) {
      const div = document.querySelector('[data-editing-node-id="' + nodeId + '"]');
      if (div) {
        const liveText = div.textContent.trim();
        if (liveText) node.text = liveText;
      }
    }
    const placeholderNames = ['', 'inquire within'];
    if (placeholderNames.includes(node.text.toLowerCase().trim())) {
      this.toast('Type a topic in the node first, or use ✨ Ask AI for a custom prompt', 'warning');
      this.startInlineEdit(nodeId);
      return;
    }
    const ancestors = [];
    let current = this.mindmap.findParent(nodeId);
    while (current) {
      ancestors.unshift(current.text);
      current = this.mindmap.findParent(current.id);
    }
    const contextPath = ancestors.length > 0 ? ' (part of: ' + ancestors.join(' > ') + ')' : '';
    const existingNote = node.children.length > 0
      ? ' This node already has ' + node.children.length + ' sub-topic(s). Add complementary ones, don\'t duplicate.'
      : '';
    const defaultPrompt = 'Explain "' + node.text + '"' + contextPath + ' — what are the key concepts, nuances, and things someone should know?' + existingNote;
    const dot = document.querySelector(`[data-action="ai-expand"][data-node-id="${nodeId}"]`);
    if (dot) dot.classList.add('spinning');
    try {
      await this._aiExpandNode(nodeId, defaultPrompt);
    } catch (e) {
      this.toast('AI expand failed: ' + e.message, 'error');
    } finally {
      if (dot) dot.classList.remove('spinning');
    }
  }

  /** Center the view on a node and its subtree */
  _centerOnSubtree(nodeId) {
    const node = this.mindmap.findNode(nodeId);
    if (!node) return;
    // Collect bounding box of node + all descendants
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const collect = (n) => {
      const p = this.positions.get(n.id);
      if (p) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x + p.w > maxX) maxX = p.x + p.w;
        if (p.y + p.h > maxY) maxY = p.y + p.h;
      }
      for (const child of n.children) collect(child);
    };
    collect(node);
    const pad = 80;
    this.renderer.setViewBox(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
    this._updateZoomStatus();
  }

  /** Deep dive — shows prose response in an overlay panel */
  async _startDeepDive(nodeId) {
    console.trace('_startDeepDive called from');
    const node = this.mindmap.findNode(nodeId);
    if (!node) return;
    const profile = this._activeProfile();
    if (!profile || !profile.apiKey) {
      this.toast('Add an API key in Settings first', 'warning');
      return;
    }
    // Show panel immediately with loading state
    const panel = document.getElementById('dive-panel');
    const body = document.getElementById('dive-panel-body');
    document.getElementById('dive-panel-title').textContent = '🤿 ' + node.text;
    body.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">Diving...</p>';
    panel.classList.add('open');

    const ring = document.querySelector(`[data-node-id="${nodeId}"] .mm-dive-ring`);
    if (ring) ring.classList.add('spinning');
    try {
      const ancestors = [];
      let cur = this.mindmap.findParent(nodeId);
      while (cur) { ancestors.unshift(cur.text); cur = this.mindmap.findParent(cur.id); }
      const contextPath = ancestors.length ? 'Context: ' + ancestors.join(' > ') + ' > ' + node.text : '';
      const systemPrompt = `Semi-deep dive. Respond with a rich summary paragraph (80-150 words) followed by "---" and additional markdown with bullet points, examples, nuance. The paragraph is the visible summary. The markdown after "---" is expandable extra detail. Use context to orient yourself.`;
      const prompt = `Explain "${node.text}" in depth. ${contextPath}. What should someone really understand about this?`;
      const result = await this._callLLMProse(systemPrompt, prompt);
      // Split summary + extra, create semi-deep-dive child node
      const parts = (result || '').split('---', 2);
      const summary = (parts[0] || result || '').trim();
      const extra = parts.length > 1 ? parts[1].trim() : '';
      this._pushUndo();
      const child = this.mindmap.addChild(nodeId, summary.slice(0, 250) + (summary.length > 250 ? '...' : ''));
      if (child) { child.notes = summary + (extra ? '\n\n---\n\n' + extra : ''); child._semiDeepDive = true; child.fontSize = 13; }
      this.autoLayout();
      this._updateSidebar();
      // Show full result in overlay panel
      body.innerHTML = '<div style="max-width:700px;margin:0 auto;">' +
        result.split('\n').map(line =>
          line.startsWith('#') ? '<h3 style="margin-top:16px;">' + line.replace(/^#+\s*/, '') + '</h3>' :
          line.startsWith('- ') ? '<li style="margin-left:16px;">' + line.slice(2) + '</li>' :
          line.match(/^\d+\./) ? '<li style="margin-left:16px;">' + line.replace(/^\d+\.\s*/, '') + '</li>' :
          line.trim() === '' ? '<br>' :
          '<p>' + line + '</p>'
        ).join('') + '</div>';
    } catch (e) {
      body.innerHTML = '<p style="color:var(--danger);text-align:center;padding:40px;">Deep dive failed: ' + e.message + '</p>';
    } finally {
      if (ring) ring.classList.remove('spinning');
    }
  }

  /** Call LLM and return plain text (not JSON). Uses active profile. */
  async _callLLMProse(systemPrompt, userPrompt) {
    const profile = this._activeProfile();
    const apiKey = profile.apiKey;
    const provider = profile.provider || 'anthropic';
    const model = profile.model || 'claude-sonnet-4-20250514';
    if (!apiKey) throw new Error('No API key set.');
    if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 2048, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
      });
      if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error?.message || 'API error'); }
      const data = await resp.json();
      return data.content[0].text;
    }
    const baseURLs = { openai: 'https://api.openai.com/v1/chat/completions', deepseek: 'https://api.deepseek.com/v1/chat/completions', groq: 'https://api.groq.com/openai/v1/chat/completions' };
    const baseURL = baseURLs[provider] || baseURLs.openai;
    const resp = await fetch(baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error?.message || 'API error'); }
    const data = await resp.json();
    return data.choices[0].message.content;
  }

  _showWalkthrough() {
    const steps = [
      { emoji: '👋', title: 'Welcome to TardMaxx', text: 'A mind mapping tool for structuring thoughts and projects. <br><br><b>Without AI:</b> build trees, link files, export, save — a clean way to organize anything.<br><br><b>With AI:</b> add an API key in Settings, and every node becomes an AI endpoint. Click <b>&lt;</b> to expand branches, <b>🤿</b> for deep dives.' },
      { emoji: '🏗️', title: 'Your Command Center', text: 'Create, save, and manage mind maps from the left sidebar. Switch AI models at the bottom. No AI key? You can still do everything except AI expansion.' },
      { emoji: '💡', title: 'TardMaxx', text: 'The center node is your starting point. Type a question, click <b>&lt;</b>, or press Enter — the AI responds in tree form. Or just start building your own tree manually.' },
      { emoji: '🔍', title: 'Expand & Dive', text: 'Click <b>&lt;</b> on any node to expand with AI synopses. Click <b>🤿</b> for a prose deep dive overlay.' },
      { emoji: '⌨️', title: 'Keyboard Shortcuts', text: '<b>Tab</b> adds a child. <b>Enter</b> adds a sibling. <b>Double-click</b> to edit. <b>Ctrl+S</b> to save. <b>Scroll</b> to zoom.' },
      { emoji: '✅', title: 'You\'re All Set', text: 'Add an API key in <b>Settings (🎨)</b> or in <b>config.js</b>. Groq is fast and cheap. Enjoy!' }
    ];
    let step = 0;
    const render = () => {
      const s = steps[step];
      const old = document.getElementById('walkthrough-overlay');
      if (old) old.remove();
      const overlay = document.createElement('div');
      overlay.id = 'walkthrough-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:500;display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = `
        <div style="background:var(--bg-secondary);border-radius:12px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;">
          <div style="font-size:40px;margin-bottom:8px;">${s.emoji}</div>
          <h2 style="margin:0 0 8px;font-size:18px;">${s.title}</h2>
          <p style="color:var(--text-secondary);font-size:13px;line-height:1.5;margin:0 0 20px;">${s.text}</p>
          <div style="display:flex;gap:8px;justify-content:center;">
            ${step > 0 ? '<button class="btn" id="wt-prev">Back</button>' : ''}
            <button class="btn primary" id="wt-next">${step < steps.length - 1 ? 'Next' : 'Got it'}</button>
          </div>
          <div style="margin-top:12px;display:flex;gap:4px;justify-content:center;">${steps.map((_,i) => `<span style="width:6px;height:6px;border-radius:50%;background:${i===step?'var(--accent)':'var(--border-color)'};"></span>`).join('')}</div>
          <button style="margin-top:12px;background:none;border:none;color:var(--text-muted);font-size:11px;cursor:pointer;" id="wt-skip">Skip tour</button>
        </div>`;
      document.body.appendChild(overlay);
      const done = () => { overlay.remove(); localStorage.setItem('mindmap-walkthrough-done', '1'); };
      document.getElementById('wt-next').addEventListener('click', () => {
        if (step < steps.length - 1) { step++; render(); }
        else { done(); }
      });
      const prevBtn = document.getElementById('wt-prev');
      if (prevBtn) prevBtn.addEventListener('click', () => { step--; render(); });
      document.getElementById('wt-skip').addEventListener('click', done);
    };
    render();
  }

  /** Show a prompt dialog for AI expanding a specific node */
  _aiExpandDialog(nodeId) {
    if (!nodeId) return;
    const node = this.mindmap.findNode(nodeId);
    if (!node) return;
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = 'TardMaxx';
    document.getElementById('modal-body').innerHTML = `
      <p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-bottom:8px;">Exploring: <b>${this._escapeHTML(node.text)}</b></p>
      <textarea id="ai-expand-prompt" rows="3" placeholder="What do you want to know about this?" style="width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-family:var(--font-sans);resize:vertical;line-height:1.5;"></textarea>
      <div id="ai-expand-status" style="display:none;text-align:center;padding:12px;color:var(--accent);">Thinking...</div>
      </div>
      <div id="ai-expand-status" style="display:none;text-align:center;padding:12px;color:var(--accent);">Generating...</div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="aiexpand-cancel">Cancel</button>
      <button class="btn primary" id="aiexpand-go">Inquire</button>
    `;
    document.getElementById('aiexpand-cancel').addEventListener('click', () => this._hideModal());
    document.getElementById('aiexpand-go').addEventListener('click', async () => {
      const prompt = document.getElementById('ai-expand-prompt').value.trim();
      document.getElementById('ai-expand-status').style.display = 'block';
      document.getElementById('aiexpand-go').disabled = true;
      try {
        await this._aiExpandNode(nodeId, prompt);
        this._hideModal();
      } catch (e) {
        document.getElementById('ai-expand-status').textContent = 'Error: ' + e.message;
        document.getElementById('aiexpand-go').disabled = false;
      }
    });
    setTimeout(() => { const ta = document.getElementById('ai-expand-prompt'); if (ta) ta.focus(); }, 100);
  }

  /** Call the LLM API and return parsed JSON. Uses the active AI profile. */
  async _callLLM(systemPrompt, userPrompt) {
    const profile = this._activeProfile();
    const apiKey = profile.apiKey;
    const provider = profile.provider || 'anthropic';
    const model = profile.model || 'claude-sonnet-4-20250514';
    if (!apiKey) throw new Error('Add an API key in Settings (🎨) for ' + profile.name);

    // --- Anthropic ---
    if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error?.message || 'API error ' + resp.status); }
      const data = await resp.json();
      const content = data.content[0].text;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      return JSON.parse(jsonMatch[1].trim());
    }

    // --- OpenAI / DeepSeek / Groq (OpenAI-compatible chat completions) ---
    const baseURLs = {
      openai: 'https://api.openai.com/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/v1/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions'
    };
    const baseURL = baseURLs[provider] || baseURLs.openai;

    const resp = await fetch(baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model, max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error?.message || 'API error ' + resp.status); }
    const data = await resp.json();
    let content = data.choices[0].message.content;
    // Strip markdown code fences if present (some models wrap JSON despite response_format)
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) content = jsonMatch[1].trim();
    return JSON.parse(content);
  }

  // ==========================================================================
  // CONTEXT MENU
  // ==========================================================================

  showContextMenu(x, y, nodeId) {
    const menu = this.contextMenu;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('visible');

    // Disable paste if clipboard is empty
    const pasteItem = menu.querySelector('[data-action="paste"]');
    if (pasteItem) pasteItem.style.opacity = this.clipboard ? '1' : '0.4';

    // Disable sibling add if root
    const siblingItem = menu.querySelector('[data-action="add-sibling"]');
    if (siblingItem) {
      siblingItem.style.opacity = (nodeId && nodeId !== this.mindmap.root.id) ? '1' : '0.4';
    }

    // Ensure menu stays in viewport
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = (x - menuRect.width) + 'px';
    if (menuRect.bottom > window.innerHeight) menu.style.top = (y - menuRect.height) + 'px';
  }

  hideContextMenu() {
    this.contextMenu.classList.remove('visible');
  }

  _handleContextAction(action) {
    switch (action) {
      case 'edit': this.startInlineEdit(this.selectedNodeId); break;
      case 'add-child': this.addChildNode(); break;
      case 'add-sibling': this.addSiblingNode(); break;
      case 'cut': this.cutNode(); break;
      case 'copy': this.copyNode(); break;
      case 'paste': this.pasteNode(); break;
      case 'add-image': this._addImageToSelected(); break;
      case 'add-file': this._linkFileToSelected(); break;
      case 'change-color': this._changeNodeColor(); break;
      case 'collapse': if (this.selectedNodeId) this.toggleCollapse(this.selectedNodeId); break;
      case 'delete': this.deleteSelectedNode(); break;
    }
  }

  _addImageToSelected() {
    this._addFileToSelected('image/*');
  }

  /** Link a file by path — no data copied. Opens in default OS viewer on click. */
  _linkFileToSelected() {
    if (!this.selectedNodeId) return;
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = 'Link File';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>File path or URL <span style="font-size:10px;color:var(--text-muted);">(local path or Google Drive / Dropbox / web link)</span></label>
        <div style="display:flex;gap:6px;">
          <input type="text" id="link-path" placeholder="C:\path\to\file.pdf  or  https://drive.google.com/..." style="flex:1;">
          <button class="btn" id="link-browse" style="white-space:nowrap;font-size:12px;">Browse...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Display name <span style="font-size:10px;color:var(--text-muted);">(optional, defaults to filename)</span></label>
        <input type="text" id="link-name" placeholder="e.g. Carrier discount chart" style="width:100%">
      </div>
      <p style="font-size:11px;color:var(--text-muted);">💡 Files stay where they are. Only the path is stored.</p>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="link-cancel">Cancel</button>
      <button class="btn primary" id="link-ok">Link</button>
    `;
    document.getElementById('link-cancel').addEventListener('click', () => this._hideModal());
    document.getElementById('link-browse').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = () => {
        const file = input.files[0];
        if (file) {
          document.getElementById('link-name').value = file.name;
          // Browsers don't expose full path — user pastes it separately
          document.getElementById('link-path').focus();
        }
      };
      input.click();
    });
    document.getElementById('link-ok').addEventListener('click', () => {
      const path = document.getElementById('link-path').value.trim();
      if (!path) { this.toast('Please enter a file path', 'warning'); return; }
      const name = document.getElementById('link-name').value.trim() || path.split(/[\\/]/).pop();
      const node = this.mindmap.findNode(this.selectedNodeId);
      if (!node) return;
      this._pushUndo();
      if (!node.files) node.files = [];
      // Guess type from extension
      const ext = path.split('.').pop().toLowerCase();
      const typeMap = { pdf:'pdf', doc:'doc', docx:'docx', xls:'xls', xlsx:'xlsx',
        ppt:'ppt', pptx:'pptx', txt:'txt', md:'md', csv:'csv', json:'json',
        png:'image', jpg:'image', jpeg:'image', gif:'image', bmp:'image', webp:'image', svg:'image',
        mp4:'video', mov:'video', avi:'video', webm:'video',
        mp3:'audio', wav:'audio', flac:'audio', ogg:'audio' };
      node.files.push({
        path: path,
        name: name,
        type: typeMap[ext] || 'file',
        addedAt: new Date().toISOString()
      });
      this._updateAll();
      this._updateSidebar();
      this._hideModal();
      this.toast('Linked: ' + name, 'success');
    });
    setTimeout(() => { const inp = document.getElementById('link-path'); if (inp) inp.focus(); }, 100);
  }

  /** Open a linked file — local paths open in default viewer, URLs open in browser */
  _openLinkedFile(path) {
    try {
      if (/^https?:\/\//i.test(path)) {
        // Web URL (Google Drive, Dropbox, etc.) — open in browser
        window.open(path, '_blank');
      } else {
        // Local path — open in default OS viewer via file:// protocol
        const normalized = path.replace(/\\/g, '/');
        const url = normalized.startsWith('/') ? 'file://' + normalized : 'file:///' + normalized;
        window.open(url, '_blank');
      }
    } catch (e) {
      this.toast('Cannot open link. Check the path.', 'error');
    }
  }

  _changeNodeColor() {
    if (!this.selectedNodeId) return;
    const colInput = document.createElement('input');
    colInput.type = 'color';
    colInput.value = '#5b9bd5';
    colInput.onchange = () => {
      const node = this.mindmap.findNode(this.selectedNodeId);
      if (node) {
        this._pushUndo();
        node.color = colInput.value;
        this._updateAll();
      }
    };
    colInput.click();
  }

  // ==========================================================================
  // SIDEBAR (Node Properties)
  // ==========================================================================

  toggleSidebar() {
    this.sidebar.classList.toggle('open');
    if (this.sidebar.classList.contains('open')) this._updateSidebar();
  }

  closeSidebar() {
    this.sidebar.classList.remove('open');
  }

  _updateSidebar() {
    if (!this.sidebar.classList.contains('open')) return;
    const container = document.getElementById('sidebar-content');
    if (!this.selectedNodeId) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Select a node to edit its properties.</p>';
      return;
    }
    const node = this.mindmap.findNode(this.selectedNodeId);
    if (!node) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="sidebar-section">
        <h4>Text</h4>
        <input type="text" id="prop-text" value="${this._escapeHTML(node.text)}">
      </div>
      <div class="sidebar-section">
        <h4>Appearance</h4>
        <label>Color</label>
        <input type="color" id="prop-color" value="${node.color || '#5b9bd5'}">
        <label>Font Size</label>
        <input type="range" id="prop-fontsize" min="10" max="36" value="${node.fontSize || 14}">
        <span style="font-size:11px;color:var(--text-muted)">${node.fontSize || 14}px</span>
        <label style="margin-top:8px;">
          <input type="checkbox" id="prop-bold" ${node.bold ? 'checked' : ''}> Bold
        </label>
        <label>
          <input type="checkbox" id="prop-italic" ${node.italic ? 'checked' : ''}> Italic
        </label>
      </div>
      <div class="sidebar-section">
        <h4>Image</h4>
        ${node.image
          ? `<div style="margin-bottom:8px;"><img src="${node.image}" style="max-width:100%;max-height:120px;border-radius:4px;"></div>
             <button class="sb-btn danger" id="prop-remove-image">Remove Image</button>`
          : `<button class="sb-btn" id="prop-add-image">Add Image</button>`
        }
      </div>
      <div class="sidebar-section">
        <h4>Linked Files</h4>
        <button class="sb-btn" id="prop-add-file" style="margin-bottom:6px;">🔗 Link File</button>
        ${(node.files && node.files.length > 0) ? `
          <div style="max-height:140px;overflow-y:auto;">
          ${node.files.map((f, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;
              padding:4px 6px;margin:2px 0;background:var(--bg-primary);border-radius:4px;font-size:11px;">
              <span class="prop-open-file" data-path="${this._escapeHTML(f.path || '')}"
                style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;cursor:pointer;color:var(--accent);"
                title="Open: ${this._escapeHTML(f.path || f.name)}">📄 ${this._escapeHTML(f.name)}</span>
              <button class="sb-btn danger prop-remove-file" data-idx="${i}"
                style="font-size:10px;padding:2px 6px;flex-shrink:0;">✕</button>
            </div>
          `).join('')}
          </div>
        ` : '<p style="color:var(--text-muted);font-size:11px;">No files linked.<br><small>Link files by path — no data copied.</small></p>'}
      </div>
      <div class="sidebar-section">
        <h4>Notes</h4>
        <textarea id="prop-notes" rows="4" placeholder="Add notes for this node...">${this._escapeHTML(node.notes || '')}</textarea>
      </div>
      <div class="sidebar-section">
        <h4>Actions</h4>
        <button class="sb-btn primary" id="prop-add-child">➕ Add Child</button>
        <button class="sb-btn" id="prop-ai-expand" style="background:linear-gradient(135deg,#7c3aed,#3b82f6);color:#fff;border:none;">✨ Inquire</button>
        <button class="sb-btn danger" id="prop-delete" ${node.id === this.mindmap.root.id ? 'disabled' : ''}>🗑 Delete Node</button>
      </div>
    `;

    // Bind events
    const bind = (id, event, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, fn);
    };

    bind('prop-text', 'input', () => {
      this._pushUndo();
      node.text = document.getElementById('prop-text').value || 'Node';
      this._updateAll();
    });
    bind('prop-color', 'input', () => {
      this._pushUndo();
      node.color = document.getElementById('prop-color').value;
      this._updateAll();
    });
    bind('prop-fontsize', 'input', () => {
      this._pushUndo();
      node.fontSize = parseInt(document.getElementById('prop-fontsize').value);
      this._updateAll();
    });
    bind('prop-bold', 'change', () => {
      this._pushUndo();
      node.bold = document.getElementById('prop-bold').checked;
      this._updateAll();
    });
    bind('prop-italic', 'change', () => {
      this._pushUndo();
      node.italic = document.getElementById('prop-italic').checked;
      this._updateAll();
    });
    bind('prop-notes', 'input', () => {
      this._pushUndo();
      node.notes = document.getElementById('prop-notes').value;
    });
    bind('prop-add-child', 'click', () => this.addChildNode());
    bind('prop-ai-expand', 'click', () => this._aiExpandDialog(this.selectedNodeId));
    bind('prop-delete', 'click', () => this.deleteSelectedNode());

    const addImgBtn = document.getElementById('prop-add-image');
    if (addImgBtn) addImgBtn.addEventListener('click', () => this._addImageToSelected());
    const removeImgBtn = document.getElementById('prop-remove-image');
    if (removeImgBtn) {
      removeImgBtn.addEventListener('click', () => {
        this._pushUndo();
        node.image = null;
        this._updateAll();
        this._updateSidebar();
      });
    }
    // File link / open / remove
    const addFileBtn = document.getElementById('prop-add-file');
    if (addFileBtn) addFileBtn.addEventListener('click', () => this._linkFileToSelected());
    document.querySelectorAll('.prop-open-file').forEach(el => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        if (path) this._openLinkedFile(path);
      });
    });
    document.querySelectorAll('.prop-remove-file').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (!isNaN(idx) && node.files && node.files[idx]) {
          const f = node.files[idx];
          this._pushUndo();
          node.files.splice(idx, 1);
          this._updateAll();
          this._updateSidebar();
          this.toast('Unlinked: ' + f.name, 'success');
        }
      });
    });
  }

  // ==========================================================================
  // MODAL DIALOGS
  // ==========================================================================

  _showOpenDialog(list) {
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = 'Open Mind Map';

    let html = '';
    // Always offer file import
    html += `
      <div style="margin-bottom:12px;">
        <button class="btn primary" id="open-from-file-btn" style="width:100%;">
          📂 Browse for File... (.json / .csv)
        </button>
      </div>`;

    if (list.length > 0) {
      html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;">Saved in Browser Storage</div>';
      html += '<div style="max-height:250px;overflow-y:auto;">';
      for (const item of list) {
        html += `
          <div style="display:flex;align-items:center;justify-content:space-between;
            padding:10px;border:1px solid var(--border-light);border-radius:6px;margin-bottom:6px;
            cursor:pointer;transition:background var(--transition-fast);"
            class="open-item" data-title="${this._escapeHTML(item.title)}">
            <div>
              <strong>${this._escapeHTML(item.title)}</strong>
              <div style="font-size:11px;color:var(--text-muted)">Saved: ${item.savedAt ? new Date(item.savedAt).toLocaleString() : 'Unknown'}</div>
            </div>
            <button class="sb-btn danger open-delete" data-title="${this._escapeHTML(item.title)}"
              style="font-size:11px;padding:4px 8px;">Delete</button>
          </div>`;
      }
      html += '</div>';
    } else {
      html += '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">No mind maps saved in browser storage yet.<br>Use <strong>Save</strong> (Ctrl+S) to save one, or open a file above.</p>';
    }

    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="modal-cancel-btn">Cancel</button>
    `;

    // Bind
    document.getElementById('modal-cancel-btn').addEventListener('click', () => this._hideModal());
    const fileBtn = document.getElementById('open-from-file-btn');
    if (fileBtn) {
      fileBtn.addEventListener('click', () => {
        this._hideModal();
        this.openFromFile();
      });
    }

    document.querySelectorAll('.open-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.classList.contains('open-delete')) return;
        const title = el.dataset.title;
        await this._loadFromStorage(title);
        this._hideModal();
      });
    });
    document.querySelectorAll('.open-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const title = btn.dataset.title;
        if (await this._confirm('Delete "' + title + '" from storage?')) {
          await this.storage.delete(title);
          const list = await this.storage.listAll();
          this._showOpenDialog(list);
        }
      });
    });
  }

  async _loadFromStorage(title) {
    try {
      const mm = await this.storage.load(title);
      if (mm) {
        this._pushUndo();
        this.mindmap = mm;
        this.selectedNodeId = null;
        // Strip stale computed properties from old-version saves
        this._sanitizeTree(mm.root);
        this._updateTitleDisplay();
        this.autoLayout();
        this._loadProjectList(); // refresh sidebar list
        this.toast('Loaded: ' + title, 'success');
      } else {
        this.toast('Not found: ' + title, 'error');
      }
    } catch (e) {
      this.toast('Load failed: ' + e.message, 'error');
    }
  }

  /** Recursively strip computed underscore-prefixed props and ensure files array exists */
  _sanitizeTree(node) {
    delete node._lines;
    delete node._lx;
    delete node._ly;
    delete node._subtreeH;
    delete node._subtreeTop;
    delete node._subtreeBottom;
    delete node._semiDeepDive;
    delete node._deepDive;
    // Backward compat: ensure files array exists on loaded nodes
    if (!node.files) node.files = [];
    if (node.children) {
      for (const child of node.children) this._sanitizeTree(child);
    }
  }

  _hideModal() {
    this.modalOverlay.classList.add('hidden');
  }

  _confirm(message) {
    return new Promise((resolve) => {
      this.modalOverlay.classList.remove('hidden');
      document.getElementById('modal-title').textContent = 'Confirm';
      document.getElementById('modal-body').innerHTML =
        '<p>' + this._escapeHTML(message) + '</p>';
      document.getElementById('modal-footer').innerHTML = `
        <button class="btn" id="confirm-no">Cancel</button>
        <button class="btn primary" id="confirm-yes">Yes</button>
      `;
      document.getElementById('confirm-yes').addEventListener('click', () => { this._hideModal(); resolve(true); });
      document.getElementById('confirm-no').addEventListener('click', () => { this._hideModal(); resolve(false); });
    });
  }

  // ==========================================================================
  // TOAST NOTIFICATIONS
  // ==========================================================================

  toast(message, type) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ==========================================================================
  // STATUS & UI UPDATES
  // ==========================================================================

  _updateAll(skipViewBox) {
    // Recompute layout if auto-layout is on
    if (this.mindmap.autoLayoutEnabled) {
      this.positions = LayoutEngine.layout(this.mindmap);
    }

    // Render — skip viewBox update for edits/drags (preserves user zoom)
    this.renderer.render(this.mindmap, this.positions, this.selectedNodeId, skipViewBox);

    // Status bar
    document.getElementById('status-nodes').textContent =
      'Nodes: ' + this.mindmap.countNodes();
    this._updateZoomStatus();
  }

  _updateZoomStatus() {
    const vb = this.renderer.getViewBox();
    const rect = this.renderer.getScreenRect();
    const zoomPct = Math.round((rect.width / vb.w) * 100);
    document.getElementById('status-zoom').textContent = 'Zoom: ' + zoomPct + '%';
  }

  _updateToolbarButtons() {
    const hasSelection = this.selectedNodeId !== null;
    const isRoot = this.selectedNodeId === this.mindmap.root.id;

    document.getElementById('btn-undo').disabled = this.undoStack.length <= 1;
    document.getElementById('btn-redo').disabled = this.redoStack.length === 0;
    document.getElementById('btn-delete-node').disabled = !hasSelection || isRoot;
    document.getElementById('btn-edit-node').disabled = !hasSelection;
  }

  _updateModified() {
    document.getElementById('status-modified').style.display = 'inline';
  }

  _clearModified() {
    document.getElementById('status-modified').style.display = 'none';
  }

  _hasUnsavedChanges() {
    return document.getElementById('status-modified').style.display !== 'none';
  }

  // ==========================================================================
  // GLOBAL SETTINGS
  // ==========================================================================

  /** Load settings from localStorage with sensible defaults */
  _loadSettings() {
    // Default AI profiles
    const defaultProfiles = [
      { name: 'Groq (Fast & Cheap)', provider: 'groq', apiKey: '', model: 'llama-3.1-8b-instant' },
      { name: 'DeepSeek', provider: 'deepseek', apiKey: '', model: 'deepseek-chat' },
      { name: 'Claude Sonnet', provider: 'anthropic', apiKey: '', model: 'claude-sonnet-4-20250514' },
      { name: 'GPT-4o', provider: 'openai', apiKey: '', model: 'gpt-4o' }
    ];
    const defaults = {
      defaultNodeColor: null,
      bgColor: null,
      connectorColor: null,
      connectorWidth: 2,
      aiProfiles: defaultProfiles,
      activeProfile: 0 // index into aiProfiles
    };
    // 1. Read from config.js for pre-loaded keys
    if (window.__MINDMAP_CONFIG__) {
      const cfg = window.__MINDMAP_CONFIG__;
      // Legacy single-key config
      if (cfg.aiApiKey) {
        defaults.aiProfiles.find(p => p.provider === (cfg.aiProvider || 'anthropic')).apiKey = cfg.aiApiKey;
      }
      // New profiles array in config
      if (cfg.aiProfiles && Array.isArray(cfg.aiProfiles)) {
        cfg.aiProfiles.forEach((cp, i) => {
          if (defaults.aiProfiles[i]) {
            if (cp.apiKey) defaults.aiProfiles[i].apiKey = cp.apiKey;
            if (cp.model) defaults.aiProfiles[i].model = cp.model;
          }
        });
      }
      if (cfg.activeProfile !== undefined) defaults.activeProfile = cfg.activeProfile;
    }
    // 2. localStorage overrides
    try {
      const saved = localStorage.getItem('mindmap-settings');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.aiProfiles) return { ...defaults, ...s };
        // Migrate legacy single-key settings
        if (s.aiApiKey) {
          defaults.aiProfiles.find(p => p.provider === (s.aiProvider || 'anthropic')).apiKey = s.aiApiKey;
        }
        return { ...defaults, ...s, aiProfiles: defaults.aiProfiles };
      }
    } catch (e) { /* ignore */ }
    return defaults;
  }

  /** Get the currently active AI profile */
  _activeProfile() {
    const profiles = this.settings.aiProfiles || [];
    const idx = this.settings.activeProfile || 0;
    return profiles[idx] || profiles[0] || {};
  }

  _saveSettings() {
    localStorage.setItem('mindmap-settings', JSON.stringify(this.settings));
    this._applySettings();
  }

  /** Apply global settings to the DOM / CSS variables */
  _applySettings() {
    const ws = document.getElementById('workspace');
    if (this.settings.bgColor) {
      ws.style.background = this.settings.bgColor;
    } else {
      ws.style.background = ''; // revert to theme
    }
  }

  _showSettings() {
    const s = this.settings;
    this.modalOverlay.classList.remove('hidden');
    document.getElementById('modal-title').textContent = '🎨 Global Settings';

    const profiles = s.aiProfiles || [];
    const activeIdx = s.activeProfile || 0;
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>🤖 Active Model</label>
        <select id="set-active-profile" style="width:100%;padding:7px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);font-size:13px;">
          ${profiles.map((p, i) => `<option value="${i}" ${i === activeIdx ? 'selected' : ''}>${this._escapeHTML(p.name)}${p.apiKey ? ' 🔑' : ''}</option>`).join('')}
        </select>
      </div>
      <div style="max-height:200px;overflow-y:auto;">
      ${profiles.map((p, i) => `
        <div class="form-group" style="padding:8px;margin:4px 0;border:1px solid ${i === activeIdx ? 'var(--accent)' : 'var(--border-light)'};border-radius:6px;">
          <label style="font-size:11px;color:var(--text-muted);">${this._escapeHTML(p.name)} (${p.provider})</label>
          <input type="password" id="set-key-${i}" value="${this._escapeHTML(p.apiKey || '')}" placeholder="API key for ${this._escapeHTML(p.name)}" style="width:100%;padding:5px 8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:11px;margin-top:2px;">
          <input type="text" id="set-model-${i}" value="${this._escapeHTML(p.model || '')}" placeholder="Model ID" style="width:100%;padding:5px 8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:11px;margin-top:2px;">
        </div>
      `).join('')}
      </div>
      <div class="form-group">
        <label>Default Node Color <span style="font-size:10px;color:var(--text-muted)">(applied when no per‑node color is set)</span></label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="color" id="set-node-color" value="${s.defaultNodeColor || '#5b9bd5'}">
          <button class="btn" id="set-node-color-clear" style="font-size:11px;">Use Theme</button>
        </div>
      </div>
      <div class="form-group">
        <label>Workspace Background Color</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="color" id="set-bg-color" value="${s.bgColor || '#f5f5f5'}">
          <button class="btn" id="set-bg-color-clear" style="font-size:11px;">Use Theme</button>
        </div>
      </div>
      <div class="form-group">
        <label>Connector Line Color</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="color" id="set-conn-color" value="${s.connectorColor || '#b0b8c0'}">
          <button class="btn" id="set-conn-color-clear" style="font-size:11px;">Use Theme</button>
        </div>
      </div>
      <div class="form-group">
        <label>Connector Line Width: <span id="set-conn-width-label">${s.connectorWidth}px</span></label>
        <input type="range" id="set-conn-width" min="1" max="6" value="${s.connectorWidth}" style="width:100%;">
      </div>
    `;

    document.getElementById('modal-footer').innerHTML = `
      <button class="btn" id="settings-cancel">Cancel</button>
      <button class="btn primary" id="settings-apply">Apply</button>
    `;

    document.getElementById('settings-cancel').addEventListener('click', () => this._hideModal());
    document.getElementById('settings-apply').addEventListener('click', () => {
      const profiles = this.settings.aiProfiles || [];
      profiles.forEach((p, i) => {
        const keyEl = document.getElementById('set-key-' + i);
        const modelEl = document.getElementById('set-model-' + i);
        if (keyEl) p.apiKey = keyEl.value.trim();
        if (modelEl) p.model = modelEl.value.trim();
      });
      this.settings.activeProfile = parseInt(document.getElementById('set-active-profile').value) || 0;
      this.settings.defaultNodeColor = document.getElementById('set-node-color').value || null;
      this.settings.bgColor = document.getElementById('set-bg-color').value || null;
      this.settings.connectorColor = document.getElementById('set-conn-color').value || null;
      this.settings.connectorWidth = parseInt(document.getElementById('set-conn-width').value);
      this._saveSettings();
      this._updateAll();
      this._hideModal();
      this.toast('Settings applied — using ' + this._activeProfile().name, 'success');
    });

    // Clear buttons
    document.getElementById('set-node-color-clear').addEventListener('click', () => {
      document.getElementById('set-node-color').value = '#5b9bd5';
      this.settings.defaultNodeColor = null;
    });
    document.getElementById('set-bg-color-clear').addEventListener('click', () => {
      document.getElementById('set-bg-color').value = '#f5f5f5';
      this.settings.bgColor = null;
    });
    document.getElementById('set-conn-color-clear').addEventListener('click', () => {
      document.getElementById('set-conn-color').value = '#b0b8c0';
      this.settings.connectorColor = null;
    });
    document.getElementById('set-conn-width').addEventListener('input', (e) => {
      document.getElementById('set-conn-width-label').textContent = e.target.value + 'px';
    });
  }

  // ==========================================================================
  // PROJECT LIST (in sidebar)
  // ==========================================================================

  async _loadProjectList(filter) {
    const container = document.getElementById('project-list');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px;text-align:center;">Loading...</div>';
    try {
      const list = await this.storage.listAll();
      const searchInput = document.getElementById('project-search');
      const query = filter || (searchInput ? searchInput.value.trim().toLowerCase() : '');

      let filtered = list;
      if (query) {
        filtered = list.filter(item => item.title.toLowerCase().includes(query));
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px 6px;text-align:center;">' +
          (query ? 'No match for "' + this._escapeHTML(query) + '"' : 'No projects yet.<br>Press <b>Ctrl+S</b> to save.') +
          '</div>';
      } else {
        container.innerHTML = filtered.map(item => {
          const safeTitle = item.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
          return `
          <div class="project-item${item.title === this.mindmap.title ? ' active' : ''}"
               data-title="${safeTitle}">
            <span class="proj-name" title="${safeTitle}">${safeTitle}</span>
            <span class="proj-date">${item.savedAt ? new Date(item.savedAt).toLocaleDateString() : ''}</span>
            <button class="proj-delete">×</button>
          </div>`;
        }).join('');

        // Bind project item clicks
        container.querySelectorAll('.project-item').forEach(el => {
          el.addEventListener('click', async (e) => {
            if (e.target.closest('.proj-delete')) return; // ignore delete button clicks
            const title = el.dataset.title;
            if (title) await this._loadFromStorage(title);
          });
        });

        // Bind delete buttons
        container.querySelectorAll('.proj-delete').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = btn.closest('.project-item');
            const title = item ? item.dataset.title : '';
            if (title && await this._confirm('Delete "' + title + '"?')) {
              await this.storage.delete(title);
              this._loadProjectList();
            }
          });
        });
      }
    } catch (e) {
      container.innerHTML = '<p style="color:var(--danger);font-size:12px;">Failed to load projects</p>';
    }
  }

  _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.fitToView();
});
