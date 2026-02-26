figma.showUI(__html__, { width: 460, height: 700 });

const BLACK_RGBA = { r: 0, g: 0, b: 0, a: 1 };
const WHITE_RGBA = { r: 255, g: 255, b: 255, a: 1 };
const BOUNDS_EPSILON = 0.25;
const MAX_NAV_HISTORY = 100;
const INCLUDE_SURFACES_KEY = 'wcagChecker.includeSurfaces';
const HOVER_OVERLAY_NAME = '__WCAG_HOVER_OVERLAY__';
const HOVER_STROKE_COLOR = { r: 1, g: 0.231, b: 0.188 };
const HOVER_HANDLE_SIZE = 7;

const VECTOR_LIKE_TYPES = {
  VECTOR: true,
  BOOLEAN_OPERATION: true,
  LINE: true,
  ELLIPSE: true,
  STAR: true,
  POLYGON: true
};

const CONTAINER_LIKE_TYPES = {
  FRAME: true,
  GROUP: true,
  COMPONENT: true,
  INSTANCE: true,
  RECTANGLE: true
};

const navigationState = {
  back: [],
  forward: []
};

const runtimeState = {
  initialized: false,
  includeSurfaces: false,
  mutedSelectionChanges: 0
};

const previewState = {
  active: false,
  nodeId: null,
  overlayNodeIds: [],
  requestId: 0
};

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

function toFixed(value, digits) {
  return Number(value).toFixed(digits);
}

function colorToHex(color) {
  if (!color) return null;

  const r = clampByte(color.r).toString(16).padStart(2, '0');
  const g = clampByte(color.g).toString(16).padStart(2, '0');
  const b = clampByte(color.b).toString(16).padStart(2, '0');
  const a = typeof color.a === 'number' ? Math.round(clampUnit(color.a) * 255) : 255;

  if (a < 255) {
    return `#${r}${g}${b}${a.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  return `#${r}${g}${b}`.toUpperCase();
}

function colorToCss(color) {
  if (!color) return null;

  const r = clampByte(color.r);
  const g = clampByte(color.g);
  const b = clampByte(color.b);
  const a = typeof color.a === 'number' ? clampUnit(color.a) : 1;

  return `rgba(${r}, ${g}, ${b}, ${toFixed(a, 3)})`;
}

function formatColor(color) {
  return {
    hex: colorToHex(color),
    css: colorToCss(color)
  };
}

function colorsExactlyMatch(colorA, colorB) {
  if (!colorA || !colorB) return false;
  return colorToHex(colorA) === colorToHex(colorB);
}

function figmaColorToRgba255(color) {
  return {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b),
    a: clampUnit(typeof color.a === 'number' ? color.a : 1)
  };
}

function cloneRgba(color) {
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: color.a
  };
}

function overlayOn(top, bottom) {
  const alpha = clampUnit(top.a);

  if (alpha >= 1) {
    return cloneRgba(top);
  }

  const bottomAlpha = clampUnit(bottom.a);

  return {
    r: top.r * alpha + bottom.r * bottomAlpha * (1 - alpha),
    g: top.g * alpha + bottom.g * bottomAlpha * (1 - alpha),
    b: top.b * alpha + bottom.b * bottomAlpha * (1 - alpha),
    a: alpha + bottomAlpha * (1 - alpha)
  };
}

function relativeLuminance(color) {
  const channels = [color.r, color.g, color.b].map((channel) => {
    const srgb = clampUnit(channel / 255);
    return srgb < 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function calculateContrast(background, foreground) {
  const bg = cloneRgba(background);
  let fg = cloneRgba(foreground);

  if (bg.a >= 1) {
    if (fg.a < 1) {
      fg = overlayOn(fg, bg);
    }

    const l1 = relativeLuminance(bg) + 0.05;
    const l2 = relativeLuminance(fg) + 0.05;
    const ratio = l1 > l2 ? l1 / l2 : l2 / l1;

    return {
      ratio,
      error: 0,
      min: ratio,
      max: ratio
    };
  }

  const onBlack = overlayOn(bg, BLACK_RGBA);
  const onWhite = overlayOn(bg, WHITE_RGBA);
  const contrastOnBlack = calculateContrast(onBlack, fg).ratio;
  const contrastOnWhite = calculateContrast(onWhite, fg).ratio;

  const max = Math.max(contrastOnBlack, contrastOnWhite);
  let min = 1;

  if (relativeLuminance(onBlack) > relativeLuminance(fg)) {
    min = contrastOnBlack;
  } else if (relativeLuminance(onWhite) < relativeLuminance(fg)) {
    min = contrastOnWhite;
  }

  return {
    ratio: (min + max) / 2,
    error: (max - min) / 2,
    min,
    max
  };
}

function getContrastLevels(contrast) {
  const levels = [
    { key: 'fail', lower: 0, upper: 3 },
    { key: 'aa-large', lower: 3, upper: 4.5 },
    { key: 'aa', lower: 4.5, upper: 7 },
    { key: 'aaa', lower: 7, upper: 22 }
  ];

  return levels
    .filter((level) => contrast.min < level.upper && contrast.max >= level.lower)
    .map((level) => level.key);
}

function getPrimaryContrastLevel(contrast) {
  const levels = getContrastLevels(contrast);
  if (levels.length === 1) return levels[0];
  return 'range';
}

function getContrastLabel(level) {
  switch (level) {
    case 'aaa':
      return 'AAA';
    case 'aa':
      return 'AA';
    case 'aa-large':
      return 'AA Large';
    case 'fail':
      return 'Fail';
    default:
      return 'Range';
  }
}

function summarizeContrast(background, foreground, requiredRatio, ruleLabel) {
  const contrast = calculateContrast(background, foreground);
  const level = getPrimaryContrastLevel(contrast);

  const scoreText = contrast.error > 0
    ? `${toFixed(contrast.ratio, 2)} ± ${toFixed(contrast.error, 2)}`
    : `${toFixed(contrast.ratio, 2)}`;

  const rangeText = contrast.error > 0
    ? `${toFixed(contrast.min, 2)} - ${toFixed(contrast.max, 2)}`
    : null;

  return {
    ratio: contrast.ratio,
    error: contrast.error,
    min: contrast.min,
    max: contrast.max,
    scoreText,
    rangeText,
    level,
    levelLabel: getContrastLabel(level),
    requiredRatio,
    ruleLabel,
    passesAALarge: contrast.min >= 3,
    passesAA: contrast.min >= 4.5,
    passesAAA: contrast.min >= 7,
    passesRequired: contrast.min >= requiredRatio,
    isProblematic: contrast.min < requiredRatio,
    uncertainAA: contrast.min < requiredRatio && contrast.max >= requiredRatio
  };
}

function isNodeVisible(node) {
  if (!node || node.visible === false) return false;
  if (typeof node.opacity === 'number' && node.opacity <= 0) return false;
  return true;
}

function getNodeBounds(node) {
  if ('absoluteRenderBounds' in node && node.absoluteRenderBounds) {
    return node.absoluteRenderBounds;
  }

  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) {
    return node.absoluteBoundingBox;
  }

  return null;
}

function isMaskNode(node) {
  return Boolean(node && 'isMask' in node && node.isMask === true);
}

function intersectBounds(a, b) {
  if (!a || !b) return null;

  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  if (x2 <= x1 || y2 <= y1) return null;

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  };
}

function constrainBounds(baseConstraint, nextBounds) {
  if (!nextBounds) {
    return { constraint: baseConstraint, empty: false };
  }

  if (!baseConstraint) {
    return { constraint: nextBounds, empty: false };
  }

  const intersection = intersectBounds(baseConstraint, nextBounds);
  if (!intersection) {
    return { constraint: null, empty: true };
  }

  return { constraint: intersection, empty: false };
}

function getEffectiveBounds(nodeBounds, constraint) {
  if (!nodeBounds) return null;
  if (!constraint) return nodeBounds;
  return intersectBounds(nodeBounds, constraint);
}

function overlaps(a, b) {
  if (!a || !b) return false;

  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

function containsBounds(container, target) {
  if (!container || !target) return false;

  const containerRight = container.x + container.width;
  const containerBottom = container.y + container.height;
  const targetRight = target.x + target.width;
  const targetBottom = target.y + target.height;

  return container.x - BOUNDS_EPSILON <= target.x
    && container.y - BOUNDS_EPSILON <= target.y
    && containerRight + BOUNDS_EPSILON >= targetRight
    && containerBottom + BOUNDS_EPSILON >= targetBottom;
}

function isOpaqueColor(color) {
  return Boolean(color && clampUnit(color.a) >= 0.999);
}

function getBoundsArea(bounds) {
  if (!bounds) return 0;
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

function isNodeWithChildren(node) {
  return Boolean(node && 'children' in node && Array.isArray(node.children) && node.children.length > 0);
}

function isBooleanOperandNode(node) {
  if (!node || !node.parent) return false;
  return node.parent.type === 'BOOLEAN_OPERATION';
}

function isVectorLikeType(type) {
  return Boolean(VECTOR_LIKE_TYPES[type]);
}

function isContainerLikeType(type) {
  return Boolean(CONTAINER_LIKE_TYPES[type]);
}

function isBoldStyleName(styleName) {
  const style = String(styleName || '').toLowerCase();
  return style.includes('bold')
    || style.includes('semibold')
    || style.includes('demibold')
    || style.includes('heavy')
    || style.includes('black')
    || style.includes('extrabold')
    || style.includes('super');
}

function getTextSizeClassification(textNode) {
  if (!textNode || textNode.type !== 'TEXT') {
    return { isLarge: false, isAmbiguous: true };
  }

  if (textNode.fontSize === figma.mixed || typeof textNode.fontSize !== 'number') {
    return { isLarge: false, isAmbiguous: true };
  }

  if (textNode.fontName === figma.mixed || !textNode.fontName || typeof textNode.fontName !== 'object') {
    return { isLarge: false, isAmbiguous: true };
  }

  const fontSize = textNode.fontSize;
  const isBold = isBoldStyleName(textNode.fontName.style);
  const isLargeRegular = fontSize >= 24;
  const isLargeBold = isBold && fontSize >= 18.66;

  return {
    isLarge: isLargeRegular || isLargeBold,
    isAmbiguous: false
  };
}

function classifyLayerRole(entry, frameArea) {
  if (!entry || !entry.node) return 'unknown';
  if (entry.node.type === 'TEXT') return 'text';

  const bounds = entry.bounds;
  const nodeArea = getBoundsArea(bounds);
  const parentArea = Math.max(getBoundsArea(entry.parentEffectiveBounds), 1);
  const frameAreaSafe = Math.max(frameArea, 1);
  const maxDimension = bounds ? Math.max(bounds.width, bounds.height) : 0;

  let iconScore = 0;
  if (isVectorLikeType(entry.layerType)) iconScore += 1;
  if (maxDimension > 0 && maxDimension <= 48) iconScore += 1;
  if (nodeArea > 0 && nodeArea <= 0.15 * parentArea) iconScore += 1;

  let surfaceScore = 0;
  if (isContainerLikeType(entry.layerType)) surfaceScore += 1;
  if (entry.hasChildren) surfaceScore += 1;
  if (nodeArea >= 0.35 * parentArea || nodeArea >= 0.08 * frameAreaSafe) surfaceScore += 1;

  if (iconScore >= 2) return 'icon';
  if (surfaceScore >= 2) return 'surface';
  return 'unknown';
}

function getContrastPolicyForPair(targetEntry, targetRole, backgroundRole, includeSurfaces) {
  if (targetRole === 'text') {
    const textInfo = getTextSizeClassification(targetEntry.node);
    if (textInfo.isLarge) {
      return { requiredRatio: 3, ruleLabel: 'Large Text AA', pairRole: 'text' };
    }
    return { requiredRatio: 4.5, ruleLabel: 'Text AA', pairRole: 'text' };
  }

  if (targetRole === 'icon') {
    return { requiredRatio: 3, ruleLabel: 'Non-text AA', pairRole: 'icon' };
  }

  if (includeSurfaces && targetRole === 'surface' && backgroundRole === 'surface') {
    return { requiredRatio: 3, ruleLabel: 'Non-text AA', pairRole: 'surface', surfaceAudit: true };
  }

  return { requiredRatio: 4.5, ruleLabel: 'Fallback AA', pairRole: targetRole || 'unknown' };
}

function extractFirstSolidPaintColor(paints) {
  if (!Array.isArray(paints)) return null;

  for (const paint of paints) {
    if (!paint || paint.type !== 'SOLID' || paint.visible === false) continue;

    const alpha = typeof paint.opacity === 'number' ? clampUnit(paint.opacity) : 1;
    if (alpha <= 0) continue;

    return {
      r: paint.color.r,
      g: paint.color.g,
      b: paint.color.b,
      a: alpha
    };
  }

  return null;
}

function getNodeSolidColor(node) {
  if (!node || !('fills' in node) || !isNodeVisible(node)) return null;

  const fills = node.fills;
  if (!Array.isArray(fills)) return null;

  return extractFirstSolidPaintColor(fills);
}

function getTargetFrameFromSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) return null;

  let current = selection[0];

  while (current && current.type !== 'PAGE') {
    if (current.type === 'FRAME') {
      return current;
    }
    current = current.parent;
  }

  return null;
}

function getNodeLabel(node) {
  return node.name || node.type;
}

function getNodePath(node, frame) {
  const parts = [];
  let current = node;

  while (current && current !== frame && current.type !== 'PAGE') {
    parts.unshift(getNodeLabel(current));
    current = current.parent;
  }

  return parts.join(' / ');
}

function getNavigationAvailability() {
  return {
    canGoBack: navigationState.back.length > 0,
    canGoForward: navigationState.forward.length > 0
  };
}

function postNavigationState() {
  figma.ui.postMessage({
    type: 'navigation-state',
    payload: getNavigationAvailability()
  });
}

function getPageForNode(node) {
  let current = node;

  while (current && current.type !== 'PAGE') {
    current = current.parent;
  }

  return current && current.type === 'PAGE' ? current : null;
}

function isSceneNode(node) {
  return Boolean(node && node.type !== 'DOCUMENT' && node.type !== 'PAGE');
}

function createViewportSnapshot() {
  try {
    return {
      center: { x: figma.viewport.center.x, y: figma.viewport.center.y },
      zoom: figma.viewport.zoom
    };
  } catch (_error) {
    return null;
  }
}

function captureViewState() {
  return {
    pageId: figma.currentPage.id,
    selectionIds: figma.currentPage.selection.map((node) => node.id),
    viewport: createViewportSnapshot()
  };
}

async function runWithMutedSelectionChanges(fn) {
  runtimeState.mutedSelectionChanges += 1;

  try {
    return await fn();
  } finally {
    runtimeState.mutedSelectionChanges = Math.max(0, runtimeState.mutedSelectionChanges - 1);
  }
}

function roughlyEqual(a, b, epsilon) {
  return Math.abs(a - b) <= epsilon;
}

function areViewStatesEqual(a, b) {
  if (!a || !b) return false;
  if (a.pageId !== b.pageId) return false;
  if (a.selectionIds.length !== b.selectionIds.length) return false;

  for (let i = 0; i < a.selectionIds.length; i += 1) {
    if (a.selectionIds[i] !== b.selectionIds[i]) return false;
  }

  if (!a.viewport && !b.viewport) return true;
  if (!a.viewport || !b.viewport) return false;

  return roughlyEqual(a.viewport.center.x, b.viewport.center.x, 0.5)
    && roughlyEqual(a.viewport.center.y, b.viewport.center.y, 0.5)
    && roughlyEqual(a.viewport.zoom, b.viewport.zoom, 0.0001);
}

function pushHistoryState(stack, state) {
  if (!state) return false;

  const previous = stack.length > 0 ? stack[stack.length - 1] : null;
  if (previous && areViewStatesEqual(previous, state)) return false;

  stack.push(state);

  if (stack.length > MAX_NAV_HISTORY) {
    stack.shift();
  }

  return true;
}

function popHistoryState(stack) {
  if (stack.length === 0) return null;
  return stack.pop();
}

function clearHistory(stack) {
  stack.length = 0;
}

function resetPreviewState() {
  previewState.active = false;
  previewState.nodeId = null;
  previewState.overlayNodeIds = [];
}

function invalidatePreviewRequests() {
  previewState.requestId += 1;
}

function restoreViewport(viewportSnapshot) {
  if (
    !viewportSnapshot
    || !viewportSnapshot.center
    || typeof viewportSnapshot.zoom !== 'number'
  ) {
    return false;
  }

  try {
    figma.viewport.center = {
      x: viewportSnapshot.center.x,
      y: viewportSnapshot.center.y
    };
    figma.viewport.zoom = viewportSnapshot.zoom;
    return true;
  } catch (_error) {
    return false;
  }
}

async function getNodeByIdSafe(nodeId) {
  if (typeof figma.getNodeByIdAsync === 'function') {
    return figma.getNodeByIdAsync(nodeId);
  }

  return figma.getNodeById(nodeId);
}

async function getPageByIdSafe(pageId) {
  const node = await getNodeByIdSafe(pageId);
  if (node && node.type === 'PAGE') return node;
  return null;
}

async function applySelectionState(selectionState) {
  if (!selectionState) return false;

  const page = await getPageByIdSafe(selectionState.pageId);
  if (!page) return false;

  if (figma.currentPage.id !== page.id) {
    await figma.setCurrentPageAsync(page);
  }

  const restoredSelection = [];

  for (const nodeId of selectionState.selectionIds) {
    const node = await getNodeByIdSafe(nodeId);
    if (!node || !isSceneNode(node)) continue;

    const pageForNode = getPageForNode(node);
    if (!pageForNode || pageForNode.id !== figma.currentPage.id) continue;

    restoredSelection.push(node);
  }

  figma.currentPage.selection = restoredSelection;
  return true;
}

async function restoreViewState(viewState) {
  const page = await getPageByIdSafe(viewState.pageId);
  if (!page) {
    return { ok: false, error: 'Previous page no longer exists.' };
  }

  if (figma.currentPage.id !== page.id) {
    await figma.setCurrentPageAsync(page);
  }

  const restoredSelection = [];

  for (const nodeId of viewState.selectionIds) {
    const node = await getNodeByIdSafe(nodeId);
    if (!node || !isSceneNode(node)) continue;

    const pageForNode = getPageForNode(node);
    if (!pageForNode || pageForNode.id !== figma.currentPage.id) continue;

    restoredSelection.push(node);
  }

  figma.currentPage.selection = restoredSelection;

  if (restoredSelection.length > 0) {
    figma.viewport.scrollAndZoomIntoView(restoredSelection);
    return { ok: true };
  }

  const viewportRestored = restoreViewport(viewState.viewport);
  if (!viewportRestored) {
    return { ok: true, warning: 'Selection restored without viewport snapshot.' };
  }

  return { ok: true };
}

async function clearPreview(restoreSource, options) {
  void restoreSource;
  const preserveRequest = Boolean(options && options.preserveRequest);
  if (!preserveRequest) {
    invalidatePreviewRequests();
  }

  const overlayNodeIds = Array.isArray(previewState.overlayNodeIds)
    ? [...previewState.overlayNodeIds]
    : [];

  resetPreviewState();

  for (const overlayNodeId of overlayNodeIds) {
    const overlayNode = await getNodeByIdSafe(overlayNodeId);
    if (!overlayNode || !isSceneNode(overlayNode)) continue;

    try {
      overlayNode.remove();
    } catch (_error) {
      // Ignore remove errors for stale or already removed overlay nodes.
    }
  }
}

async function previewLayerById(nodeId) {
  if (!nodeId) return;

  const requestId = previewState.requestId + 1;
  previewState.requestId = requestId;

  if (previewState.active && previewState.nodeId === nodeId) {
    return;
  }

  if (previewState.active) {
    await clearPreview(true, { preserveRequest: true });
  }

  const node = await getNodeByIdSafe(nodeId);
  if (requestId !== previewState.requestId) return;
  if (!node || !isSceneNode(node)) return;

  const page = getPageForNode(node);
  if (!page || page.id !== figma.currentPage.id) return;
  const bounds = getNodeBounds(node);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

  const createOverlayHandle = (x, y) => {
    const handle = figma.createRectangle();
    handle.name = HOVER_OVERLAY_NAME;
    handle.resizeWithoutConstraints(HOVER_HANDLE_SIZE, HOVER_HANDLE_SIZE);
    handle.x = x - HOVER_HANDLE_SIZE / 2;
    handle.y = y - HOVER_HANDLE_SIZE / 2;
    handle.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    handle.strokes = [{ type: 'SOLID', color: HOVER_STROKE_COLOR }];
    handle.strokeWeight = 1;
    handle.cornerRadius = 1;
    handle.locked = true;
    return handle;
  };

  const outline = figma.createRectangle();
  outline.name = HOVER_OVERLAY_NAME;
  outline.resizeWithoutConstraints(Math.max(1, bounds.width), Math.max(1, bounds.height));
  outline.x = bounds.x;
  outline.y = bounds.y;
  outline.fills = [];
  outline.strokes = [{ type: 'SOLID', color: HOVER_STROKE_COLOR }];
  outline.strokeWeight = 1.25;
  outline.locked = true;

  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const handles = [
    createOverlayHandle(bounds.x, bounds.y),
    createOverlayHandle(right, bounds.y),
    createOverlayHandle(bounds.x, bottom),
    createOverlayHandle(right, bottom)
  ];
  const overlayNodes = [outline, ...handles];

  if (requestId !== previewState.requestId) {
    for (const overlayNode of overlayNodes) {
      try {
        overlayNode.remove();
      } catch (_error) {
        // Ignore cleanup errors for stale overlay nodes.
      }
    }
    return;
  }

  for (const overlayNode of overlayNodes) {
    overlayNode.locked = true;
  }

  previewState.active = true;
  previewState.nodeId = nodeId;
  previewState.overlayNodeIds = overlayNodes.map((overlayNode) => overlayNode.id);
}

async function focusLayerById(nodeId) {
  let beforeState = captureViewState();
  let backPushed = false;

  try {
    invalidatePreviewRequests();

    if (previewState.active) {
      await clearPreview(true, { preserveRequest: true });
    }

    const node = await getNodeByIdSafe(nodeId);

    if (!node) {
      figma.ui.postMessage({
        type: 'focus-result',
        payload: { ok: false, nodeId, error: 'Layer no longer exists.' }
      });
      return;
    }

    if (!isSceneNode(node)) {
      figma.ui.postMessage({
        type: 'focus-result',
        payload: { ok: false, nodeId, error: 'Target node is not selectable.' }
      });
      return;
    }

    const page = getPageForNode(node);
    if (!page) {
      figma.ui.postMessage({
        type: 'focus-result',
        payload: { ok: false, nodeId, error: 'Could not resolve the node page.' }
      });
      return;
    }

    if (figma.currentPage.id !== page.id) {
      await figma.setCurrentPageAsync(page);
    }

    backPushed = pushHistoryState(navigationState.back, beforeState);
    if (backPushed) {
      clearHistory(navigationState.forward);
    }

    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);

    figma.ui.postMessage({
      type: 'focus-result',
      payload: { ok: true, nodeId }
    });
    postNavigationState();
  } catch (error) {
    if (backPushed) {
      popHistoryState(navigationState.back);
    }

    figma.ui.postMessage({
      type: 'focus-result',
      payload: {
        ok: false,
        nodeId,
        error: error && error.message ? error.message : 'Failed to focus layer.'
      }
    });
    postNavigationState();
  }
}

async function navigateHistory(direction) {
  invalidatePreviewRequests();

  if (previewState.active) {
    await clearPreview(true, { preserveRequest: true });
  }

  const fromStack = direction === 'back' ? navigationState.back : navigationState.forward;
  const toStack = direction === 'back' ? navigationState.forward : navigationState.back;

  const targetState = popHistoryState(fromStack);
  if (!targetState) {
    postNavigationState();
    return;
  }

  const currentState = captureViewState();
  const pushed = pushHistoryState(toStack, currentState);
  const restoreResult = await restoreViewState(targetState);

  if (!restoreResult.ok) {
    if (pushed) {
      popHistoryState(toStack);
    }
    pushHistoryState(fromStack, targetState);

    figma.ui.postMessage({
      type: 'focus-result',
      payload: {
        ok: false,
        nodeId: null,
        error: restoreResult.error || 'Could not restore previous view.'
      }
    });

    postNavigationState();
    return;
  }

  sendReport();
  postNavigationState();
}

function collectPaintLayers(node, frame, context, paintLayers, reportTargets) {
  if (!isNodeVisible(node) || context.empty) return;
  if (isBooleanOperandNode(node)) return;

  const nodeBounds = getNodeBounds(node);
  const effectiveBounds = getEffectiveBounds(nodeBounds, context.constraint);
  if (nodeBounds && !effectiveBounds) return;

  const solidColor = getNodeSolidColor(node);
  const nodeIsMask = isMaskNode(node);

  if (solidColor && effectiveBounds && !nodeIsMask) {
    const parentNode = node.parent && node.parent.type !== 'PAGE' ? node.parent : null;
    const parentRawBounds = parentNode ? getNodeBounds(parentNode) : null;
    const parentEffectiveBounds = getEffectiveBounds(parentRawBounds, context.constraint) || context.constraint || parentRawBounds || null;

    const entry = {
      node,
      nodeId: node.id,
      paintIndex: paintLayers.length,
      layerName: getNodeLabel(node),
      layerType: node.type,
      layerPath: getNodePath(node, frame),
      bounds: effectiveBounds,
      parentEffectiveBounds,
      hasChildren: isNodeWithChildren(node),
      color: solidColor,
      analysis: {
        masked: context.masked,
        clipped: context.clipped,
        bestEffortMask: context.bestEffortMask,
        multiMask: context.multiMask
      }
    };

    paintLayers.push(entry);

    if (node !== frame) {
      reportTargets.push(entry);
    }
  }

  if (!isNodeWithChildren(node)) {
    return;
  }

  if (node.type === 'BOOLEAN_OPERATION') {
    return;
  }

  let baseConstraint = context.constraint;
  let baseEmpty = context.empty;
  let baseClipped = context.clipped;

  if (nodeBounds && 'clipsContent' in node && node.clipsContent === true) {
    const clippedResult = constrainBounds(baseConstraint, nodeBounds);
    baseConstraint = clippedResult.constraint;
    baseEmpty = clippedResult.empty;
    baseClipped = true;
  }

  if (baseEmpty) return;

  let activeMaskConstraint = null;
  let maskCount = 0;

  for (const child of node.children) {
    let childConstraint = baseConstraint;
    let childEmpty = false;
    let childMasked = context.masked;
    let childBestEffortMask = context.bestEffortMask;
    let childMultiMask = context.multiMask;

    if (activeMaskConstraint) {
      const maskedResult = constrainBounds(childConstraint, activeMaskConstraint);
      childConstraint = maskedResult.constraint;
      childEmpty = maskedResult.empty;
      childMasked = true;
      childBestEffortMask = true;
      childMultiMask = childMultiMask || maskCount > 1;
    }

    collectPaintLayers(child, frame, {
      constraint: childConstraint,
      empty: childEmpty,
      masked: childMasked,
      clipped: baseClipped,
      bestEffortMask: childBestEffortMask,
      multiMask: childMultiMask
    }, paintLayers, reportTargets);

    if (isNodeVisible(child) && isMaskNode(child)) {
      maskCount += 1;

      const maskBounds = getNodeBounds(child);
      if (!maskBounds) {
        activeMaskConstraint = null;
      } else {
        const maskResult = constrainBounds(baseConstraint, maskBounds);
        activeMaskConstraint = maskResult.empty ? null : maskResult.constraint;
      }
    }
  }
}

function findDirectBackground(target, paintLayers, targetIndex) {
  for (let i = targetIndex - 1; i >= 0; i -= 1) {
    const candidate = paintLayers[i];
    if (!candidate.bounds || !target.bounds) continue;
    if (!overlaps(target.bounds, candidate.bounds)) continue;
    return candidate;
  }

  return null;
}

function findUpperOpaqueCover(target, paintLayers, targetIndex) {
  for (let i = targetIndex + 1; i < paintLayers.length; i += 1) {
    const candidate = paintLayers[i];
    if (!candidate.bounds || !target.bounds) continue;
    if (!isOpaqueColor(candidate.color)) continue;
    if (!containsBounds(candidate.bounds, target.bounds)) continue;
    return candidate;
  }

  return null;
}

function buildLayerReport(frame) {
  const paintLayers = [];
  const reportTargets = [];
  const frameBounds = getNodeBounds(frame);
  const frameArea = Math.max(getBoundsArea(frameBounds), 1);

  collectPaintLayers(frame, frame, {
    constraint: frameBounds,
    empty: false,
    masked: false,
    clipped: false,
    bestEffortMask: false,
    multiMask: false
  }, paintLayers, reportTargets);

  const roleCache = {};
  const getRole = (entry) => {
    if (!entry) return 'unknown';
    if (roleCache[entry.nodeId]) return roleCache[entry.nodeId];

    const role = classifyLayerRole(entry, frameArea);
    roleCache[entry.nodeId] = role;
    return role;
  };

  let hiddenSameColorLayers = 0;
  let hiddenCoveredLayers = 0;
  let hiddenSurfacePairs = 0;

  const items = reportTargets.map((target) => {
    const targetIndex = target.paintIndex;
    const coveringLayer = findUpperOpaqueCover(target, paintLayers, targetIndex);

    if (coveringLayer) {
      hiddenCoveredLayers += 1;
      return null;
    }

    const backgroundLayer = findDirectBackground(target, paintLayers, targetIndex);

    if (backgroundLayer && colorsExactlyMatch(target.color, backgroundLayer.color)) {
      hiddenSameColorLayers += 1;
      return null;
    }

    const targetRole = getRole(target);
    const backgroundRole = backgroundLayer ? getRole(backgroundLayer) : 'unknown';

    if (!runtimeState.includeSurfaces && targetRole === 'surface' && backgroundRole === 'surface') {
      hiddenSurfacePairs += 1;
      return null;
    }

    const policy = getContrastPolicyForPair(
      target,
      targetRole,
      backgroundRole,
      runtimeState.includeSurfaces
    );

    const foreground = formatColor(target.color);
    const background = backgroundLayer ? formatColor(backgroundLayer.color) : null;

    let contrast = null;
    if (backgroundLayer) {
      contrast = summarizeContrast(
        figmaColorToRgba255(backgroundLayer.color),
        figmaColorToRgba255(target.color),
        policy.requiredRatio,
        policy.ruleLabel
      );
    }

    const analysisBadges = [];
    const analysisWarnings = [];

    if (target.analysis.masked) {
      analysisBadges.push('Masked');
      analysisWarnings.push('Mask handling is best effort (bounding-box approximation).');
    }

    if (target.analysis.multiMask) {
      analysisBadges.push('Multi-mask');
      analysisWarnings.push('Multiple masks in this scope can reduce accuracy.');
    }

    if (target.analysis.clipped) {
      analysisBadges.push('Clipped');
    }

    if (policy.surfaceAudit) {
      analysisBadges.push('Surface audit');
    }

    if (target.analysis.bestEffortMask && contrast) {
      contrast.bestEffort = true;
    }

    return {
      id: target.nodeId,
      layerName: target.layerName,
      layerType: target.layerType,
      layerPath: target.layerPath,
      pairRole: policy.pairRole,
      requiredRatio: policy.requiredRatio,
      ruleLabel: policy.ruleLabel,
      foreground,
      foregroundNote: null,
      background,
      backgroundLayerName: backgroundLayer
        ? backgroundLayer.node === frame
          ? `${frame.name} (Frame Fill)`
          : backgroundLayer.layerName
        : 'No visible solid layer behind',
      backgroundLayerPath: backgroundLayer
        ? backgroundLayer.node === frame
          ? frame.name
          : backgroundLayer.layerPath
        : null,
      backgroundNote: backgroundLayer ? null : 'Could not find a visible solid background color',
      contrast,
      analysisBadges,
      analysisWarnings
    };
  }).filter((item) => item !== null);

  const bestEffortLayers = items.filter((item) => Array.isArray(item.analysisWarnings) && item.analysisWarnings.length > 0).length;

  return {
    frameName: frame.name,
    includeSurfaces: runtimeState.includeSurfaces,
    totalLayers: items.length,
    scoredLayers: items.filter((item) => item.contrast).length,
    problematicLayers: items.filter((item) => item.contrast && item.contrast.isProblematic).length,
    bestEffortLayers,
    hiddenSameColorLayers,
    hiddenCoveredLayers,
    hiddenSurfacePairs,
    items
  };
}

async function updateIncludeSurfacesPreference(value) {
  runtimeState.includeSurfaces = value;

  try {
    await figma.clientStorage.setAsync(INCLUDE_SURFACES_KEY, value);
  } catch (_error) {
    // Keep runtime state even if persistence fails.
  }

  sendReport();
}

async function initializeSettings() {
  try {
    const stored = await figma.clientStorage.getAsync(INCLUDE_SURFACES_KEY);
    if (typeof stored === 'boolean') {
      runtimeState.includeSurfaces = stored;
    }
  } catch (_error) {
    runtimeState.includeSurfaces = false;
  }

  runtimeState.initialized = true;
  sendReport();
  postNavigationState();
}

function sendReport() {
  if (!runtimeState.initialized) return;

  const frame = getTargetFrameFromSelection();

  if (!frame) {
    figma.ui.postMessage({
      type: 'report',
      payload: {
        error: 'Select one frame (or any layer inside a frame) to analyze nested layers.',
        frameName: null,
        includeSurfaces: runtimeState.includeSurfaces,
        totalLayers: 0,
        scoredLayers: 0,
        problematicLayers: 0,
        bestEffortLayers: 0,
        hiddenSameColorLayers: 0,
        hiddenCoveredLayers: 0,
        hiddenSurfacePairs: 0,
        navigation: getNavigationAvailability(),
        items: []
      }
    });
    return;
  }

  const reportPayload = buildLayerReport(frame);
  reportPayload.navigation = getNavigationAvailability();

  figma.ui.postMessage({
    type: 'report',
    payload: reportPayload
  });
}

function handleSelectionChange() {
  if (runtimeState.mutedSelectionChanges > 0) {
    return;
  }

  invalidatePreviewRequests();

  if (previewState.active) {
    clearPreview(true, { preserveRequest: true }).catch(() => {
      // Ignore stale overlay cleanup errors during editor selection changes.
    });
  }

  sendReport();
}

figma.on('selectionchange', handleSelectionChange);

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'preview-layer' && typeof msg.nodeId === 'string') {
    previewLayerById(msg.nodeId).catch(() => {
      // Ignore hover preview errors; click-focus remains the reliable action.
    });
    return;
  }

  if (msg.type === 'clear-preview') {
    clearPreview(true).catch(() => {
      // Ignore clear-preview errors to keep UI responsive.
    });
    return;
  }

  if (msg.type === 'focus-layer' && typeof msg.nodeId === 'string') {
    previewLayerById(msg.nodeId).then(() => {
      figma.ui.postMessage({
        type: 'focus-result',
        payload: { ok: true, nodeId: msg.nodeId }
      });
    }).catch((error) => {
      figma.ui.postMessage({
        type: 'focus-result',
        payload: {
          ok: false,
          nodeId: msg.nodeId,
          error: error && error.message ? error.message : 'Failed to highlight layer.'
        }
      });
    });
    return;
  }

  if (msg.type === 'set-include-surfaces' && typeof msg.includeSurfaces === 'boolean') {
    updateIncludeSurfacesPreference(msg.includeSurfaces);
  }
};

figma.on('close', () => {
  clearPreview(true, { preserveRequest: true }).catch(() => {
    // Best-effort cleanup for temporary highlight overlays.
  });
});

initializeSettings();
