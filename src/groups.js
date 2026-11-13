(() => {
  const storageKey = `mapdesigner.${window.MapTemplate.key}.groups.v1`;
  const dialog = document.getElementById('group-dialog');
  const form = document.getElementById('group-form');
  const title = document.getElementById('group-dialog-title');
  const nameInput = document.getElementById('group-name');
  const descriptionInput = document.getElementById('group-description');
  const colorInput = document.getElementById('group-color');
  const members = document.getElementById('group-members');
  const deleteButton = document.getElementById('delete-group');
  const error = document.getElementById('group-error');
  const list = document.getElementById('group-list');
  const empty = document.getElementById('groups-empty');
  const pickStatus = document.getElementById('group-pick-status');
  let groups = [];
  let editingId = null;
  let outlineRevision = 0;
  let memberPick = null;
  const defaultColor = '#42667f';

  function availableColor(color, used) {
    let rgb = parseInt(color.slice(1), 16);
    while (used.has(color)) {
      rgb = (rgb + 0x170d23) % 0x1000000;
      color = '#' + rgb.toString(16).padStart(6, '0');
    }
    return color;
  }

  function updateMemberPick(message = '') {
    viewport.classList.toggle('group-pick-mode', Boolean(memberPick));
    pickStatus.textContent = message;
    pickStatus.title = message;
    pickStatus.hidden = !message;
    for (const button of list.querySelectorAll('.group-member-action')) {
      const active = memberPick?.groupId === button.dataset.groupId && memberPick.action === button.dataset.action;
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function cancelMemberPick() {
    if (!memberPick) return;
    memberPick = null;
    updateMemberPick();
  }

  function startMemberPick(group, action) {
    if (memberPick?.groupId === group.id && memberPick.action === action) {
      cancelMemberPick();
      return;
    }
    stopMapDrag();
    window.CountryStore.select(null);
    if (namesEnabled) nameButton.click();
    memberPick = { groupId: group.id, action };
    const operation = action === 'add' ? '加入' : '移除';
    updateMemberPick(`点击已着色地块，${operation}成员。Esc 退出。`);
  }

  async function pickMember(point) {
    const pick = memberPick;
    try {
      const location = await window.MapPainting.locationAtPoint(point);
      await window.MapPainting.whenIdle();
      if (memberPick !== pick || document.querySelector('dialog[open]')) return;
      const owner = location && location.kind !== 1 && window.MapPainting.ownerOf(location.id);
      const country = window.CountryStore.list().find(entry => entry.id === owner);
      if (!country) {
        updateMemberPick('请点击已着色的国家领土。Esc 退出。');
        return;
      }
      const group = groups.find(entry => entry.id === pick.groupId);
      const adding = pick.action === 'add';
      const name = window.CountryStore.fullName(country) || '未命名国家';
      if (group.memberIds.includes(owner) === adding) {
        updateMemberPick(adding ? `${name}已在集团中。` : `${name}不在集团中。`);
        return;
      }
      const memberIds = adding ? [...group.memberIds, owner] : group.memberIds.filter(id => id !== owner);
      commit(groups.map(entry => entry === group ? { ...entry, memberIds } : entry), adding ? '加入集团' : '退出集团');
      updateMemberPick(adding ? `已加入${name}。Esc 退出。` : `已移除${name}。Esc 退出。`);
    } catch {
      if (memberPick === pick) updateMemberPick('无法更新集团成员，请重试。');
    }
  }

  function validate(entries) {
    if (!Array.isArray(entries) || entries.length > 10000) throw new Error('集团列表无效。');
    const ids = new Set();
    const validated = entries.map(group => {
      if (!group || typeof group.id !== 'string' || !/^[\w-]{1,100}$/.test(group.id) || ids.has(group.id) ||
          typeof group.name !== 'string' || !group.name.trim() || group.name.length > 100 ||
          typeof group.description !== 'string' || group.description.length > 2000 ||
          typeof group.color !== 'string' || !/^#[\da-f]{6}$/i.test(group.color)) {
        throw new Error('集团数据无效。');
      }
      ids.add(group.id);
      const memberIds = group.memberIds === undefined ? [] : group.memberIds;
      if (!Array.isArray(memberIds) || memberIds.length > 10000 ||
          memberIds.some(id => typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))) {
        throw new Error('集团成员无效。');
      }
      return { id: group.id, name: group.name.trim(), description: group.description,
        color: group.color.toLowerCase(), memberIds: [...new Set(memberIds)] };
    });
    // Keep the first occurrence and preserve every distinct color in older maps.
    const used = new Set(validated.map(group => group.color));
    const seen = new Set();
    for (const group of validated) {
      if (seen.has(group.color)) {
        group.color = availableColor(group.color, used);
        used.add(group.color);
      }
      seen.add(group.color);
    }
    return validated;
  }

  function renderMembers(selectedIds) {
    const selected = new Set(selectedIds);
    const countries = window.CountryStore.list();
    members.replaceChildren();
    if (!countries.length) {
      const empty = document.createElement('p');
      empty.textContent = '地图上还没有国家。';
      members.append(empty);
      return;
    }
    for (const country of countries) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = country.id;
      checkbox.checked = selected.has(country.id);
      label.append(checkbox, window.CountryStore.fullName(country) || '未命名国家');
      members.append(label);
    }
    members.scrollTop = 0;
  }

  function open(group) {
    stopMapDrag();
    cancelMemberPick();
    editingId = group?.id ?? null;
    title.textContent = group ? '集团信息' : '创建集团';
    nameInput.value = group?.name ?? '';
    descriptionInput.value = group?.description ?? '';
    colorInput.value = group?.color ?? availableColor(defaultColor, new Set(groups.map(entry => entry.color)));
    renderMembers(group?.memberIds ?? []);
    deleteButton.hidden = !group;
    error.hidden = true;
    dialog.showModal();
  }

  function render() {
    const rows = groups.map(group => {
      const row = document.createElement('li');
      row.className = 'group-list-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'group-select';
      button.addEventListener('click', () => open(group));
      const swatch = document.createElement('span');
      swatch.className = 'country-list-swatch';
      swatch.style.backgroundColor = group.color;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'country-name';
      label.textContent = group.name;
      button.append(swatch, label);
      row.append(button);
      for (const [action, symbol, description] of [['add', '＋', '添加成员'], ['remove', '−', '移除成员']]) {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'group-member-action';
        control.dataset.groupId = group.id;
        control.dataset.action = action;
        control.textContent = symbol;
        control.title = description;
        control.setAttribute('aria-label', `${group.name}：${description}`);
        control.addEventListener('click', () => startMemberPick(group, action));
        row.append(control);
      }
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = groups.length !== 0;
    updateMemberPick(pickStatus.textContent);
  }

  function restore(entries) {
    groups = validate(entries);
    if (memberPick && !groups.some(group => group.id === memberPick.groupId)) cancelMemberPick();
    try { localStorage.setItem(storageKey, JSON.stringify(groups)); } catch {}
    render();
    outlineRevision++;
    window.MapPainting?.redraw();
  }

  function commit(entries, label) {
    const before = groups;
    restore(entries);
    window.dispatchEvent(new CustomEvent('groups-changed', { detail: { before, label } }));
  }

  function updateMemberships(selections) {
    const next = groups.map(group => {
      const memberIds = new Set(group.memberIds);
      for (const [countryId, groupIds] of selections) {
        if (groupIds.has(group.id)) memberIds.add(countryId);
        else memberIds.delete(countryId);
      }
      if (memberIds.size === group.memberIds.length && group.memberIds.every(id => memberIds.has(id))) return group;
      return { ...group, memberIds: [...memberIds] };
    });
    if (next.every((group, index) => group === groups[index])) return;
    const before = groups;
    restore(next);
    return before;
  }

  try { groups = validate(JSON.parse(localStorage.getItem(storageKey) ?? '[]')); } catch {}
  render();
  document.getElementById('create-group').addEventListener('click', () => open());
  for (const id of ['close-group-dialog', 'cancel-group']) {
    document.getElementById(id).addEventListener('click', () => dialog.close());
  }
  window.addEventListener('hashchange', () => { if (dialog.open) dialog.close(); });
  for (const event of ['hashchange', 'country-selection', 'name-mode-enabled']) {
    window.addEventListener(event, cancelMemberPick);
  }
  for (const id of ['pick-country', 'toggle-group-list']) {
    document.getElementById(id).addEventListener('click', cancelMemberPick);
  }
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !memberPick || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    cancelMemberPick();
  });
  deleteButton.addEventListener('click', () => {
    if (!editingId) return;
    commit(groups.filter(group => group.id !== editingId), '删除集团');
    dialog.close();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = '请输入集团名称。';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    const memberIds = Array.from(members.querySelectorAll('input:checked'), input => input.value);
    const color = colorInput.value;
    if (groups.some(group => group.id !== editingId && group.color === color)) {
      error.textContent = '此颜色已被其他集团使用，请更换颜色。';
      error.hidden = false;
      colorInput.focus();
      return;
    }
    const group = { id: editingId ?? crypto.randomUUID(), name, description: descriptionInput.value.trim(), color, memberIds };
    const previous = groups.find(entry => entry.id === editingId);
    if (JSON.stringify(previous) === JSON.stringify(group)) {
      dialog.close();
      return;
    }
    const next = editingId ? groups.map(entry => entry.id === editingId ? group : entry) : [...groups, group];
    try {
      commit(next, editingId ? '编辑集团' : '创建集团');
      dialog.close();
    } catch (failure) {
      error.textContent = `集团保存失败：${failure.message}`;
      error.hidden = false;
    }
  });
  window.GroupStore = {
    validate, restore, updateMemberships,
    membershipsOf: countryId => new Set(groups.filter(group => group.memberIds.includes(countryId)).map(group => group.id)),
    pickingMember: () => Boolean(memberPick),
    pickMember,
    outlineRevision: () => outlineRevision,
    list: () => {
      if (!groups.length) return [];
      const countryIds = new Set(window.CountryStore.list().map(country => country.id));
      return groups.map(group => ({ ...group, memberIds: group.memberIds.filter(id => countryIds.has(id)) }));
    },
  };
})();
