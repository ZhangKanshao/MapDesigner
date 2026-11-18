(() => {
  const basemap = document.getElementById('basemap');
  const viewport = document.getElementById('map-viewport');
  const openButton = document.getElementById('open-map-overlay');
  const fileInput = document.getElementById('map-overlay-file');
  const layer = document.getElementById('map-overlay-layer');
  const picture = document.getElementById('map-overlay-image');
  const handles = document.getElementById('map-overlay-handles');
  const frame = document.getElementById('map-overlay-frame');
  const rotateButton = document.getElementById('rotate-map-overlay');
  const resizeHandles = [...frame.querySelectorAll('[data-overlay-corner], [data-overlay-edge]')];
  const resizeDirections = { n: 90, s: 90, e: 0, w: 0, nw: 45, se: 45, ne: -45, sw: -45 };
  const controls = document.getElementById('map-overlay-controls');
  const adjustmentButtons = controls.querySelectorAll('.overlay-adjustments button');
  const moveButton = document.getElementById('move-map-overlay');
  const removeButton = document.getElementById('remove-map-overlay');
  const opacity = document.getElementById('map-overlay-opacity');
  const status = document.getElementById('map-overlay-status');
  let overlay;
  let drag;
  let repeatTimer;
  let selection = 0;
  let layoutFrame = 0;

  function mapBounds() {
    const view = viewport.getBoundingClientRect();
    const map = basemap.getBoundingClientRect();
    return { left: map.left - view.left, top: map.top - view.top, width: map.width, height: map.height, view };
  }

  function updateLayout() {
    if (!overlay || !viewport.clientWidth || !viewport.clientHeight) return;
    const bounds = mapBounds();
    const x = bounds.left + overlay.x * bounds.width;
    const y = bounds.top + overlay.y * bounds.height;
    const width = bounds.width * overlay.baseWidth * overlay.scaleX;
    const height = bounds.width * overlay.baseWidth * overlay.scaleY / overlay.aspect;
    const radians = overlay.angle * Math.PI / 180;
    const halfHeight = (Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height) / 2;
    const viewWidth = viewport.clientWidth;
    const viewHeight = viewport.clientHeight;

    for (const container of [layer, handles]) {
      container.style.width = `${viewWidth}px`;
      container.style.height = `${viewHeight}px`;
    }
    for (const item of [picture, frame]) {
      item.style.left = `${x - width / 2}px`;
      item.style.top = `${y - height / 2}px`;
      item.style.width = `${width}px`;
      item.style.height = `${height}px`;
      item.style.transform = `rotate(${overlay.angle}deg)`;
    }
    const resizeCursors = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
    for (const handle of resizeHandles) {
      const direction = resizeDirections[handle.dataset.overlayCorner || handle.dataset.overlayEdge];
      handle.style.cursor = resizeCursors[(Math.round((overlay.angle + direction) / 45) % 4 + 4) % 4];
    }
    picture.style.opacity = String(1 - Number(opacity.value) / 100);

    const margin = 8;
    const maxLeft = viewWidth - controls.offsetWidth - margin;
    const maxTop = viewHeight - controls.offsetHeight - margin;
    const below = y + halfHeight + margin;
    const above = y - halfHeight - controls.offsetHeight - margin;
    const top = below > maxTop && above >= margin ? above : below;
    controls.style.left = `${Math.max(margin, Math.min(maxLeft, x - controls.offsetWidth / 2))}px`;
    controls.style.top = `${Math.max(margin, Math.min(maxTop, top))}px`;
  }

  function scheduleLayout() {
    if (!overlay || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      updateLayout();
    });
  }

  function updateOpacity() {
    const value = opacity.value + '%';
    opacity.setAttribute('aria-valuetext', value);
    opacity.nextElementSibling.value = value;
    scheduleLayout();
  }

  function clear() {
    ++selection;
    stopRepeating();
    if (drag?.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id);
    drag = undefined;
    if (overlay) URL.revokeObjectURL(overlay.url);
    overlay = undefined;
    picture.removeAttribute('src');
    layer.hidden = handles.hidden = controls.hidden = status.hidden = true;
  }

  openButton.addEventListener('click', async () => {
    if (!window.mapFiles?.openReferenceImage) {
      fileInput.value = '';
      fileInput.click();
      return;
    }
    const request = ++selection;
    openButton.disabled = true;
    status.hidden = true;
    try {
      const bytes = await window.mapFiles.openReferenceImage();
      if (bytes && request === selection) await showPicture(new Blob([bytes]), request);
    } catch {
      if (request === selection) {
        status.textContent = '无法打开参考图片文件夹或读取图片。';
        status.hidden = false;
      }
    } finally {
      openButton.disabled = false;
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) showPicture(file, ++selection);
  });
  async function showPicture(file, request) {
    const url = URL.createObjectURL(file);
    try {
      const preview = new Image();
      preview.src = url;
      await preview.decode();
      if (request !== selection) return;
      const bounds = mapBounds();
      if (!bounds.width || !bounds.height) throw new Error('底图尚未加载。');
      const aspect = preview.naturalWidth / preview.naturalHeight;
      const left = Math.max(0, bounds.left);
      const top = Math.max(0, bounds.top);
      const visibleWidth = Math.min(viewport.clientWidth, bounds.left + bounds.width) - left;
      const visibleHeight = Math.min(viewport.clientHeight, bounds.top + bounds.height) - top;
      clear();
      overlay = {
        url, aspect,
        x: (left + visibleWidth / 2 - bounds.left) / bounds.width,
        y: (top + visibleHeight / 2 - bounds.top) / bounds.height,
        baseWidth: .65 * Math.min(visibleWidth, visibleHeight * aspect) / bounds.width,
        angle: 0,
        scaleX: 1,
        scaleY: 1,
      };
      opacity.value = opacity.defaultValue;
      picture.src = url;
      layer.hidden = handles.hidden = controls.hidden = false;
      updateOpacity();
    } catch (error) {
      if (request === selection) {
        status.textContent = basemap.naturalWidth ? '无法打开参考图片，请选择有效的图片文件。' : '请等待底图加载后再打开图片。';
        status.hidden = false;
      }
    } finally {
      if (overlay?.url !== url) URL.revokeObjectURL(url);
    }
  }

  opacity.addEventListener('input', updateOpacity);
  removeButton.addEventListener('click', () => { clear(); openButton.focus(); });

  function stopRepeating() {
    clearTimeout(repeatTimer);
  }

  function rotate(angle) {
    overlay.angle = (angle + 540) % 360 - 180;
  }

  function adjust(button) {
    if (!overlay) return;
    if (button.dataset.overlayRotate) {
      rotate(overlay.angle + Number(button.dataset.overlayRotate));
    } else {
      const ratio = 1 + Number(button.dataset.overlayScale) / 100;
      const limited = limitScaleRatio(ratio, overlay.scaleX, overlay.scaleY);
      overlay.scaleX *= limited;
      overlay.scaleY *= limited;
    }
    scheduleLayout();
  }

  for (const button of adjustmentButtons) {
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !overlay) return;
      stopRepeating();
      button.setPointerCapture(event.pointerId);
      adjust(button);
      function repeat() {
        adjust(button);
        repeatTimer = setTimeout(repeat, 65);
      }
      repeatTimer = setTimeout(repeat, 300);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(event, stopRepeating);
    }
    button.addEventListener('click', event => {
      if (event.detail === 0) adjust(button);
    });
  }
  window.addEventListener('blur', stopRepeating);
  window.addEventListener('hashchange', stopRepeating);

  function limitScaleRatio(ratio, ...scales) {
    return Math.min(5 / Math.max(...scales), Math.max(.05 / Math.min(...scales), ratio));
  }

  function resize(start, ratio) {
    const scales = [];
    if (start.resizeX) scales.push(start.scaleX);
    if (start.resizeY) scales.push(start.scaleY);
    ratio = limitScaleRatio(ratio, ...scales);
    const growth = ratio - 1;
    if (start.resizeX) overlay.scaleX = start.scaleX * ratio;
    if (start.resizeY) overlay.scaleY = start.scaleY * ratio;
    overlay.x = start.startX + start.dx * growth / start.bounds.width / 2;
    overlay.y = start.startY + start.dy * growth / start.bounds.height / 2;
  }

  function resizeGeometry(handle) {
    const bounds = mapBounds();
    const side = handle.dataset.overlayCorner || handle.dataset.overlayEdge;
    const width = bounds.width * overlay.baseWidth * overlay.scaleX;
    const height = bounds.width * overlay.baseWidth * overlay.scaleY / overlay.aspect;
    const horizontal = side.includes('w') ? -width : side.includes('e') ? width : 0;
    const vertical = side.includes('n') ? -height : side.includes('s') ? height : 0;
    const radians = overlay.angle * Math.PI / 180;
    return {
      bounds, startX: overlay.x, startY: overlay.y, scaleX: overlay.scaleX, scaleY: overlay.scaleY,
      resizeX: horizontal !== 0, resizeY: vertical !== 0,
      dx: horizontal * Math.cos(radians) - vertical * Math.sin(radians),
      dy: horizontal * Math.sin(radians) + vertical * Math.cos(radians),
    };
  }

  function startDrag(event) {
    if (event.button !== 0 || !event.isPrimary || !overlay || drag) return;
    stopMapDrag();
    const bounds = mapBounds();
    const { clientX: x, clientY: y, currentTarget: handle } = event;
    const centerX = bounds.view.left + bounds.left + overlay.x * bounds.width;
    const centerY = bounds.view.top + bounds.top + overlay.y * bounds.height;
    drag = {
      id: event.pointerId, handle, bounds, x, y, centerX, centerY,
      startX: overlay.x, startY: overlay.y, angle: overlay.angle,
      pointerAngle: Math.atan2(y - centerY, x - centerX),
    };
    if (handle.dataset.overlayCorner || handle.dataset.overlayEdge) Object.assign(drag, resizeGeometry(handle));
    handle.setPointerCapture(event.pointerId);
  }

  function updateDrag(event) {
    if (event.pointerId !== drag?.id) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (drag.handle === moveButton) {
      overlay.x = drag.startX + deltaX / drag.bounds.width;
      overlay.y = drag.startY + deltaY / drag.bounds.height;
    } else if (drag.handle === rotateButton) {
      const pointerAngle = Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX);
      const angle = drag.angle + (pointerAngle - drag.pointerAngle) * 180 / Math.PI;
      rotate(angle);
    } else {
      const projected = deltaX * drag.dx + deltaY * drag.dy;
      resize(drag, 1 + projected / (drag.dx ** 2 + drag.dy ** 2));
    }
    scheduleLayout();
  }

  for (const handle of [moveButton, rotateButton, ...resizeHandles]) {
    handle.addEventListener('pointerdown', startDrag);
    handle.addEventListener('pointermove', updateDrag);
    handle.addEventListener('lostpointercapture', event => {
      if (event.pointerId === drag?.id) drag = undefined;
    });
    if (handle === moveButton) continue;
    handle.addEventListener('keydown', event => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      if (!step || !overlay) return;
      event.preventDefault();
      event.stopPropagation();
      const amount = step * (event.shiftKey ? 10 : 1);
      if (handle === rotateButton) rotate(overlay.angle + amount);
      else resize(resizeGeometry(handle), 1 + amount / 100);
      scheduleLayout();
    });
  }
  moveButton.addEventListener('keydown', event => {
    const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = offsets[event.key];
    if (!direction || !overlay) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = mapBounds();
    const distance = event.shiftKey ? 10 : 1;
    overlay.x += direction[0] * distance / bounds.width;
    overlay.y += direction[1] * distance / bounds.height;
    scheduleLayout();
  });
  viewport.addEventListener('scroll', scheduleLayout);
  window.addEventListener('map-view-change', scheduleLayout);
  window.MapOverlay = { clear };
})();
