(function (scope) {
  const value = {
    shortcuts: { undo: 'Ctrl+KeyZ', save: 'Ctrl+KeyS', erase: 'KeyE', names: 'KeyA', boundaries: 'KeyB', country: 'KeyC', zoomIn: 'Equal', zoomOut: 'Minus', scrollUp: 'ArrowUp', scrollDown: 'ArrowDown', scrollLeft: 'ArrowLeft', scrollRight: 'ArrowRight' },
    operations: { wheelMode: 'zoom' },
    fonts: {
      system: '"Segoe UI", "Microsoft YaHei", sans-serif', yahei: '"Microsoft YaHei", sans-serif',
      sans: 'DengXian, "Segoe UI", sans-serif', serif: 'SimSun, "Songti SC", serif',
      kaiti: 'KaiTi, "楷体", serif', heiti: 'SimHei, "黑体", sans-serif', fangsong: 'FangSong, "仿宋", serif',
      arial: 'Arial, "Microsoft YaHei", sans-serif', times: '"Times New Roman", SimSun, serif', mono: 'Consolas, "Microsoft YaHei", monospace'
    },
    appearance: { theme: 'system', font: 'system' }
  };
  value.upgrade = settings => {
    const next = { ...settings, shortcuts: { ...settings.shortcuts }, operations: { ...value.operations, ...settings.operations } };
    const used = new Set(Object.values(next.shortcuts).filter(Boolean));
    for (const [key, binding] of Object.entries(value.shortcuts)) {
      if (!Object.hasOwn(next.shortcuts, key)) { next.shortcuts[key] = used.has(binding) ? '' : binding; if (next.shortcuts[key]) used.add(binding); }
    }
    return next;
  };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else scope.MapSettingsDefaults = value;
})(globalThis);
