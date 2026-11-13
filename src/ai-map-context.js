(() => {
  let geography;

  async function readGeography() {
    if (geography) return geography;
    await Promise.all([loadLookupScript('meta.js'), loadLookupScript('paint-meta.js')]);
    const { meta, paintMeta } = window.MapDesignerData;
    const levels = window.MapTemplate.levels;
    const groupsByLevel = meta.parentOrder.map(level => meta.groups[level].map(group => group && ({
      key: group[0], name: group[1], level: levels[level], plots: []
    })));
    const plots = [];
    meta.locations.forEach((location, id) => {
      const kind = paintMeta.kinds[id];
      if (!location || (kind !== 0 && kind !== 2)) return;
      const parents = groupsByLevel.map((groups, depth) => groups[location[2]?.[depth]]).filter(Boolean);
      plots[id] = { id, key: location[0], name: location[1], kind, district: parents.at(-1)?.name };
      if (kind === 0) for (const group of parents) group.plots.push(id);
    });
    geography = { plots, groups: groupsByLevel.flat().filter(group => group?.plots.length) };
    return geography;
  }

  function meaningfulTitle(titles) {
    return titles.map(value => value?.trim()).find(value => value &&
      !/^(?:snapshot(?:[_-]\d{8}[_-]\d{6})?|untitled|新建地图|未命名(?:地图)?|空白地图)$/iu.test(value)) || undefined;
  }

  async function build(history) {
    const { plots, groups } = await readGeography();
    const countries = window.CountryStore.list();
    const { owners } = window.MapPainting.capture();
    const displayColors = window.CountryStore.displayColors();
    const ids = new Map(countries.map((country, index) => [country.id, index + 1]));
    const byId = new Map(countries.map(country => [country.id, []]));
    for (const [id, owner] of Object.entries(owners)) {
      if (plots[id]) byId.get(owner)?.push(Number(id));
    }

    const recent = history.filter(message => message.role === 'user').slice(-3).map(message => message.content.normalize('NFKC').toLowerCase());
    function relevance(...names) {
      let score = 0;
      for (const name of names) {
        const normalized = name?.normalize('NFKC').toLowerCase();
        if (!normalized || normalized.length < 2) continue;
        recent.forEach((question, index) => {
          if (question.includes(normalized)) score = Math.max(score, normalized.length + index * 1000);
        });
      }
      return score;
    }
    const priority = countries.map(country => ({ country, relevance: relevance(country.name, window.CountryStore.fullName(country)) }));
    priority.sort((a, b) => b.relevance - a.relevance);

    const context = {
      快照标题: meaningfulTitle(window.MapProject.contextTitles()),
      地图模板: window.MapTemplate.name,
      剧本日期: window.MapTemplate.project.scenario,
      国家总数: countries.length,
      国家: [],
      查询匹配: [],
      归属字段: { 整块区划: ['国家编号', '层级', '区划名', '区划键', '普通陆地地块数'], 单独地块: ['国家编号', '地块编号', '地块名', '所属小区划'] },
      整块区划: [], 单独地块: [], 未列归属地块数: 0, 介绍已缩略: false
    };
    const budget = AIMessages.mapContextLimit;
    let remaining = budget - JSON.stringify(context).length - 40;
    function add(array, value, floor = 0) {
      const size = JSON.stringify(value).length + 1;
      if (remaining - size < floor) return false;
      array.push(value);
      remaining -= size;
      return true;
    }

    const included = new Map();
    for (const { country, relevance: score } of priority) {
      const capitalId = country.capital?.locationId;
      const entry = {
        编号: ids.get(country.id), 名称: country.name || '未命名国家', 类型: country.countryType || undefined,
        宗主编号: ids.get(country.suzerainId),
        首都: plots[capitalId] && owners[capitalId] === country.id ? [capitalId, plots[capitalId].name] : undefined,
        显示色: displayColors.get(country.id), 地块总数: byId.get(country.id).length
      };
      if (add(context.国家, entry, budget * .45)) included.set(country.id, entry);
      else if (country.description) context.介绍已缩略 = true;
    }
    const described = priority.filter(({country}) => included.has(country.id) && country.description);
    for (const [index, {country, relevance: score}] of described.entries()) {
      const space = remaining - budget * .45;
      const allowance = score ? space : Math.floor(space / (described.length - index));
      let text = country.description.slice(0, Math.max(0, allowance - 8));
      while (text && JSON.stringify(text).length + 6 > allowance) text = text.slice(0, Math.floor(text.length * .75));
      if (text) { included.get(country.id).介绍 = text; remaining -= JSON.stringify(text).length + 6; }
      if (text !== country.description) context.介绍已缩略 = true;
    }

    const names = new Map(countries.map(country => [country.id, window.CountryStore.fullName(country)]));
    const ownerName = owner => names.get(owner) || (owner ? '未命名国家' : '未着色');
    const matches = [];
    plots.forEach(plot => {
      const score = relevance(plot.name, plot.key);
      if (score) matches.push({ score, plot });
    });
    for (const group of groups) {
      const score = relevance(group.name, group.key);
      if (score) matches.push({ score, group });
    }
    matches.sort((a, b) => b.score - a.score);
    for (const { plot, group } of matches.slice(0, 30)) {
      if (plot) {
        add(context.查询匹配, { 地块: plot.name, 键: plot.key, 编号: plot.id, 小区划: plot.district, 归属: ownerName(owners[plot.id]), 国家编号: ids.get(owners[plot.id]) }, budget * .25);
      } else {
        const counts = new Map();
        for (const id of group.plots) {
          const owner = owners[id];
          counts.set(owner, (counts.get(owner) || 0) + 1);
        }
        const ranked = [...counts].sort((a, b) => b[1] - a[1]);
        add(context.查询匹配, { 区划: group.name, 层级: group.level, 普通陆地地块数: group.plots.length,
          归属统计: ranked.slice(0, 10).map(([owner, count]) => [ownerName(owner), ids.get(owner) ?? null, count]), 统计已缩略: ranked.length > 10 }, budget * .25);
      }
    }

    const covered = new Set();
    for (const group of groups) {
      if (group.plots.length < 2) continue;
      const owner = owners[group.plots[0]];
      if (!included.has(owner) || !group.plots.every(id => owners[id] === owner && !covered.has(id))) continue;
      if (add(context.整块区划, [ids.get(owner), group.level, group.name, group.key, group.plots.length], budget * .12)) {
        for (const id of group.plots) covered.add(id);
      }
    }
    const detailLists = priority.filter(({country}) => included.has(country.id)).map(({country, relevance: score}) => ({
      owner: country.id, plots: byId.get(country.id).filter(id => !covered.has(id)), batch: score ? 12 : 3
    })).filter(entry => entry.plots.length);
    const total = [...byId.values()].reduce((sum, ids) => sum + ids.length, 0);
    while (remaining > 60 && detailLists.length) {
      for (let index = 0; index < detailLists.length;) {
        const entry = detailLists[index];
        const batch = entry.plots.splice(0, entry.batch);
        for (const id of batch) {
          const plot = plots[id];
          if (add(context.单独地块, [ids.get(entry.owner), id, plot.name, plot.district ?? null])) covered.add(id);
        }
        if (!entry.plots.length) detailLists.splice(index, 1);
        else index++;
      }
    }
    context.未列归属地块数 = total - covered.size;
    return JSON.stringify(context);
  }

  window.AIMapContext = { build };
})();
