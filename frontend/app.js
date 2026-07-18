const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const LOCAL_KEY = 'cocomac-essential-state-v1';
const SETTINGS_KEY = 'cocomac-essential-settings-v1';
const LOCAL_PRODUCTS_KEY = 'cocomac-essential-products-v1';
const LOCAL_PROJECTS_KEY = 'cocomac-essential-projects-v1';
const LOCAL_RESERVATIONS_KEY = 'cocomac-essential-reservations-v1';
const LOCAL_DELETED_PRODUCTS_KEY = 'cocomac-essential-deleted-products-v1';
const PRODUCT_URL_BASE = 'https://remi-cmf.github.io/cocomac-essentials/';

let baseCatalog = [];
let catalog = [];
let state = { movements: [] };
let deferredPrompt = null;
let html5QrCode = null;
let scannerRunning = false;
let scanResultHandled = false;
let selectedProductImage = null;
let projects = [];
let reservations = [];
let activeProjectId = null;
let reservationOrigin = 'project';

async function boot() {
  baseCatalog = await fetch('./data/equipment.json', { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error('equipment.json konnte nicht geladen werden.');
      return response.json();
    });

  state = readJson(LOCAL_KEY, { movements: [] });
  await refreshCatalog();
  bind();
  render();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.warn('Service Worker konnte nicht registriert werden:', error);
    }
  }

  const params = new URLSearchParams(location.search);
  const directId = params.get('id') || params.get('item');
  if (directId) openDetail(directId);
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function settings() {
  return readJson(SETTINGS_KEY, { cloudMode: false, apiUrl: '' });
}

async function refreshCatalog() {
  const localProducts = readJson(LOCAL_PRODUCTS_KEY, []);
  const localProjects = readJson(LOCAL_PROJECTS_KEY, []);
  const localReservations = readJson(LOCAL_RESERVATIONS_KEY, []);
  let cloudProducts = [];
  let cloudProjects = [];
  let cloudReservations = [];
  let cloudDeletedProductIds = [];

  const currentSettings = settings();
  if (currentSettings.cloudMode && currentSettings.apiUrl) {
    try {
      const snapshot = await loadCloudSnapshot(currentSettings.apiUrl);
      cloudProducts = snapshot.products || [];
      cloudProjects = snapshot.projects || [];
      cloudReservations = snapshot.reservations || [];
      cloudDeletedProductIds = snapshot.deletedProductIds || [];
    } catch (error) {
      console.warn('Cloud-Daten konnten nicht geladen werden:', error);
    }
  }

  const deletedProductIds = new Set([
    ...readJson(LOCAL_DELETED_PRODUCTS_KEY, []),
    ...cloudDeletedProductIds
  ].map(id => String(id).toUpperCase()));

  const merged = new Map();
  [...baseCatalog, ...localProducts, ...cloudProducts].forEach(item => {
    if (item?.id && !deletedProductIds.has(String(item.id).toUpperCase())) {
      merged.set(String(item.id).toUpperCase(), normalizeProduct(item));
    }
  });
  catalog = [...merged.values()];

  const projectMap = new Map();
  [...localProjects, ...cloudProjects].forEach(item => { if (item?.id) projectMap.set(String(item.id), normalizeProject(item)); });
  projects = [...projectMap.values()].sort((a,b) => String(b.start).localeCompare(String(a.start)));

  const reservationMap = new Map();
  [...localReservations, ...cloudReservations].forEach(item => { if (item?.id) reservationMap.set(String(item.id), normalizeReservation(item)); });
  reservations = [...reservationMap.values()];
  populateCategoryOptions();
}

function normalizeProduct(item) {
  return {
    id: String(item.id || '').toUpperCase(),
    name: String(item.name || ''),
    category: String(item.category || 'Sonstiges'),
    location: String(item.location || ''),
    total: Number(item.total || 1),
    condition: String(item.condition || 'Gut'),
    description: String(item.description || ''),
    dimensions: String(item.dimensions || ''),
    dailyPrice: Number(item.dailyPrice || 0),
    replacementValue: Number(item.replacementValue || 0),
    notes: String(item.notes || ''),
    image: String(item.image || ''),
    imageUrl: String(item.imageUrl || ''),
    productUrl: String(item.productUrl || makeProductUrl(item.id))
  };
}

function productImageSource(item) {
  if (item.imageUrl) return item.imageUrl;
  if (item.image?.startsWith('data:') || item.image?.startsWith('http')) return item.image;
  return item.image ? `./assets/images/${item.image}` : '';
}

function makeProductUrl(id) {
  const url = new URL(PRODUCT_URL_BASE);
  url.searchParams.set('id', String(id || '').toUpperCase());
  return url.href;
}

function totals(item, from = todayIso(), to = todayIso()) {
  const relevant = reservations.filter(r =>
    r.productId === item.id &&
    !['Storniert', 'Zurückgegeben', 'Freigegeben'].includes(r.status) &&
    (r.status === 'Defekt' || rangesOverlap(r.from, r.to, from, to))
  );
  const loaned = relevant.filter(r => r.status === 'Ausgegeben').reduce((sum, r) => sum + r.quantity, 0);
  const reserved = relevant.filter(r => r.status === 'Reserviert').reduce((sum, r) => sum + r.quantity, 0);
  const blocked = relevant.filter(r => r.status === 'Defekt').reduce((sum, r) => sum + r.quantity, 0);
  return {
    loaned,
    reserved,
    blocked,
    available: Math.max(0, Number(item.total || 0) - loaned - reserved - blocked)
  };
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const items = catalog.filter(item =>
    [item.id, item.name, item.category, item.location]
      .join(' ')
      .toLowerCase()
      .includes(query)
  );

  const withTotals = catalog.map(item => ({ ...item, ...totals(item) }));
  const sum = key => withTotals.reduce((total, item) => total + item[key], 0);

  $('#stats').innerHTML = [
    ['Artikelarten', new Set(catalog.map(item => item.id)).size],
    ['Gesamtbestand', catalog.reduce((total, item) => total + Number(item.total || 0), 0)],
    ['Ausgeliehen', sum('loaned')],
    ['Defekt', sum('blocked')]
  ].map(([label, value]) =>
    `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
  ).join('');

  $('#list').innerHTML = items.map(item => {
    const itemTotals = totals(item);
    const image = productImageSource(item);
    return `
      <article class="card" data-id="${escapeHtml(item.id)}">
        <div class="card-image-wrap">
          ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}">` : '<div class="image-placeholder">Kein Foto</div>'}
        </div>
        <div class="card-body">
          <div class="meta">${escapeHtml(item.category)}</div>
          <h3>${escapeHtml(item.name)}</h3>
          <div class="meta">${escapeHtml(item.id)} · ${escapeHtml(item.location)}</div>
          <span class="pill ${itemTotals.available === 0 ? 'pill-danger' : ''}">${itemTotals.available === 0 ? 'Aktuell nicht verfügbar' : `${itemTotals.available} von ${item.total} verfügbar`}</span>
        </div>
      </article>`;
  }).join('');

  $$('.card').forEach(card => {
    card.onclick = () => openDetail(card.dataset.id);
  });

  const currentSettings = settings();
  $('#syncBanner').textContent = currentSettings.cloudMode
    ? 'Cloud-Modus aktiv: Produkte und Buchungen werden mit Google Sheets synchronisiert.'
    : 'Testmodus: Neue Produkte und Buchungen werden nur auf diesem Gerät gespeichert.';
  $('#syncBanner').classList.toggle('demo', !currentSettings.cloudMode);
  renderProjects();
  renderCalendar();
  renderAdminProducts();
}

function openDetail(id) {
  const item = catalog.find(product =>
    product.id.toUpperCase() === String(id).toUpperCase()
  );
  if (!item) return toast('Artikel nicht gefunden.');

  const itemTotals = totals(item);
  const image = productImageSource(item);

  $('#detailContent').innerHTML = `
    ${image ? `<img class="hero" src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}">` : ''}
    <div class="meta">${escapeHtml(item.category)}</div>
    <h2>${escapeHtml(item.name)}</h2>
    <p>${escapeHtml(item.description || '')}</p>
    <div class="meta">${escapeHtml(item.id)} · ${escapeHtml(item.location)} · Zustand: ${escapeHtml(item.condition)}</div>
    <div class="detail-grid">
      <div class="detail-stat"><b>${itemTotals.available}</b><br><small>verfügbar</small></div>
      <div class="detail-stat"><b>${itemTotals.loaned}</b><br><small>ausgeliehen</small></div>
      <div class="detail-stat"><b>${itemTotals.blocked}</b><br><small>defekt</small></div>
    </div>
    <p>
      <b>Maße:</b> ${escapeHtml(item.dimensions || '–')}<br>
      <b>Tagespreis:</b> ${item.dailyPrice ? item.dailyPrice.toFixed(2) + ' €' : '–'}<br>
      <b>Wiederbeschaffung:</b> ${item.replacementValue ? item.replacementValue.toFixed(2) + ' €' : '–'}
      ${item.notes ? '<br><b>Notiz:</b> ' + escapeHtml(item.notes) : ''}
    </p>
    <div class="actions">
      ${[
        ['checkout', 'Ausleihen'],
        ['return', 'Zurückgeben'],
        ['defect', 'Defekt melden'],
        ['release', 'Wieder freigeben']
      ].map(([action, label]) =>
        `<button data-action="${action}" data-id="${escapeHtml(item.id)}" class="${action === 'defect' ? 'danger' : ''}">${label}</button>`
      ).join('')}
      <button type="button" class="ghost qr-button" data-qr-id="${escapeHtml(item.id)}">QR-Code anzeigen</button>
    </div>`;

  $$('[data-action]').forEach(button => {
    button.onclick = () => openAction(button.dataset.id, button.dataset.action);
  });
  $('[data-qr-id]').onclick = () => openQr(item.id);

  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('id', item.id);
  history.replaceState({}, '', url);
  $('#detailDialog').showModal();
}

function openQr(id) {
  const item = catalog.find(product => product.id === id);
  if (!item) return toast('Artikel nicht gefunden.');

  const productUrl = makeProductUrl(item.id);
  $('#qrTitle').textContent = item.name;
  $('#qrArticleId').textContent = item.id;
  $('#qrProductLink').textContent = productUrl;
  $('#qrProductLink').href = productUrl;
  $('#qrImageWrap').innerHTML = '';

  if (typeof window.QRCode === 'undefined') {
    return toast('QR-Code-Bibliothek konnte nicht geladen werden.');
  }

  new window.QRCode($('#qrImageWrap'), {
    text: productUrl,
    width: 420,
    height: 420,
    correctLevel: window.QRCode.CorrectLevel.M
  });

  $('#downloadQrBtn').onclick = () => downloadQr(item);
  $('#printQrBtn').onclick = () => printQr(item);
  $('#detailDialog').close();
  $('#qrDialog').showModal();
}

function qrDataUrl() {
  const canvas = $('#qrImageWrap canvas');
  if (canvas) return canvas.toDataURL('image/png');
  const image = $('#qrImageWrap img');
  return image?.src || '';
}

function downloadQr(item) {
  const dataUrl = qrDataUrl();
  if (!dataUrl) return toast('QR-Code konnte nicht erstellt werden.');
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `${item.id}-qr-link.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function printQr(item) {
  const dataUrl = qrDataUrl();
  if (!dataUrl) return toast('QR-Code konnte nicht erstellt werden.');
  const productUrl = makeProductUrl(item.id);
  const printWindow = window.open('', '_blank', 'width=520,height=700');
  if (!printWindow) return toast('Bitte Pop-ups für das Drucken erlauben.');

  printWindow.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(item.id)}</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:32px;color:#171716}.label{display:inline-block;border:1px solid #bbb;border-radius:18px;padding:24px;min-width:280px}small{letter-spacing:.16em;color:#666}h1{font-size:22px;margin:10px 0 4px}p{margin:0 0 16px;color:#555}img{width:240px;height:240px}.id{font-size:20px;font-weight:800;letter-spacing:.08em;margin-top:12px}.url{font-size:10px;max-width:300px;word-break:break-all;margin-top:8px}@media print{body{padding:0}.label{border:0}}</style></head>
    <body><div class="label"><small>COCOMAC ESSENTIAL</small><h1>${escapeHtml(item.name)}</h1><p>${escapeHtml(item.category)}</p><img src="${dataUrl}" alt="QR-Code"><div class="id">${escapeHtml(item.id)}</div><div class="url">${escapeHtml(productUrl)}</div></div><script>window.onload=()=>{window.print();window.close()}<\/script></body></html>`);
  printWindow.document.close();
}

function openAction(id, action) {
  const item = catalog.find(product => product.id === id);
  if (!item) return toast('Artikel nicht gefunden.');

  $('#actionForm').reset();
  $('#actionArticleId').value = id;
  $('#actionType').value = action;
  $('#actionTitle').textContent = {
    checkout: 'Ausleihen', return: 'Zurückgeben', defect: 'Defekt melden', release: 'Defekt freigeben'
  }[action] || 'Buchung';

  const activeProjects = projects.filter(p => !['Abgeschlossen', 'Zurückgegeben'].includes(p.status));
  const projectSelect = $('#actionProject');
  const rows = reservations.filter(r => r.productId === id && !['Storniert','Zurückgegeben','Freigegeben'].includes(r.status));
  let selectableProjects = activeProjects;
  if (['return','defect'].includes(action)) {
    const ids = new Set(rows.filter(r => ['Reserviert','Ausgegeben'].includes(r.status)).map(r => r.projectId));
    selectableProjects = activeProjects.filter(p => ids.has(p.id));
  }
  if (action === 'release') {
    const ids = new Set(rows.filter(r => r.status === 'Defekt').map(r => r.projectId));
    selectableProjects = projects.filter(p => ids.has(p.id));
  }
  projectSelect.innerHTML = '<option value="">Projekt auswählen</option>' + selectableProjects.map(p =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(projectOptionLabel(p))}</option>`
  ).join('');

  $('#actionHelp').innerHTML = action === 'checkout'
    ? 'Wähle das Projekt. Der Projektzeitraum wird vorgeschlagen und kann direkt angepasst werden.'
    : action === 'return'
      ? 'Wähle das Projekt, aus dem das Equipment zurückgegeben wird.'
      : action === 'defect'
        ? 'Wähle das Projekt, aus dem der Defekt gemeldet wird.'
        : 'Wähle das Projekt und die defekte Menge, die wieder freigegeben werden soll.';
  updateActionProjectInfo();
  $('#detailDialog').close();
  $('#actionDialog').showModal();
}

function actionCandidateRows() {
  const id = $('#actionArticleId').value;
  const projectId = $('#actionProject').value;
  const action = $('#actionType').value;
  const allowed = action === 'release' ? ['Defekt'] : action === 'checkout' ? [] : ['Reserviert','Ausgegeben'];
  return reservations.filter(r => r.productId === id && r.projectId === projectId && allowed.includes(r.status));
}

function updateActionProjectInfo() {
  const action = $('#actionType').value;
  const project = projects.find(p => p.id === $('#actionProject').value);
  const info = $('#actionProjectInfo');
  const from = $('#actionFrom');
  const to = $('#actionTo');
  if (!project) {
    info.innerHTML = '<b>Bitte ein Projekt auswählen.</b>';
    from.value = ''; to.value = '';
    $('#actionSubmitBtn').disabled = true;
    return;
  }
  if (action === 'checkout') {
    from.value = project.start; to.value = project.end;
  } else {
    const rows = actionCandidateRows();
    from.value = rows[0]?.from || project.start;
    to.value = rows[0]?.to || project.end;
  }
  info.innerHTML = `<div class="reservation-project-head"><div><small>PROJEKT</small><b>${escapeHtml(project.name)}</b></div><span class="status-badge">${escapeHtml(project.status)}</span></div><div class="reservation-project-grid"><div><small>Projektzeitraum</small><b>${formatDate(project.start)}–${formatDate(project.end)}</b></div><div><small>Ansprechpartner</small><b>${escapeHtml(project.contact || '–')}</b></div></div>`;
  updateActionAvailability();
}

function updateActionAvailability() {
  const action = $('#actionType').value;
  const item = catalog.find(p => p.id === $('#actionArticleId').value);
  const project = projects.find(p => p.id === $('#actionProject').value);
  const from = $('#actionFrom').value;
  const to = $('#actionTo').value;
  const summary = $('#actionAvailability');
  const submit = $('#actionSubmitBtn');
  if (!item || !project || !from || !to || to < from) {
    summary.innerHTML = '<b>Projekt und gültigen Zeitraum auswählen.</b>';
    submit.disabled = true; return;
  }
  let max = 0;
  if (action === 'checkout') max = availableFor(item.id, from, to);
  else max = actionCandidateRows().reduce((sum, r) => sum + r.quantity, 0);
  $('#quantity').max = String(max);
  if (Number($('#quantity').value || 1) > max) $('#quantity').value = Math.max(1, max);
  const label = action === 'checkout' ? 'im Zeitraum verfügbar' : action === 'release' ? 'als defekt gebucht' : 'diesem Projekt zugeordnet';
  summary.innerHTML = `<div class="reservation-product-summary"><div><small>${escapeHtml(item.category)} · ${escapeHtml(item.id)}</small><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.location)} · Bestand ${item.total}</span></div><div class="reservation-free ${max === 0 ? 'availability-danger' : ''}"><b>${max}</b><small>${label}</small></div></div>`;
  submit.disabled = max < 1;
}

async function submitMovement(event) {
  event.preventDefault();
  const action = $('#actionType').value;
  const itemId = $('#actionArticleId').value;
  const projectId = $('#actionProject').value;
  const quantity = Number($('#quantity').value);
  const from = $('#actionFrom').value;
  const to = $('#actionTo').value;
  const note = $('#note').value.trim();
  if (!projectId || !from || !to || !Number.isInteger(quantity) || quantity < 1) return toast('Bitte Projekt, Zeitraum und Menge vollständig eintragen.');
  if (to < from) return toast('Das Enddatum darf nicht vor dem Startdatum liegen.');

  if (action === 'checkout') {
    const available = availableFor(itemId, from, to);
    if (quantity > available) return toast(`Nur ${available} Stück sind in diesem Zeitraum verfügbar.`);
    const reservation = normalizeReservation({id:crypto.randomUUID(), projectId, productId:itemId, quantity, from, to, status:'Ausgegeben', note});
    if (settings().cloudMode) await sendCloudAction({action:'saveReservation',payload:reservation});
    const local = readJson(LOCAL_RESERVATIONS_KEY,[]); local.push(reservation); localStorage.setItem(LOCAL_RESERVATIONS_KEY,JSON.stringify(local));
  } else {
    const candidates = actionCandidateRows();
    const max = candidates.reduce((sum,r)=>sum+r.quantity,0);
    if (quantity > max) return toast(`Für diese Aktion sind nur ${max} Stück verfügbar.`);
    const payload = {actionType:action, projectId, productId:itemId, quantity, from, to, note};
    if (settings().cloudMode) await sendCloudAction({action:'reservationAction',payload});
    applyLocalReservationAction(payload);
  }
  await refreshCatalog(); render(); $('#actionDialog').close(); openDetail(itemId);
  toast(action === 'checkout' ? 'Equipment wurde ausgeliehen.' : action === 'return' ? 'Equipment wurde zurückgegeben.' : action === 'defect' ? 'Defekt wurde erfasst.' : 'Defekte Menge wurde wieder freigegeben.');
}

function applyLocalReservationAction(payload) {
  let list = readJson(LOCAL_RESERVATIONS_KEY,[]).map(normalizeReservation);
  const sourceStatuses = payload.actionType === 'release' ? ['Defekt'] : ['Reserviert','Ausgegeben'];
  let remaining = payload.quantity;
  const created = [];
  for (const row of list) {
    if (remaining <= 0 || row.projectId !== payload.projectId || row.productId !== payload.productId || !sourceStatuses.includes(row.status)) continue;
    const take = Math.min(remaining, row.quantity);
    row.quantity -= take;
    created.push(normalizeReservation({id:crypto.randomUUID(), projectId:row.projectId, productId:row.productId, quantity:take, from:payload.from || row.from, to:payload.to || row.to, status: payload.actionType === 'return' ? 'Zurückgegeben' : payload.actionType === 'defect' ? 'Defekt' : 'Freigegeben', note:payload.note}));
    remaining -= take;
  }
  list = list.filter(r => r.quantity > 0).concat(created);
  localStorage.setItem(LOCAL_RESERVATIONS_KEY,JSON.stringify(list));
}

function populateCategoryOptions() {
  const select = $('#productCategory');
  if (!select) return;

  const previousValue = select.value;
  const categories = [...new Set(
    catalog
      .map(item => String(item.category || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));

  select.innerHTML = [
    '<option value="">Kategorie auswählen</option>',
    ...categories.map(category =>
      `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
    )
  ].join('');

  if (previousValue && categories.includes(previousValue)) {
    select.value = previousValue;
  }
}

function openProductDialog() {
  populateCategoryOptions();
  $('#productForm').reset();
  selectedProductImage = null;
  $('#productImagePreview').innerHTML = '<span>Foto hier ablegen oder auswählen</span>';
  $('#newProductIdPreview').textContent = 'Die Artikel-ID wird automatisch erzeugt.';
  $('#productDialog').showModal();
}

function categoryCode(category) {
  const normalized = String(category || 'ART')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return (normalized.slice(0, 3) || 'ART').padEnd(3, 'X');
}

function nextProductId(category) {
  const prefix = `CME-${categoryCode(category)}-`;
  const numbers = catalog
    .map(item => item.id)
    .filter(id => id.startsWith(prefix))
    .map(id => Number(id.split('-').pop()))
    .filter(Number.isFinite);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

function updateProductIdPreview() {
  const category = $('#productCategory').value.trim();
  $('#newProductIdPreview').textContent = category
    ? `Neue Artikel-ID: ${nextProductId(category)}`
    : 'Die Artikel-ID wird automatisch erzeugt.';
}

function bindImageUpload() {
  const dropzone = $('#productImageDropzone');
  const input = $('#productImage');
  const choose = () => input.click();

  dropzone.onclick = choose;
  dropzone.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') choose();
  };
  input.onchange = () => handleImageFile(input.files?.[0]);

  ['dragenter', 'dragover'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', event => handleImageFile(event.dataTransfer.files?.[0]));
}

async function handleImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Bitte eine Bilddatei auswählen.');
  if (file.size > 10 * 1024 * 1024) return toast('Das Foto darf höchstens 10 MB groß sein.');

  try {
    selectedProductImage = await compressImage(file, 1600, 0.82);
    $('#productImagePreview').innerHTML = `<img src="${selectedProductImage.dataUrl}" alt="Vorschau"><span>${escapeHtml(file.name)}</span>`;
  } catch (error) {
    toast('Foto konnte nicht verarbeitet werden.');
  }
}

function compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', quality),
          mimeType: 'image/jpeg',
          filename: file.name.replace(/\.[^.]+$/, '') + '.jpg'
        });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function submitProduct(event) {
  event.preventDefault();
  const category = $('#productCategory').value.trim();
  const id = nextProductId(category);
  const product = normalizeProduct({
    id,
    name: $('#productName').value.trim(),
    category,
    location: $('#productLocation').value.trim(),
    total: Number($('#productTotal').value),
    condition: $('#productCondition').value,
    description: $('#productDescription').value.trim(),
    dimensions: $('#productDimensions').value.trim(),
    dailyPrice: Number($('#productDailyPrice').value || 0),
    replacementValue: Number($('#productReplacementValue').value || 0),
    notes: $('#productNotes').value.trim(),
    productUrl: makeProductUrl(id),
    imageUrl: selectedProductImage?.dataUrl || ''
  });

  if (!product.name || !product.category || !product.location) return toast('Bitte Name, Kategorie und Standort ausfüllen.');
  if (!Number.isInteger(product.total) || product.total < 1) return toast('Bitte eine gültige Menge eingeben.');

  const saveButton = $('#saveProductBtn');
  saveButton.disabled = true;
  saveButton.textContent = 'Wird gespeichert …';

  try {
    const currentSettings = settings();
    if (currentSettings.cloudMode) {
      await sendCloudAction({
        action: 'addProduct',
        payload: {
          ...product,
          imageBase64: selectedProductImage?.dataUrl || '',
          imageName: `${id}.jpg`
        }
      });
    }

    const localProducts = readJson(LOCAL_PRODUCTS_KEY, []);
    const withoutSameId = localProducts.filter(item => item.id !== product.id);
    withoutSameId.push(product);
    localStorage.setItem(LOCAL_PRODUCTS_KEY, JSON.stringify(withoutSameId));
    const deleted = readJson(LOCAL_DELETED_PRODUCTS_KEY, []).filter(itemId => String(itemId).toUpperCase() !== product.id);
    localStorage.setItem(LOCAL_DELETED_PRODUCTS_KEY, JSON.stringify(deleted));

    await refreshCatalog();
    render();
    $('#productDialog').close();
    toast(currentSettings.cloudMode
      ? `${product.id} wurde gespeichert. Das Produkt erscheint auch in Google Sheets.`
      : `${product.id} wurde auf diesem Gerät gespeichert.`);
    openDetail(product.id);
  } catch (error) {
    toast('Produkt konnte nicht gespeichert werden: ' + error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Produkt speichern';
  }
}

function cleanApiUrl(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, '');
  if (!cleaned) throw new Error('Backend-URL fehlt.');
  if (!cleaned.startsWith('https://script.google.com/macros/s/') || !cleaned.endsWith('/exec')) {
    throw new Error('Bitte die veröffentlichte Web-App-URL verwenden. Sie muss mit /exec enden.');
  }
  return cleaned;
}

async function sendCloudAction(data) {
  const apiUrl = cleanApiUrl(settings().apiUrl);
  await fetch(apiUrl, {
    method: 'POST',
    mode: 'no-cors',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(data)
  });
  return true;
}

function loadCloudSnapshot(apiUrl) {
  const url = cleanApiUrl(apiUrl);
  return new Promise((resolve, reject) => {
    const callbackName = `cocomacSnapshot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timeout = setTimeout(() => cleanup(new Error('Zeitüberschreitung beim Laden der Cloud-Daten.')), 15000);
    function cleanup(error, data) {
      clearTimeout(timeout); delete window[callbackName]; script.remove();
      error ? reject(error) : resolve(data || { products: [], projects: [], reservations: [] });
    }
    window[callbackName] = response => response?.ok === false
      ? cleanup(new Error(response.error || 'Cloud-Fehler'))
      : cleanup(null, response);
    script.onerror = () => cleanup(new Error('Backend konnte nicht erreicht werden.'));
    script.src = `${url}?action=snapshot&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

function loadCloudProducts(apiUrl) {
  return loadCloudSnapshot(apiUrl).then(data => data.products || []);
}

async function testCloudConnection(apiUrl) {
  await loadCloudProducts(apiUrl);
  return true;
}

function bind() {
  $('#search').oninput = render;
  $$('.menu-nav').forEach(button => button.onclick = () => { showPage(button.dataset.page); closeMainMenu(); });
  $('#menuBtn').onclick = toggleMainMenu;
  $('#menuSettingsBtn').onclick = () => { closeMainMenu(); openSettingsDialog(); };
  document.addEventListener('click', event => {
    if (!event.target.closest('.topbar-actions')) closeMainMenu();
  });
  $('#addProjectBtn').onclick = openProjectDialog;
  $('#adminAddProductBtn').onclick = openProductDialog;
  $('#projectForm').onsubmit = submitProject;
  $('#projectName').addEventListener('input', updateProjectNumberPreview);
  $('#projectStart').addEventListener('change', updateProjectNumberPreview);
  $('#reservationForm').onsubmit = submitReservation;
  $('#reservationProject').onchange = updateReservationProjectInfo;
  $('#reservationProduct').onchange = updateReservationAvailability;
  $('#reservationFrom').onchange = updateReservationAvailability;
  $('#reservationTo').onchange = updateReservationAvailability;
  $('#reservationQuantity').oninput = updateReservationAvailability;
  $('#deleteReservationBtn').onclick = removeReservationFromProject;
  $('#refreshCalendarBtn').onclick = renderCalendar;
  $('#actionForm').onsubmit = submitMovement;
  $('#actionProject').onchange = updateActionProjectInfo;
  $('#actionFrom').onchange = updateActionAvailability;
  $('#actionTo').onchange = updateActionAvailability;
  $('#quantity').oninput = updateActionAvailability;
  $('#productForm').onsubmit = submitProduct;
  if ($('#addProductBtn')) $('#addProductBtn').onclick = openProductDialog;
  $('#productCategory').onchange = updateProductIdPreview;
  bindImageUpload();

  $('#settingsBtn').onclick = () => {
    const currentSettings = settings();
    $('#apiUrl').value = currentSettings.apiUrl;
    $('#cloudMode').checked = currentSettings.cloudMode;
    $('#settingsDialog').showModal();
  };

  $('#scanBtn').onclick = () => $('#scanDialog').showModal();

  $$('[data-close]').forEach(button => {
    button.onclick = async () => {
      const dialog = button.closest('dialog');
      if (dialog.id === 'scanDialog') await stopCameraScan();
      dialog.close();
      if (dialog.id === 'detailDialog') {
        const url = new URL(location.href);
        url.searchParams.delete('id');
        url.searchParams.delete('item');
        history.replaceState({}, '', url);
      }
    };
  });

  $('#settingsForm').onsubmit = async event => {
    event.preventDefault();
    const newSettings = { apiUrl: $('#apiUrl').value.trim(), cloudMode: $('#cloudMode').checked };
    try {
      if (newSettings.cloudMode) await testCloudConnection(newSettings.apiUrl);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
      await refreshCatalog();
      render();
      $('#settingsDialog').close();
      toast(newSettings.cloudMode ? 'Verbindung gespeichert. Cloud-Modus ist aktiv.' : 'Testmodus ist aktiv.');
    } catch (error) {
      toast('Verbindung fehlgeschlagen: ' + error.message);
    }
  };

  $('#resetDemo').onclick = () => {
    if (confirm('Lokale Buchungen und lokal hinzugefügte Produkte wirklich löschen?')) {
      localStorage.removeItem(LOCAL_KEY);
      localStorage.removeItem(LOCAL_PRODUCTS_KEY);
      localStorage.removeItem(LOCAL_DELETED_PRODUCTS_KEY);
      state = { movements: [] };
      refreshCatalog().then(render);
      toast('Lokale Testdaten gelöscht.');
    }
  };

  $('#manualScanForm').onsubmit = async event => {
    event.preventDefault();
    await stopCameraScan();
    $('#scanDialog').close();
    openDetail(extractArticleId($('#manualId').value.trim()));
  };

  $('#cameraScanBtn').onclick = startCameraScan;
  $('#stopScannerBtn').onclick = stopCameraScan;

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    $('#installBtn').classList.remove('hidden');
  });
  $('#installBtn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn').classList.add('hidden');
  };
}

function setScannerStatus(message) {
  const status = $('#scannerStatus');
  if (status) status.textContent = message;
}

function extractArticleId(decodedText) {
  const text = String(decodedText || '').trim();
  const directId = text.match(/CME-[A-Z0-9]+-\d+/i);
  if (directId) return directId[0].toUpperCase();
  try {
    const url = new URL(text);
    return (url.searchParams.get('id') || url.searchParams.get('item') || text).trim().toUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

async function startCameraScan() {
  if (scannerRunning) return;
  if (typeof window.Html5Qrcode === 'undefined') {
    setScannerStatus('Der QR-Scanner konnte nicht geladen werden. Bitte lade die Seite neu.');
    return;
  }

  scanResultHandled = false;
  setScannerStatus('Kamera wird gestartet …');
  $('#cameraScanBtn').classList.add('hidden');
  $('#stopScannerBtn').classList.remove('hidden');

  try {
    html5QrCode = new window.Html5Qrcode('qrReader');
    const cameras = await window.Html5Qrcode.getCameras();
    if (!cameras.length) throw new Error('Keine Kamera gefunden.');
    const backCamera = cameras.find(camera => /back|rear|environment|rück/i.test(camera.label)) || cameras[cameras.length - 1];

    await html5QrCode.start(
      backCamera.id,
      {
        fps: 10,
        qrbox: (width, height) => {
          const size = Math.floor(Math.min(width, height) * 0.72);
          return { width: size, height: size };
        },
        aspectRatio: 1
      },
      async decodedText => {
        if (scanResultHandled) return;
        scanResultHandled = true;
        const id = extractArticleId(decodedText);
        setScannerStatus(`Erkannt: ${id}`);
        await stopCameraScan();
        $('#scanDialog').close();
        openDetail(id);
        setTimeout(() => { scanResultHandled = false; }, 1000);
      },
      () => {}
    );
    scannerRunning = true;
    setScannerStatus('Halte den QR-Code in den markierten Bereich.');
  } catch (error) {
    console.error('Kamera konnte nicht gestartet werden:', error);
    scannerRunning = false;
    $('#cameraScanBtn').classList.remove('hidden');
    $('#stopScannerBtn').classList.add('hidden');
    const text = String(error || '').toLowerCase();
    if (text.includes('permission') || text.includes('notallowed') || error?.name === 'NotAllowedError') {
      setScannerStatus('Der Kamerazugriff wurde nicht erlaubt. Erlaube die Kamera in den Safari-Einstellungen.');
    } else {
      setScannerStatus(`Kamera konnte nicht gestartet werden: ${error?.message || error}`);
    }
    try { await html5QrCode?.clear(); } catch {}
    html5QrCode = null;
  }
}

async function stopCameraScan() {
  if (html5QrCode) {
    try {
      if (scannerRunning) await html5QrCode.stop();
      await html5QrCode.clear();
    } catch (error) {
      console.warn('Scanner konnte nicht vollständig gestoppt werden:', error);
    }
  }
  html5QrCode = null;
  scannerRunning = false;
  $('#cameraScanBtn')?.classList.remove('hidden');
  $('#stopScannerBtn')?.classList.add('hidden');
  setScannerStatus('');
}


function normalizeProject(item) {
  const rawNumber = String(item.number || item.id || '');
  const number = rawNumber && !rawNumber.toUpperCase().startsWith('CME-') ? `CME-${rawNumber}` : rawNumber;
  return {
    id: String(item.id || ''), name: String(item.name || ''), number,
    contact: String(item.contact || ''), email1: String(item.email1 || ''), email2: String(item.email2 || ''),
    start: dateOnly(item.start), end: dateOnly(item.end), status: String(item.status || 'Reserviert'), notes: String(item.notes || '')
  };
}
function normalizeReservation(item) {
  return {
    id: String(item.id || ''), projectId: String(item.projectId || ''), productId: String(item.productId || '').toUpperCase(),
    quantity: Number(item.quantity || 0), from: dateOnly(item.from), to: dateOnly(item.to),
    status: String(item.status || 'Reserviert'), note: String(item.note || '')
  };
}
function dateOnly(value) {
  if (!value) return '';
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : text.slice(0,10);
}
function formatDate(value) {
  if (!value) return '–';
  const [y,m,d] = value.split('-'); return `${d}.${m}.${y}`;
}
function todayIso() { return new Date().toISOString().slice(0,10); }
function addDaysIso(days) { const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function rangesOverlap(a1,a2,b1,b2) { return a1 <= b2 && b1 <= a2; }
function reservedQuantity(productId, from, to, ignoreId='') {
  return reservations.filter(r => r.id !== ignoreId && r.productId === productId && !['Storniert','Zurückgegeben','Freigegeben'].includes(r.status) && (r.status === 'Defekt' || rangesOverlap(r.from,r.to,from,to)))
    .reduce((sum,r)=>sum+r.quantity,0);
}
function availableFor(productId, from, to, ignoreId='') {
  const product=catalog.find(p=>p.id===productId); if(!product) return 0;
  return Math.max(0, product.total - reservedQuantity(productId,from,to,ignoreId));
}
function toggleMainMenu() {
  const menu = $('#mainMenu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}
function closeMainMenu() {
  $('#mainMenu')?.classList.add('hidden');
  $('#menuBtn')?.setAttribute('aria-expanded','false');
}
function openSettingsDialog() {
  const currentSettings = settings();
  $('#apiUrl').value = currentSettings.apiUrl || '';
  $('#cloudMode').checked = Boolean(currentSettings.cloudMode);
  $('#settingsDialog').showModal();
}
async function deleteProject(projectId) {
  const project = projects.find(item => item.id === projectId);
  if (!project) return;
  const linked = reservations.filter(item => item.projectId === projectId && item.status !== 'Storniert');
  if (linked.length) return toast('Das Projekt enthält noch Buchungen. Entferne oder storniere diese zuerst.');
  if (!confirm(`Projekt „${project.name}“ wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return;
  try {
    if (settings().cloudMode) await sendCloudAction({action:'deleteProject',payload:{projectId}});
    const local = readJson(LOCAL_PROJECTS_KEY, []).filter(item => item.id !== projectId);
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(local));
    $('#projectDetailDialog').close();
    await refreshCatalog(); render(); showPage('projectsPage'); toast('Projekt gelöscht.');
  } catch (error) { toast(error.message || 'Projekt konnte nicht gelöscht werden.'); }
}
function showPage(pageId) {
  $$('.app-page').forEach(page => page.classList.toggle('hidden', page.id !== pageId));
  $$('.menu-nav').forEach(btn => btn.classList.toggle('active', btn.dataset.page === pageId));
  const titles = {equipmentPage:'Equipment',projectsPage:'Projekte',calendarPage:'Kalender',adminPage:'Administration'};
  const title = titles[pageId] || 'Equipment';
  const heading = document.querySelector('.topbar h1');
  if (heading) heading.textContent = title;
  if(pageId==='calendarPage') renderCalendar();
}
function renderProjects() {
  if(!$('#projectList')) return;
  const active=projects.filter(p=>!['Abgeschlossen','Zurückgegeben'].includes(p.status)).length;
  $('#projectStats').innerHTML = [['Projekte',projects.length],['Aktiv',active],['Reservierungen',reservations.filter(r=>r.status==='Reserviert').length],['Ausgegeben',reservations.filter(r=>r.status==='Ausgegeben').length]].map(([l,v])=>`<div class="stat"><strong>${v}</strong><span>${l}</span></div>`).join('');
  $('#projectList').innerHTML = projects.length ? projects.map(p=>{
    const rows=reservations.filter(r=>r.projectId===p.id && r.status!=='Storniert');
    const pieces=rows.reduce((s,r)=>s+r.quantity,0);
    return `<article class="project-card" data-project-id="${escapeHtml(p.id)}"><div class="project-card-head"><span class="status-badge">${escapeHtml(p.status)}</span><small>${escapeHtml(p.number||p.id)}</small></div><h3>${escapeHtml(p.name)}</h3><p>${formatDate(p.start)} – ${formatDate(p.end)}</p><div class="meta">${rows.length} Artikelarten · ${pieces} Teile${p.contact?' · '+escapeHtml(p.contact):''}</div></article>`;
  }).join('') : '<div class="empty-state">Noch keine Projekte angelegt.</div>';
  $$('[data-project-id]').forEach(card=>card.onclick=()=>openProjectDetail(card.dataset.projectId));
}
function openProjectDialog(projectId = '') {
  $('#projectForm').reset();
  $('#projectEditId').value = projectId;
  const project = projects.find(item => item.id === projectId);
  if (project) {
    $('#projectDialogTitle').textContent = 'Projekt bearbeiten';
    $('#projectSubmitBtn').textContent = 'Änderungen speichern';
    $('#projectName').value = project.name;
    $('#projectContact').value = project.contact;
    $('#projectEmail1').value = project.email1;
    $('#projectEmail2').value = project.email2;
    $('#projectStatus').value = project.status;
    $('#projectStart').value = project.start;
    $('#projectEnd').value = project.end;
    $('#projectNotes').value = project.notes;
    $('#projectNumberPreview').textContent = project.number || project.id;
  } else {
    $('#projectDialogTitle').textContent = 'Neues Projekt';
    $('#projectSubmitBtn').textContent = 'Projekt speichern';
    $('#projectStart').value=todayIso();
    $('#projectEnd').value=addDaysIso(7);
    updateProjectNumberPreview();
  }
  $('#projectDialog').showModal();
}
function projectNameCode(name) {
  const clean = String(name || 'PRJ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return (clean.slice(0,3) || 'PRJ').padEnd(3,'X');
}
function projectDateCode(date) {
  const [year, month, day] = String(date || todayIso()).split('-');
  return `${month}${day}${String(year).slice(-2)}`;
}
function nextProjectNumber(name, start) {
  const base = `CME-${projectNameCode(name)}-${projectDateCode(start)}`;
  const used = projects.map(p => p.number || p.id).filter(value => String(value).startsWith(base + '-')).map(value => Number(String(value).split('-').pop())).filter(Number.isFinite);
  return `${base}-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3,'0')}`;
}
function updateProjectNumberPreview() {
  const editId = $('#projectEditId')?.value;
  if (editId) { const current = projects.find(item => item.id === editId); if ($('#projectNumberPreview')) $('#projectNumberPreview').textContent = current?.number || current?.id || editId; return; }
  const value = nextProjectNumber($('#projectName')?.value || '', $('#projectStart')?.value || todayIso());
  if ($('#projectNumberPreview')) $('#projectNumberPreview').textContent = value;
}
function nextProjectId(name, start) { return nextProjectNumber(name, start); }
async function submitProject(event) {
  event.preventDefault();
  const editId = $('#projectEditId').value;
  const existing = projects.find(item => item.id === editId);
  const generatedNumber = existing?.number || existing?.id || nextProjectNumber($('#projectName').value.trim(), $('#projectStart').value);
  const project=normalizeProject({ id:existing?.id || generatedNumber, name:$('#projectName').value.trim(), number:generatedNumber, contact:$('#projectContact').value.trim(), email1:$('#projectEmail1').value.trim(), email2:$('#projectEmail2').value.trim(), start:$('#projectStart').value, end:$('#projectEnd').value, status:$('#projectStatus').value, notes:$('#projectNotes').value.trim() });
  if(!project.name || !project.start || !project.end) return toast('Bitte Projektname und Zeitraum eintragen.');
  if(project.end < project.start) return toast('Das Enddatum darf nicht vor dem Startdatum liegen.');
  if(settings().cloudMode) await sendCloudAction({action:'saveProject',payload:project});
  const local=readJson(LOCAL_PROJECTS_KEY,[]).filter(p=>p.id!==project.id); local.push(project); localStorage.setItem(LOCAL_PROJECTS_KEY,JSON.stringify(local));
  await refreshCatalog(); render(); $('#projectDialog').close(); showPage('projectsPage'); openProjectDetail(project.id); toast('Projekt gespeichert.');
}
function projectReservations(projectId) { return reservations.filter(r=>r.projectId===projectId && r.status!=='Storniert'); }
function openProjectDetail(projectId) {
  const p=projects.find(x=>x.id===projectId); if(!p) return toast('Projekt nicht gefunden.'); activeProjectId=p.id;
  const rows=projectReservations(p.id);
  $('#projectDetailContent').innerHTML=`<small>COCOMAC ESSENTIAL</small><h2>${escapeHtml(p.name)}</h2><div class="project-meta-grid"><div><b>Zeitraum</b><br>${formatDate(p.start)} – ${formatDate(p.end)}</div><div><b>Status</b><br>${escapeHtml(p.status)}</div><div><b>Ansprechpartner</b><br>${escapeHtml(p.contact||'–')}</div><div><b>E-Mail</b><br>${escapeHtml([p.email1,p.email2].filter(Boolean).join(', ')||'–')}</div></div>${p.notes?`<p>${escapeHtml(p.notes)}</p>`:''}<div class="project-actions"><button id="addReservationBtn" type="button">+ Equipment hinzufügen</button><button id="editProjectBtn" type="button" class="ghost">Projekt bearbeiten</button><button id="printProjectBtn" type="button" class="ghost">Beleg / PDF drucken</button>${p.email1?'<button id="emailProjectBtn" type="button" class="ghost">Per E-Mail senden</button>':''}<button id="deleteProjectBtn" type="button" class="danger">Projekt löschen</button></div><div class="booking-table">${rows.length?rows.map(r=>{const item=catalog.find(x=>x.id===r.productId);return `<button type="button" class="booking-row booking-row-button" data-edit-reservation="${escapeHtml(r.id)}"><div><b>${r.quantity} × ${escapeHtml(item?.name||r.productId)}</b><br><small>${escapeHtml(r.productId)} · ${formatDate(r.from)}–${formatDate(r.to)}</small></div><div class="booking-row-side"><span class="status-badge">${escapeHtml(r.status)}</span><small>Bearbeiten</small></div></button>`}).join(''):'<div class="empty-state">Noch kein Equipment zugeordnet.</div>'}</div>`;
  $('#addReservationBtn').onclick=()=>openReservationDialog(p.id);
  $$('[data-edit-reservation]').forEach(button => button.onclick = () => openReservationDialog(p.id, '', 'project', button.dataset.editReservation));
  $('#editProjectBtn').onclick=()=>{ $('#projectDetailDialog').close(); openProjectDialog(p.id); };
  $('#deleteProjectBtn').onclick=()=>deleteProject(p.id);
  $('#printProjectBtn').onclick=()=>printProjectDocument(p.id);
  if($('#emailProjectBtn')) $('#emailProjectBtn').onclick=()=>emailProjectDocument(p.id);
  $('#projectDetailDialog').showModal();
}
function projectOptionLabel(project) {
  const number = project.number ? ` · ${project.number}` : '';
  return `${project.name}${number} (${formatDate(project.start)}–${formatDate(project.end)})`;
}

function openReservationDialog(projectId = '', productId = '', origin = 'project', reservationId = '') {
  reservationOrigin = origin;
  $('#reservationForm').reset();
  $('#reservationEditId').value = reservationId;
  const existingReservation = reservations.find(item => item.id === reservationId);

  const activeProjects = projects
    .filter(project => !['Abgeschlossen', 'Zurückgegeben'].includes(project.status))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  $('#reservationProject').innerHTML =
    '<option value="">Projekt auswählen</option>' +
    activeProjects.map(project =>
      `<option value="${escapeHtml(project.id)}">${escapeHtml(projectOptionLabel(project))}</option>`
    ).join('');

  $('#reservationProduct').innerHTML =
    '<option value="">Produkt auswählen</option>' +
    catalog.slice().sort((a,b)=>a.name.localeCompare(b.name,'de')).map(item =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} (${escapeHtml(item.id)})</option>`
    ).join('');

  if (projectId && projects.some(project => project.id === projectId)) {
    $('#reservationProject').value = projectId;
  }
  if (productId && catalog.some(product => product.id === productId)) {
    $('#reservationProduct').value = productId;
  }
  if (existingReservation) {
    $('#reservationProject').value = existingReservation.projectId;
    $('#reservationProduct').value = existingReservation.productId;
  }

  $('#reservationProduct').disabled = Boolean(existingReservation || (productId && origin === 'equipment'));
  $('#reservationProject').disabled = Boolean(existingReservation);
  $('#reservationDialogTitle').textContent = existingReservation ? 'Equipment-Buchung bearbeiten' : (origin === 'equipment' ? 'Produkt ausleihen' : 'Equipment hinzufügen');
  $('#reservationSubmitBtn').textContent = existingReservation ? 'Änderungen speichern' : (origin === 'equipment' ? 'Für Projekt reservieren' : 'Equipment hinzufügen');
  $('#deleteReservationBtn').classList.toggle('hidden', !existingReservation);

  updateReservationProjectInfo();
  if (existingReservation) {
    $('#reservationQuantity').value = existingReservation.quantity;
    $('#reservationStatus').value = existingReservation.status;
    $('#reservationFrom').value = existingReservation.from;
    $('#reservationTo').value = existingReservation.to;
    $('#reservationNote').value = existingReservation.note;
  }
  updateReservationAvailability();
  $('#reservationDialog').showModal();
}

function updateReservationProjectInfo() {
  const projectId = $('#reservationProject')?.value || '';
  const project = projects.find(item => item.id === projectId);
  $('#reservationProjectId').value = projectId;

  if (!project) {
    $('#reservationProjectInfo').innerHTML = projects.length
      ? '<b>Bitte zuerst ein Projekt auswählen.</b><br><small>Danach werden Zeitraum, Ansprechpartner und Status automatisch übernommen.</small>'
      : '<b>Noch kein Projekt vorhanden.</b><br><small>Lege zuerst im Bereich „Projekte“ ein Projekt an.</small>';
    $('#reservationFrom').value = '';
    $('#reservationTo').value = '';
    updateReservationAvailability();
    return;
  }

  if (!$('#reservationEditId').value) {
    $('#reservationFrom').value = project.start;
    $('#reservationTo').value = project.end;
  }
  const emails = [project.email1, project.email2].filter(Boolean).join(', ') || 'Keine E-Mail hinterlegt';
  $('#reservationProjectInfo').innerHTML = `
    <div class="reservation-project-head">
      <div><small>PROJEKT</small><b>${escapeHtml(project.name)}</b></div>
      <span class="status-badge">${escapeHtml(project.status)}</span>
    </div>
    <div class="reservation-project-grid">
      <div><small>Zeitraum</small><b>${formatDate(project.start)}–${formatDate(project.end)}</b></div>
      <div><small>Ansprechpartner</small><b>${escapeHtml(project.contact || '–')}</b></div>
      <div><small>E-Mail</small><b>${escapeHtml(emails)}</b></div>
      <div><small>Bereits zugeordnet</small><b>${projectReservations(project.id).reduce((sum, row) => sum + row.quantity, 0)} Teile</b></div>
    </div>`;
  updateReservationAvailability();
}

function updateReservationAvailability() {
  const projectId = $('#reservationProject')?.value;
  const id = $('#reservationProduct')?.value;
  const from = $('#reservationFrom')?.value;
  const to = $('#reservationTo')?.value;
  const submit = $('#reservationSubmitBtn');

  if (!projectId) {
    $('#reservationAvailability').innerHTML = '<b>Projekt auswählen</b><br><small>Die Verfügbarkeit wird anschließend für den Projektzeitraum berechnet.</small>';
    if (submit) submit.disabled = true;
    return;
  }
  if (!id || !from || !to) {
    $('#reservationAvailability').innerHTML = '<b>Produkt auswählen</b><br><small>Danach siehst du Bestand und freie Menge.</small>';
    if (submit) submit.disabled = true;
    return;
  }

  const product = catalog.find(item => item.id === id);
  if (!product) return;
  const editId = $('#reservationEditId')?.value || '';
  const available = availableFor(id, from, to, editId);
  const reserved = reservedQuantity(id, from, to, editId);
  const statusClass = available === 0 ? 'availability-danger' : '';
  $('#reservationAvailability').innerHTML = `
    <div class="reservation-product-summary">
      ${productImageSource(product) ? `<img src="${escapeHtml(productImageSource(product))}" alt="${escapeHtml(product.name)}">` : ''}
      <div><small>${escapeHtml(product.category)} · ${escapeHtml(product.id)}</small><b>${escapeHtml(product.name)}</b><span>${escapeHtml(product.location)} · Bestand ${product.total}</span></div>
      <div class="reservation-free ${statusClass}"><b>${available}</b><small>frei</small></div>
    </div>
    <small>${reserved} Stück sind im gewählten Zeitraum bereits belegt.</small>`;
  $('#reservationQuantity').max = String(available);
  if (Number($('#reservationQuantity').value) > available) $('#reservationQuantity').value = Math.max(1, available);
  if (submit) submit.disabled = available < 1;
}

async function submitReservation(event) {
  event.preventDefault();
  const editId = $('#reservationEditId').value;
  const r = normalizeReservation({
    id: editId || crypto.randomUUID(),
    projectId: $('#reservationProject').value,
    productId: $('#reservationProduct').value,
    quantity: Number($('#reservationQuantity').value),
    from: $('#reservationFrom').value,
    to: $('#reservationTo').value,
    status: $('#reservationStatus').value,
    note: $('#reservationNote').value.trim()
  });
  if (!r.projectId || !r.productId || !r.from || !r.to || r.quantity < 1) return toast('Bitte Projekt, Produkt, Menge und Zeitraum ausfüllen.');
  if (r.to < r.from) return toast('Das Enddatum darf nicht vor dem Startdatum liegen.');
  const available = availableFor(r.productId, r.from, r.to, r.id);
  if (r.quantity > available) return toast(`Nur ${available} Stück sind in diesem Zeitraum verfügbar.`);
  if (settings().cloudMode) await sendCloudAction({action:'saveReservation',payload:r});
  const local = readJson(LOCAL_RESERVATIONS_KEY,[]).filter(x=>x.id!==r.id);
  local.push(r);
  localStorage.setItem(LOCAL_RESERVATIONS_KEY,JSON.stringify(local));
  await refreshCatalog();
  render();
  $('#reservationDialog').close();

  if (reservationOrigin === 'project') {
    $('#projectDetailDialog').close();
    openProjectDetail(r.projectId);
  } else {
    openDetail(r.productId);
  }
  toast(editId ? 'Equipment-Buchung wurde aktualisiert.' : 'Equipment wurde dem Projekt zugeordnet.');
}


async function removeReservationFromProject() {
  const reservationId = $('#reservationEditId').value;
  const reservation = reservations.find(item => item.id === reservationId);
  if (!reservation) return toast('Buchung nicht gefunden.');
  const product = catalog.find(item => item.id === reservation.productId);
  if (!confirm(`${product?.name || reservation.productId} wirklich aus diesem Projekt entfernen?`)) return;
  const cancelled = normalizeReservation({...reservation, status:'Storniert'});
  try {
    if (settings().cloudMode) await sendCloudAction({action:'saveReservation', payload:cancelled});
    const local = readJson(LOCAL_RESERVATIONS_KEY, []).filter(item => item.id !== cancelled.id);
    local.push(cancelled);
    localStorage.setItem(LOCAL_RESERVATIONS_KEY, JSON.stringify(local));
    await refreshCatalog();
    render();
    $('#reservationDialog').close();
    $('#projectDetailDialog').close();
    openProjectDetail(cancelled.projectId);
    toast('Equipment wurde aus dem Projekt entfernt.');
  } catch (error) {
    toast(error.message || 'Buchung konnte nicht entfernt werden.');
  }
}


function renderAdminProducts() {
  const wrap = $('#adminProductList');
  if (!wrap) return;
  const sorted = catalog.slice().sort((a,b) => a.name.localeCompare(b.name, 'de'));
  wrap.innerHTML = sorted.length ? sorted.map(item => {
    const image = productImageSource(item);
    return `<div class="admin-product-row">
      ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}">` : '<div class="image-placeholder">Kein Foto</div>'}
      <div><b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(item.id)} · ${escapeHtml(item.category)} · Bestand ${item.total}</small></div>
      <button type="button" class="danger" data-delete-product="${escapeHtml(item.id)}">Produkt löschen</button>
    </div>`;
  }).join('') : '<div class="empty-state">Keine Produkte vorhanden.</div>';
  $$('[data-delete-product]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteProduct));
}

async function deleteProduct(productId) {
  const product = catalog.find(item => item.id === productId);
  if (!product) return;
  const linked = reservations.filter(item => item.productId === productId && !['Storniert','Zurückgegeben'].includes(item.status));
  if (linked.length) return toast('Dieses Produkt ist noch in aktiven Projekten reserviert und kann deshalb nicht gelöscht werden.');
  if (!confirm(`„${product.name}“ wirklich löschen? Dieser Schritt blendet das Produkt auf allen Geräten aus.`)) return;
  try {
    if (settings().cloudMode) await sendCloudAction({ action: 'deleteProduct', payload: { productId } });
    const deleted = new Set(readJson(LOCAL_DELETED_PRODUCTS_KEY, []).map(id => String(id).toUpperCase()));
    deleted.add(productId.toUpperCase());
    localStorage.setItem(LOCAL_DELETED_PRODUCTS_KEY, JSON.stringify([...deleted]));
    const localProducts = readJson(LOCAL_PRODUCTS_KEY, []).filter(item => String(item.id).toUpperCase() !== productId.toUpperCase());
    localStorage.setItem(LOCAL_PRODUCTS_KEY, JSON.stringify(localProducts));
    await refreshCatalog();
    render();
    toast('Produkt gelöscht.');
  } catch (error) {
    toast('Produkt konnte nicht gelöscht werden: ' + error.message);
  }
}

function renderCalendar() {
  if(!$('#calendarFrom')) return;
  if(!$('#calendarFrom').value) $('#calendarFrom').value=todayIso();
  if(!$('#calendarTo').value) $('#calendarTo').value=addDaysIso(14);
  const from=$('#calendarFrom').value,to=$('#calendarTo').value;
  if(to<from){$('#calendarSummary').innerHTML='<div class="banner demo">Bitte einen gültigen Zeitraum auswählen.</div>';return;}
  const rows=catalog.map(item=>{const reserved=reservedQuantity(item.id,from,to);return {...item,reserved,free:Math.max(0,item.total-reserved)}}).sort((a,b)=>a.free-b.free||a.name.localeCompare(b.name,'de'));
  $('#calendarSummary').innerHTML=`<div class="banner">Verfügbarkeit vom <b>${formatDate(from)}</b> bis <b>${formatDate(to)}</b></div>`;
  $('#availabilityList').innerHTML=rows.map(item=>`<div class="availability-row"><div><b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(item.id)} · Bestand ${item.total}</small></div><div class="availability-count ${item.free===0?'none':''}"><b>${item.free}</b><small>frei</small></div><div class="availability-count"><b>${item.reserved}</b><small>belegt</small></div></div>`).join('');
  const relevant=reservations.filter(r=>r.status!=='Storniert'&&rangesOverlap(r.from,r.to,from,to)).sort((a,b)=>a.from.localeCompare(b.from));
  $('#calendarBookings').innerHTML=relevant.length?relevant.map(r=>{const p=projects.find(x=>x.id===r.projectId),item=catalog.find(x=>x.id===r.productId);return `<div class="timeline-item"><div class="timeline-date">${formatDate(r.from)}<br><small>bis ${formatDate(r.to)}</small></div><div><b>${escapeHtml(p?.name||r.projectId)}</b><br>${r.quantity} × ${escapeHtml(item?.name||r.productId)}<br><small>${escapeHtml(r.status)}</small></div></div>`}).join(''):'<div class="empty-state">Keine Buchungen in diesem Zeitraum.</div>';
}
function projectDocumentHtml(projectId) {
  const p=projects.find(x=>x.id===projectId), rows=projectReservations(projectId);
  const items=rows.map(r=>{const item=catalog.find(x=>x.id===r.productId);return `<tr><td>${r.quantity}</td><td>${escapeHtml(item?.name||r.productId)}</td><td>${escapeHtml(r.productId)}</td><td>${formatDate(r.from)}–${formatDate(r.to)}</td><td>${escapeHtml(r.status)}</td></tr>`}).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Equipment ${escapeHtml(p.name)}</title><style>body{font:14px Arial;padding:35px;color:#171716}h1{margin-bottom:4px}small{color:#666}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}.sign{margin-top:60px;display:flex;gap:80px}.line{border-top:1px solid;width:220px;padding-top:6px}</style></head><body><small>COCOMAC FILM GMBH · COCOMAC ESSENTIALS</small><h1>Equipment-Ausgabe / Reservierung</h1><h2>${escapeHtml(p.name)}</h2><p><b>Zeitraum:</b> ${formatDate(p.start)}–${formatDate(p.end)}<br><b>Ansprechpartner:</b> ${escapeHtml(p.contact||'–')}<br><b>Status:</b> ${escapeHtml(p.status)}</p><table><thead><tr><th>Menge</th><th>Equipment</th><th>ID</th><th>Zeitraum</th><th>Status</th></tr></thead><tbody>${items||'<tr><td colspan="5">Kein Equipment</td></tr>'}</tbody></table><div class="sign"><div class="line">Ausgabe / Datum</div><div class="line">Unterschrift</div></div></body></html>`;
}
function printProjectDocument(projectId) {
  const printArea = $('#printArea');
  const html = projectDocumentHtml(projectId);
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/i);
  printArea.innerHTML = bodyMatch ? bodyMatch[1] : html;
  printArea.setAttribute('aria-hidden', 'false');
  setTimeout(() => window.print(), 80);
  setTimeout(() => {
    printArea.innerHTML = '';
    printArea.setAttribute('aria-hidden', 'true');
  }, 1200);
}
async function emailProjectDocument(projectId) {
  const p=projects.find(x=>x.id===projectId); if(!p?.email1)return toast('Keine E-Mail-Adresse hinterlegt.');
  if(!settings().cloudMode)return toast('Der E-Mail-Versand ist nur im Cloud-Modus möglich.');
  await sendCloudAction({action:'emailProject',payload:{projectId}}); toast(`Der Projektbeleg wird an ${[p.email1,p.email2].filter(Boolean).join(', ')} gesendet.`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[character]));
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  setTimeout(() => element.classList.add('hidden'), 4200);
}

boot().catch(error => {
  console.error(error);
  toast('Die App konnte nicht vollständig geladen werden: ' + error.message);
});
