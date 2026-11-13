(() => {
  const assets = new Map();
  const options = () => ({ classic: '经典地图', terrain: '地形图' });
  const valid = style => Object.hasOwn(options(), style);

  function loadImage(file) {
    if (!assets.has(file)) {
      const url = new URL(`assets/maps/styles/${file}`, document.baseURI);
      assets.set(file, loadMapAsset(url.href).catch(() => {
        assets.delete(file);
        throw new Error('地图风格资源加载失败。');
      }));
    }
    return assets.get(file);
  }
  async function load(style) {
    if (style === 'classic') return null;
    const game = window.MapTemplate.game;
    const [land, ocean] = await Promise.all([
      loadImage(`${game}-relief.png`),
      loadImage(`${game}-bathymetry.png`),
    ]);
    return { land, ocean };
  }

  window.MapStyles = { options, valid, load };
})();
