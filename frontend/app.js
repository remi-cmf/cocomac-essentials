const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const LOCAL_KEY = 'cocomac-essential-state-v1';
const SETTINGS_KEY = 'cocomac-essential-settings-v1';
const ADMIN_TOKEN_KEY = 'cocomac-essential-admin-token-v1';
const LOCAL_PRODUCTS_KEY = 'cocomac-essential-products-v1';
const LOCAL_PROJECTS_KEY = 'cocomac-essential-projects-v1';
const LOCAL_RESERVATIONS_KEY = 'cocomac-essential-reservations-v1';
const LOCAL_CALCULATIONS_KEY = 'cocomac-essential-calculations-v1';
const LOCAL_INVENTORY_KEY = 'cocomac-essential-inventory-v1';
const LOCAL_DELETED_PRODUCTS_KEY = 'cocomac-essential-deleted-products-v1';
const PRODUCT_URL_BASE = 'https://remi-cmf.github.io/cocomac-essentials/';
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbwxUcXelc6_DoQNZU6OlgDbbPlTnTqdURV9ebx-hhnfSpRGUxK8L6NROY84QPva2bhI/exec';
const CLOUD_MODE_LOCKED = true;

let baseCatalog = [];
let catalog = [];
let state = { movements: [] };
let deferredPrompt = null;
let html5QrCode = null;
let scannerRunning = false;
let scanResultHandled = false;
let scanTarget = 'detail';
let reservationScanSnapshot = null;
let selectedProductImage = null;
let imageLibrary = [];
const LOCAL_PRODUCT_IMAGES = {"CME-KIT-008":"CME-KIT-008.jpg","CME-KIT-009":"CME-KIT-009.jpg","CME-CLN-001":"CME-CLN-001.png","CME-CLN-003":"CME-CLN-003.jpg","CME-CLN-002":"CME-CLN-002.png","CME-SET-008":"CME-SET-008.png","CME-SET-005":"CME-SET-005.jpg","CME-TRP-001":"CME-TRP-001.jpg","CME-SET-004":"CME-SET-004.jpg","CME-SET-006":"CME-SET-006.jpg","CME-SET-007":"CME-SET-007.png","CME-TEC-002":"CME-TEC-002.jpg","CME-SET-003":"CME-SET-003.jpg","CME-SET-002":"CME-SET-002.jpg","CME-TEC-001":"CME-TEC-001.jpg","CME-SET-001":"CME-SET-001.jpg","CME-KIT-002":"CME-KIT-002.jpg","CME-TRP-102":"CME-TRP-102.jpg","CME-SAF-004":"CME-SAF-004.jpg","CME-TRP-103":"CME-TRP-103.jpg","CME-KIT-003":"CME-KIT-003.jpg","CME-KIT-015":"CME-KIT-015.jpg","CME-KIT-001":"CME-KIT-001.jpg","CME-TRP-101":"CME-TRP-101.jpg","CME-KIT-014":"CME-KIT-014.jpg","CME-KIT-010":"CME-KIT-010.jpg","CME-KIT-004":"CME-KIT-004.jpg","CME-SAF-002":"CME-SAF-002.jpg","CME-SAF-003":"CME-SAF-003.jpg","CME-KIT-005":"CME-KIT-005.jpg","CME-KIT-011":"CME-KIT-011.jpg","CME-KIT-007":"CME-KIT-007.jpg","CME-KIT-013":"CME-KIT-013.jpg","CME-SAF-001":"CME-SAF-001.jpg","CME-KIT-012":"CME-KIT-012.jpg","CME-KIT-006":"CME-KIT-006.jpg"};
let projects = [];
let reservations = [];
let damages = [];
let activeProjectId = null;
let reservationOrigin = 'project';
let cloudSyncTimer = null;
let cloudSyncRunning = false;
let lastCloudSyncAt = 0;
let automaticImageSyncAttempted = false;
let qrCodes = [];
let productQrScanReturnDialog = null;
let inventoryCounts = {};
let calculationDirty = false;


const PRODUCT_CATEGORIES = Object.freeze([
  { name: 'Cleaning / Reinigung', code: 'CLN', aliases: ['cleaning','reinigung','cleaning / reinigung','reinigung / cleaning','clean'] },
  { name: 'Küche', code: 'KIT', aliases: ['küche','kueche','kitchen','kit'] },
  { name: 'Setbau / Requisite', code: 'SET', aliases: ['setbau / requisite','setbau','requisite','setbau und requisite','set'] },
  { name: 'Sicherheit', code: 'SAF', aliases: ['sicherheit','safety','safe','saf'] },
  { name: 'Technik', code: 'TEC', aliases: ['technik','technical','technology','tech','tec'] },
  { name: 'Transport', code: 'TRP', aliases: ['transport','transportation','trp'] }
]);

function categoryKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function categoryDefinition(value) {
  const key = categoryKey(value);
  return PRODUCT_CATEGORIES.find(entry => entry.code.toLowerCase() === key || entry.aliases.some(alias => categoryKey(alias) === key)) || null;
}

function canonicalCategory(value) {
  return categoryDefinition(value)?.name || String(value || '').trim() || 'Sonstiges';
}

async function boot() {
  // Google Sheets ist die zentrale Datenquelle. Die große lokale Importdatei
  // wird nicht mehr bei jedem Start heruntergeladen.
  baseCatalog = [];

  state = readJson(LOCAL_KEY, { movements: [] });
  await refreshCatalog();
  bind();
  render();
  setupAutomaticCloudSync();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.warn('Service Worker konnte nicht registriert werden:', error);
    }
  }

  const params = new URLSearchParams(location.search);
  const directId = params.get('id') || params.get('item');
  const directQr = params.get('qr');
  if (directQr) handleScannedArticle(directQr); else if (directId) openDetail(directId);
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function settings() {
  const stored = readJson(SETTINGS_KEY, {});
  const configured = {
    ...stored,
    cloudMode: CLOUD_MODE_LOCKED ? true : Boolean(stored.cloudMode),
    apiUrl: DEFAULT_API_URL
  };

  // Migriert ältere Installationen automatisch vom lokalen Testmodus in die Cloud.
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(configured));
  return configured;
}

async function refreshCatalog() {
  const currentSettings = settings();
  if (!currentSettings.cloudMode || !currentSettings.apiUrl) {
    throw new Error('Die Cloud-Verbindung ist nicht aktiv.');
  }
  const snapshot = await loadCloudSnapshot(currentSettings.apiUrl);
  catalog = (snapshot.products || []).map(normalizeProduct);
  projects = (snapshot.projects || []).map(normalizeProject).sort((a,b) => String(b.start).localeCompare(String(a.start)));
  reservations = (snapshot.reservations || []).map(normalizeReservation);
  damages = Array.isArray(snapshot.damages) ? snapshot.damages.map(normalizeDamage) : [];
  if (Array.isArray(snapshot.images)) imageLibrary = snapshot.images;
  if (Array.isArray(snapshot.qrCodes)) qrCodes = snapshot.qrCodes;
  applyLocalDriveImageMatches();

  // Die Zuordnung wird einmal pro Sitzung automatisch in Google Sheets gespeichert.
  // Dadurch erscheinen vorhandene Drive-Bilder ohne zusätzlichen Admin-Schritt.
  const missingImages = catalog.filter(product => !productImageSource(product));
  if (!automaticImageSyncAttempted && missingImages.length && imageLibrary.length) {
    automaticImageSyncAttempted = true;
    setTimeout(() => automaticDriveImageSync(), 50);
  }

  // Alte Testdaten dürfen die zentrale Datenbank nicht mehr überschreiben.
  localStorage.removeItem(LOCAL_PRODUCTS_KEY);
  localStorage.removeItem(LOCAL_PROJECTS_KEY);
  localStorage.removeItem(LOCAL_RESERVATIONS_KEY);
  localStorage.removeItem(LOCAL_DELETED_PRODUCTS_KEY);
  populateCategoryOptions();
}

async function syncFromCloud(options = {}) {
  const { showMessage = false, force = false } = options;
  if (cloudSyncRunning) return;
  if (!force && Date.now() - lastCloudSyncAt < 4000) return;
  cloudSyncRunning = true;
  try {
    await refreshCatalog();
    render();
    lastCloudSyncAt = Date.now();
    if (showMessage) toast('Daten aus Google Sheets wurden aktualisiert.');
  } catch (error) {
    console.warn('Automatische Synchronisierung fehlgeschlagen:', error);
    if (showMessage) toast('Synchronisierung fehlgeschlagen: ' + error.message);
  } finally {
    cloudSyncRunning = false;
  }
}

function setupAutomaticCloudSync() {
  window.addEventListener('focus', () => syncFromCloud({ force: true }));
  window.addEventListener('pageshow', () => syncFromCloud({ force: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncFromCloud({ force: true });
  });
  window.addEventListener('online', () => syncFromCloud({ showMessage: true, force: true }));
  clearInterval(cloudSyncTimer);
  cloudSyncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      syncFromCloud();
    }
  }, 60000);
}

function normalizeProduct(item) {
  return {
    id: String(item.id || '').toUpperCase(),
    name: String(item.name || ''),
    category: canonicalCategory(item.category),
    location: String(item.location || ''),
    total: Number(item.total || 1),
    condition: String(item.condition || 'Gut'),
    description: String(item.description || ''),
    dimensions: String(item.dimensions || ''),
    dailyPrice: Number(item.dailyPrice || 0),
    replacementValue: Number(item.replacementValue || 0),
    purchasePrice: Number(item.purchasePrice || 0),
    weight: String(item.weight || ''),
    manufacturer: String(item.manufacturer || ''),
    serialNumber: String(item.serialNumber || ''),
    qrCode: String(item.qrCode || '').toUpperCase(),
    purchaseDate: String(item.purchaseDate || ''),
    notes: String(item.notes || ''),
    image: String(item.image || ''),
    imageUrl: String(item.imageUrl || ''),
    productUrl: String(item.productUrl || makeProductUrl(item.id))
  };
}

function productImageSource(item) {
  if (item.imageUrl) return item.imageUrl;
  if (item.image?.startsWith('data:') || item.image?.startsWith('http')) return item.image;
  if (item.image) return `./assets/images/${item.image}`;
  const localFilename = LOCAL_PRODUCT_IMAGES[String(item.id || '').toUpperCase()];
  return localFilename ? `./assets/images/${localFilename}` : '';
}

function normalizedImageKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findLocalDriveImage(product) {
  const idKey = normalizedImageKey(product.id);
  const nameKey = normalizedImageKey(product.name);
  const usefulTokens = nameKey.split('-').filter(token => token.length >= 3 && !['inkl','oder','eine','einer','set'].includes(token));
  let best = null;
  let bestScore = 0;
  for (const image of imageLibrary) {
    const fileKey = normalizedImageKey(image.name);
    let score = 0;
    if (idKey && fileKey === idKey) score = 120;
    else if (idKey && fileKey.includes(idKey)) score = 110;
    else if (nameKey && fileKey === nameKey) score = 100;
    else if (nameKey && (fileKey.includes(nameKey) || nameKey.includes(fileKey))) score = 88;
    else {
      const hits = usefulTokens.filter(token => fileKey.includes(token)).length;
      if (hits) score = hits * 22 + Math.min(15, fileKey.length ? Math.round((hits / usefulTokens.length) * 15) : 0);
    }
    if (score > bestScore) { bestScore = score; best = image; }
  }
  return bestScore >= 35 ? best : null;
}

function applyLocalDriveImageMatches() {
  if (!imageLibrary.length) return;
  catalog.forEach(product => {
    if (productImageSource(product)) return;
    const match = findLocalDriveImage(product);
    if (match?.url) product.imageUrl = match.url;
  });
}

async function automaticDriveImageSync() {
  try {
    const result = await sendCloudJsonpAction('syncProductImages', adminPayload());
    if (Number(result?.assigned || 0) > 0) {
      await syncFromCloud({ force: true });
    }
  } catch (error) {
    console.warn('Automatische Bildzuordnung fehlgeschlagen:', error);
  }
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
  $('#syncBanner').textContent = 'Synchronisiert';
  $('#syncBanner').classList.remove('demo');
  renderProjects();
  if (!$('#adminPage')?.classList.contains('hidden')) { renderAdminProjects(); renderAdminProducts(); renderQrDatabase(); }
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
      <b>Mietpreis:</b> ${item.dailyPrice ? item.dailyPrice.toFixed(2) + ' €' : '–'}<br>
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

function latestProjectForProduct(productId) {
  const rows = reservations
    .filter(r => r.productId === productId && r.projectId && r.projectId !== 'COCOMAC-INTERN')
    .sort((a, b) => String(b.to || b.from).localeCompare(String(a.to || a.from)));
  for (const row of rows) {
    const project = projects.find(p => p.id === row.projectId);
    if (project) return project;
  }
  return null;
}

function projectOrInternal(projectId) {
  if (projectId === 'COCOMAC-INTERN') return { id:'COCOMAC-INTERN', name:'Cocomac intern', status:'Interner Bestand', start:'', end:'', contact:'Cocomac Film GmbH' };
  return projects.find(p => p.id === projectId);
}

function updateDamageTotal() {
  const quantity = Math.max(0, Number($('#damageQuantity')?.value || 0));
  const unitValue = Math.max(0, Number($('#damageUnitValue')?.value || 0));
  if ($('#damageTotalValue')) $('#damageTotalValue').textContent = euro(quantity * unitValue);
}

function openAction(id, action) {
  const item = catalog.find(product => product.id === id);
  if (!item) return toast('Artikel nicht gefunden.');

  $('#actionForm').reset();
  $('#actionArticleId').value = id;
  $('#actionType').value = action;
  $('#actionTitle').textContent = {
    checkout: 'Ausleihen', return: 'Zurückgeben', defect: 'Schaden melden', release: 'Defekt freigeben'
  }[action] || 'Buchung';

  const isDamage = action === 'defect';
  $('#damageFields').hidden = !isDamage;
  $('#standardActionFields').hidden = isDamage;
  $('#standardQuantityField').hidden = isDamage;
  $('#standardNoteField').hidden = isDamage;

  if (isDamage) {
    const latestProject = latestProjectForProduct(id);
    const unitValue = Number(item.replacementValue || item.purchasePrice || 0);
    $('#damageDate').value = todayIso();
    $('#damageQuantity').value = '1';
    $('#damageQuantity').max = String(Math.max(1, Number(item.total || 1)));
    $('#damageUnitValue').value = unitValue ? String(unitValue) : '0';
    $('#damageSuggestedProjectId').value = latestProject?.id || '';
    $('#damageProductInfo').innerHTML = `<div class="reservation-product-summary"><div><small>${escapeHtml(item.category)} · ${escapeHtml(item.id)}</small><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.location)} · Bestand ${item.total}</span></div><div class="reservation-free"><b>${item.total}</b><small>Gesamtbestand</small></div></div>`;
    $('#damageProjectSuggestion').innerHTML = latestProject
      ? `<div class="reservation-project-head"><div><small>LETZTES PASSENDES PROJEKT</small><b>${escapeHtml(latestProject.name)}</b></div><span class="status-badge">${escapeHtml(latestProject.number || latestProject.id)}</span></div><p>War der Schaden diesem Projekt zuzuordnen?</p>`
      : '<b>Kein vorheriges Projekt gefunden.</b><br><small>Der Schaden wird intern bei Cocomac erfasst.</small>';
    const yes = document.querySelector('input[name="damageProjectChoice"][value="yes"]');
    const no = document.querySelector('input[name="damageProjectChoice"][value="no"]');
    yes.disabled = !latestProject;
    yes.checked = Boolean(latestProject);
    no.checked = !latestProject;
    $('#actionHelp').textContent = 'Schaden direkt erfassen. Ein vorheriges Projekt wird nur vorgeschlagen und muss nicht ausgewählt werden.';
    $('#actionSubmitBtn').disabled = false;
    updateDamageTotal();
    $('#detailDialog').close();
    $('#actionDialog').showModal();
    return;
  }

  const activeProjects = projects.filter(p => !['Abgeschlossen', 'Zurückgegeben'].includes(p.status));
  const projectSelect = $('#actionProject');
  const rows = reservations.filter(r => r.productId === id && !['Storniert','Zurückgegeben','Freigegeben'].includes(r.status));
  let selectableProjects = activeProjects;
  if (action === 'return') {
    const ids = new Set(rows.filter(r => ['Reserviert','Ausgegeben'].includes(r.status)).map(r => r.projectId));
    selectableProjects = activeProjects.filter(p => ids.has(p.id));
  }
  if (action === 'release') {
    const ids = new Set(rows.filter(r => r.status === 'Defekt').map(r => r.projectId));
    selectableProjects = projects.filter(p => ids.has(p.id));
    if (ids.has('COCOMAC-INTERN')) selectableProjects = [{id:'COCOMAC-INTERN',name:'Cocomac intern',number:'Interner Schaden',status:'Intern'}, ...selectableProjects];
  }
  projectSelect.innerHTML = '<option value="">Projekt auswählen</option>' + selectableProjects.map(p =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(projectOptionLabel(p))}</option>`
  ).join('');

  $('#actionHelp').innerHTML = action === 'checkout'
    ? 'Wähle das Projekt. Der Projektzeitraum wird vorgeschlagen und kann direkt angepasst werden.'
    : action === 'return'
      ? 'Wähle das Projekt, aus dem das Equipment zurückgegeben wird.'
      : 'Wähle den Schaden, dessen defekte Menge wieder freigegeben werden soll.';
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
  const project = projectOrInternal($('#actionProject').value);
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
    from.value = rows[0]?.from || project.start || todayIso();
    to.value = rows[0]?.to || project.end || todayIso();
  }
  info.innerHTML = `<div class="reservation-project-head"><div><small>PROJEKT</small><b>${escapeHtml(project.name)}</b></div><span class="status-badge">${escapeHtml(project.status)}</span></div><div class="reservation-project-grid"><div><small>Projektzeitraum</small><b>${project.start ? `${formatDate(project.start)}–${formatDate(project.end)}` : 'Kein Projektzeitraum'}</b></div><div><small>Ansprechpartner</small><b>${escapeHtml(project.contact || '–')}</b></div></div>`;
  updateActionAvailability();
}

function updateActionAvailability() {
  const action = $('#actionType').value;
  const item = catalog.find(p => p.id === $('#actionArticleId').value);
  const project = projectOrInternal($('#actionProject').value);
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

  if (action === 'defect') {
    const item = catalog.find(p => p.id === itemId);
    const quantity = Number($('#damageQuantity').value);
    const date = $('#damageDate').value;
    const description = $('#damageDescription').value.trim();
    const unitValue = Number($('#damageUnitValue').value || 0);
    const choice = document.querySelector('input[name="damageProjectChoice"]:checked')?.value || 'no';
    const suggestedProjectId = $('#damageSuggestedProjectId').value;
    const projectLinked = choice === 'yes' && Boolean(suggestedProjectId);
    if (!date || !Number.isInteger(quantity) || quantity < 1 || quantity > Number(item?.total || 0)) return toast('Bitte Schadensdatum und eine gültige Menge eintragen.');
    if (!description) return toast('Bitte kurz beschreiben, was passiert ist.');
    const payload = {
      id: crypto.randomUUID(), productId:itemId, quantity, date, description,
      projectLinked, projectId: projectLinked ? suggestedProjectId : 'COCOMAC-INTERN',
      unitValue: Math.max(0, unitValue), totalValue: Math.max(0, unitValue) * quantity,
      status:'Offen'
    };
    if (settings().cloudMode) await sendCloudAction({action:'saveDamage',payload});
    await refreshCatalog(); render(); $('#actionDialog').close(); openDetail(itemId);
    toast(projectLinked ? 'Schaden wurde erfasst und dem Projekt berechnet.' : 'Schaden wurde als interner Cocomac-Schaden erfasst.');
    return;
  }

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
  } else {
    const candidates = actionCandidateRows();
    const max = candidates.reduce((sum,r)=>sum+r.quantity,0);
    if (quantity > max) return toast(`Für diese Aktion sind nur ${max} Stück verfügbar.`);
    const payload = {actionType:action, projectId, productId:itemId, quantity, from, to, note};
    if (settings().cloudMode) await sendCloudAction({action:'reservationAction',payload});
  }
  await refreshCatalog(); render(); $('#actionDialog').close(); openDetail(itemId);
  toast(action === 'checkout' ? 'Equipment wurde ausgeliehen.' : action === 'return' ? 'Equipment wurde zurückgegeben.' : 'Defekte Menge wurde wieder freigegeben.');
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
  const previousValue = canonicalCategory(select.value);
  select.innerHTML = [
    '<option value="">Kategorie auswählen</option>',
    ...PRODUCT_CATEGORIES.map(entry => `<option value="${escapeHtml(entry.name)}">${escapeHtml(entry.name)} (${entry.code})</option>`)
  ].join('');
  if (PRODUCT_CATEGORIES.some(entry => entry.name === previousValue)) select.value = previousValue;
}

function populateDriveImageOptions(selectedUrl = '') {
  const select = $('#productDriveImage');
  if (!select) return;
  const options = ['<option value="">Kein anderes Drive-Bild auswählen</option>'];
  imageLibrary.forEach(image => {
    const selected = selectedUrl && image.url === selectedUrl ? ' selected' : '';
    options.push(`<option value="${escapeHtml(image.url)}" data-name="${escapeHtml(image.name)}"${selected}>${escapeHtml(image.name)}</option>`);
  });
  select.innerHTML = options.join('');
}

function openProductDialog(productId = '') {
  populateCategoryOptions();
  $('#productForm').reset();
  $('#productEditId').value = productId;
  selectedProductImage = null;
  const product = catalog.find(item => item.id === productId);
  populateDriveImageOptions(product?.imageUrl || '');
  $('#productDialogTitle').textContent = product ? 'Produkt bearbeiten' : 'Neues Produkt';
  $('#saveProductBtn').textContent = product ? 'Änderungen speichern' : 'Produkt speichern';
  if (product) {
    $('#newProductIdPreview').textContent = `Artikel-ID: ${product.id}`;
    $('#productName').value = product.name;
    $('#productCategory').value = product.category;
    $('#productLocation').value = product.location;
    $('#productTotal').value = product.total;
    $('#productCondition').value = product.condition;
    $('#productDimensions').value = product.dimensions;
    $('#productDailyPrice').value = product.dailyPrice || '';
    $('#productReplacementValue').value = product.replacementValue || '';
    $('#productPurchasePrice').value = product.purchasePrice || '';
    $('#productWeight').value = product.weight || '';
    $('#productManufacturer').value = product.manufacturer || '';
    $('#productSerialNumber').value = product.serialNumber || '';
    $('#productQrCode').value = product.qrCode || '';
    $('#productPurchaseDate').value = product.purchaseDate || '';
    $('#productDescription').value = product.description;
    $('#productNotes').value = product.notes;
    const image = productImageSource(product);
    $('#productImagePreview').innerHTML = image ? `<img src="${escapeHtml(image)}" alt="Vorschau"><span>Vorhandenes Foto</span>` : '<span>Foto hier ablegen oder auswählen</span>';
  } else {
    $('#productImagePreview').innerHTML = '<span>Foto hier ablegen oder auswählen</span>';
    $('#productQrCode').value = '';
    $('#newProductIdPreview').textContent = 'Die Artikel-ID wird beim Speichern automatisch erzeugt.';
  }
  const deleteButton = $('#deleteProductInDialogBtn');
  if (deleteButton) {
    deleteButton.hidden = !product;
    deleteButton.onclick = product ? () => deleteProduct(product.id, { closeDialog: true }) : null;
  }
  $('#productDialog').showModal();
}

function categoryCode(category) {
  return categoryDefinition(category)?.code || 'ART';
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
  const category = canonicalCategory($('#productCategory').value.trim());
  $('#newProductIdPreview').textContent = category
    ? `Kategorie gewählt: ${category} (${categoryCode(category)}). Die nächste freie Nummer wird beim Speichern vergeben.`
    : 'Die Artikel-ID wird beim Speichern automatisch erzeugt.';
}

function bindImageUpload() {
  const input = $('#productImage');
  if (!input) return;

  input.addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    handleImageFile(file);
  });
}

async function handleImageFile(file) {
  const status = $('#productSaveStatus');
  if (!file) {
    if (status) { status.hidden = false; status.textContent = 'Es wurde kein Foto ausgewählt.'; }
    return;
  }

  const mime = String(file.type || '').toLowerCase();
  if (mime && !mime.startsWith('image/')) {
    if (status) { status.hidden = false; status.textContent = 'Bitte eine Bilddatei auswählen.'; }
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    if (status) { status.hidden = false; status.textContent = 'Das Foto ist größer als 25 MB. Bitte ein kleineres Foto auswählen.'; }
    return;
  }

  if (selectedProductImage?.previewUrl) URL.revokeObjectURL(selectedProductImage.previewUrl);
  const previewUrl = URL.createObjectURL(file);
  selectedProductImage = {
    file,
    previewUrl,
    filename: file.name || `foto-${Date.now()}.jpg`,
    mimeType: file.type || 'image/jpeg'
  };
  if ($('#productDriveImage')) $('#productDriveImage').value = '';
  $('#productImagePreview').innerHTML = `<img src="${escapeHtml(previewUrl)}" alt="Ausgewähltes Foto"><span>${escapeHtml(selectedProductImage.filename)}</span>`;
  if (status) {
    status.hidden = false;
    status.textContent = 'Foto ausgewählt. Jetzt unten auf „Produkt speichern“ tippen.';
  }
}

async function compressImageFile(file, maxSize = 720, quality = 0.58) {
  let bitmap = null;
  try {
    if ('createImageBitmap' in window) bitmap = await createImageBitmap(file);
  } catch (_) {}

  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Das Fotoformat konnte auf diesem Gerät nicht gelesen werden. Bitte das Foto als JPG oder PNG auswählen.')); };
      image.src = url;
    });
  }

  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  if (!width || !height) throw new Error('Das Foto hat keine gültigen Abmessungen.');
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (!dataUrl || dataUrl.length < 100) throw new Error('Das Foto konnte nicht in JPG umgewandelt werden.');
  return { dataUrl, mimeType: 'image/jpeg', filename: String(file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg' };
}

async function submitProduct(event) {
  event.preventDefault();
  if (!settings().cloudMode) return toast('Speichern ist nur mit aktiver Google-Sheets-Verbindung möglich.');
  if (!(await ensureAdminAccess())) return toast('Bitte zuerst als Administrator anmelden.');

  const editId = $('#productEditId').value;
  const existing = catalog.find(item => item.id === editId);
  const category = canonicalCategory($('#productCategory').value.trim());
  const raw = {
    ...existing,
    id: existing?.id || '',
    originalId: existing?.id || '',
    name: $('#productName').value.trim(), category,
    location: $('#productLocation').value.trim(), total: Number($('#productTotal').value),
    condition: $('#productCondition').value, description: $('#productDescription').value.trim(),
    dimensions: $('#productDimensions').value.trim(), dailyPrice: Number($('#productDailyPrice').value || 0),
    replacementValue: Number($('#productReplacementValue').value || 0), purchasePrice: Number($('#productPurchasePrice').value || 0),
    weight: $('#productWeight').value.trim(), manufacturer: $('#productManufacturer').value.trim(),
    serialNumber: $('#productSerialNumber').value.trim(), qrCode: normalizeQrCode($('#productQrCode').value),
    purchaseDate: $('#productPurchaseDate').value, notes: $('#productNotes').value.trim(),
    imageUrl: ($('#productDriveImage')?.value || existing?.imageUrl || '')
  };
  if (!raw.name || !raw.category || !raw.location) return toast('Bitte Name, Standort und Kategorie ausfüllen.');
  if (!Number.isInteger(raw.total) || raw.total < 1) return toast('Bitte eine gültige Menge eingeben.');
  if ($('#productQrCode').value.trim() && !raw.qrCode) return toast('Der QR-Code hat kein gültiges Format.');

  const button = $('#saveProductBtn');
  const status = $('#productSaveStatus');
  const original = existing ? 'Änderungen speichern' : 'Produkt speichern';
  button.disabled = true;
  button.textContent = 'Wird vorbereitet …';
  status.hidden = false;

  try {
    let id = existing?.id || '';
    if (!id) {
      status.textContent = 'Die nächste freie Artikelnummer wird ermittelt …';
      const idResponse = await sendCloudJsonpAction('nextProductId', adminPayload({ category }));
      id = idResponse?.productId;
      if (!id) throw new Error('Es konnte keine Artikelnummer erzeugt werden.');
    }

    const product = normalizeProduct({ ...raw, id, productUrl: makeProductUrl(id) });
    status.textContent = 'Produktdaten werden gespeichert …';
    const metaResponse = await sendCloudJsonpAction('addProduct', adminPayload({ ...product, imageBase64: '' }));
    let savedProduct = metaResponse?.product ? normalizeProduct(metaResponse.product) : await waitForSavedProduct(id, { timeoutMs: 20000 });
    id = savedProduct.id || id;

    if (selectedProductImage?.file || selectedProductImage?.dataUrl) {
      button.textContent = 'Foto wird verarbeitet …';
      status.textContent = 'Foto wird für den Upload vorbereitet …';
      const preparedImage = selectedProductImage.dataUrl
        ? selectedProductImage
        : await compressImageFile(selectedProductImage.file, 720, 0.58);
      button.textContent = 'Foto wird hochgeladen …';
      status.textContent = 'Das Foto wird in Google Drive gespeichert. Bitte die App geöffnet lassen …';
      const uploadResult = await uploadProductImageConfirmed({
        productId: id,
        category,
        imageBase64: preparedImage.dataUrl,
        imageName: `${id}.jpg`
      }, (done, total) => {
        const percent = Math.max(1, Math.round((done / total) * 100));
        status.textContent = `Foto wird übertragen … ${percent} %`;
      });
      if (!uploadResult?.imageUrl) throw new Error('Das Backend hat keine Bild-URL zurückgegeben.');
      savedProduct = normalizeProduct({ ...savedProduct, imageUrl: uploadResult.imageUrl });
      const confirmed = await waitForSavedProduct(id, { requireImage: true, timeoutMs: 30000 });
      savedProduct = confirmed;
    }

    if (editId && editId !== savedProduct.id) {
      catalog = catalog.filter(item => item.id !== editId);
      if (Object.prototype.hasOwnProperty.call(inventoryCounts, editId)) {
        inventoryCounts[savedProduct.id] = inventoryCounts[editId];
        delete inventoryCounts[editId];
        persistInventoryDraft();
      }
    }
    const pos = catalog.findIndex(item => item.id === savedProduct.id);
    if (pos >= 0) catalog[pos] = savedProduct; else catalog.unshift(savedProduct);
    selectedProductImage = null;
    render();
    status.textContent = savedProduct.imageUrl ? 'Produkt und Foto wurden gespeichert.' : 'Produkt wurde gespeichert.';
    toast(status.textContent);
    setTimeout(() => { if ($('#productDialog')?.open) $('#productDialog').close(); }, 450);
  } catch (error) {
    console.error(error);
    status.textContent = 'Speichern fehlgeschlagen: ' + (error.message || 'Unbekannter Fehler');
    toast(status.textContent);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function waitForSavedProduct(productId, options = {}) {
  const { requireImage = false, timeoutMs = 30000 } = options;
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 1800));
    try {
      const snapshot = await loadCloudSnapshot(settings().apiUrl);
      const found = (snapshot.products || []).map(normalizeProduct).find(item => item.id === productId);
      if (found && (!requireImage || Boolean(found.imageUrl))) return found;
    } catch (error) {
      lastError = error;
    }
  }
  if (requireImage) throw new Error('Das Produkt wurde nicht mit einer Bild-URL bestätigt. Prüfe die Drive-Berechtigung und die neue Apps-Script-Bereitstellung.');
  throw lastError || new Error('Das Speichern wurde nicht rechtzeitig bestätigt.');
}

async function syncDriveImages() {
  const button = $('#syncDriveImagesBtn');
  if (button) { button.disabled = true; button.textContent = 'Bilder werden zugeordnet …'; }
  try {
    const result = await sendCloudJsonpAction('syncProductImages', adminPayload());
    await syncFromCloud({ force: true });
    const count = Number(result?.assigned || 0);
    const unresolved = Array.isArray(result?.unresolved) ? result.unresolved.length : 0;
    toast(`${count} Bild${count === 1 ? '' : 'er'} automatisch zugeordnet. ${unresolved} Produkt${unresolved === 1 ? '' : 'e'} noch ohne eindeutiges Bild.`);
  } catch (error) {
    toast('Bilder konnten nicht zugeordnet werden: ' + error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Bilder aus Drive zuordnen'; }
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

async function uploadProductImageConfirmed(payload, onProgress = () => {}) {
  const dataUrl = String(payload.imageBase64 || '');
  if (!dataUrl.startsWith('data:image/')) throw new Error('Das ausgewählte Foto konnte nicht verarbeitet werden.');

  // JSONP is used deliberately here. Unlike a no-cors POST, every chunk is
  // acknowledged by Apps Script and Safari cannot silently swallow an error.
  const uploadId = `IMG_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const chunkSize = 4800;
  const chunks = [];
  for (let index = 0; index < dataUrl.length; index += chunkSize) {
    chunks.push(dataUrl.slice(index, index + chunkSize));
  }
  if (!chunks.length) throw new Error('Das Foto enthält keine Daten.');
  if (chunks.length > 120) throw new Error('Das Foto ist trotz Verkleinerung zu groß. Bitte ein anderes Foto auswählen.');

  const basePayload = adminPayload({
    uploadId,
    productId: payload.productId,
    category: payload.category || '',
    imageName: payload.imageName || `${payload.productId}.jpg`,
    totalChunks: chunks.length
  });

  await sendCloudJsonpAction('beginImageUpload', basePayload);
  for (let index = 0; index < chunks.length; index += 1) {
    await sendCloudJsonpAction('uploadImageChunk', {
      ...basePayload,
      chunkIndex: index,
      chunk: chunks[index]
    }, 30000);
    onProgress(index + 1, chunks.length);
  }
  return sendCloudJsonpAction('finishImageUpload', basePayload, 60000);
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

function sendCloudJsonpAction(action, payload = {}, timeoutMs = 20000) {
  const url = cleanApiUrl(settings().apiUrl);
  return new Promise((resolve, reject) => {
    const callbackName = `cocomacWrite_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timeout = setTimeout(() => cleanup(new Error('Zeitüberschreitung beim Speichern.')), timeoutMs);
    function cleanup(error, data) {
      clearTimeout(timeout); delete window[callbackName]; script.remove();
      error ? reject(error) : resolve(data);
    }
    window[callbackName] = response => response?.ok === false ? cleanup(new Error(response.error || 'Cloud-Fehler')) : cleanup(null, response);
    script.onerror = () => cleanup(new Error('Backend konnte nicht erreicht werden.'));
    script.src = `${url}?action=${encodeURIComponent(action)}&payload=${encodeURIComponent(JSON.stringify(payload))}&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
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


function getAdminToken() { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
function setAdminToken(token) {
  if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}
function adminPayload(payload = {}) { return { ...payload, adminToken: getAdminToken() }; }
async function ensureAdminAccess() {
  const token = getAdminToken();
  if (!token) { $('#adminLoginError').hidden = true; $('#adminLoginForm').reset(); $('#adminLoginDialog').showModal(); return false; }
  try {
    await sendCloudJsonpAction('adminStatus', { adminToken: token });
    return true;
  } catch (_) {
    setAdminToken('');
    $('#adminLoginError').textContent = 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.';
    $('#adminLoginError').hidden = false;
    $('#adminLoginDialog').showModal();
    return false;
  }
}
async function openAdministration() {
  closeMainMenu();
  if (!(await ensureAdminAccess())) return;
  showPage('adminPage');
  renderAdminProjects();
  renderAdminProducts();
  loadInventoryDraft();
  renderInventory();
  loadQrCodes().catch(error => toast('QR-Code-Datenbank konnte nicht geladen werden: ' + error.message));
}
async function submitAdminLogin(event) {
  event.preventDefault();
  const button = $('#adminLoginSubmitBtn');
  button.disabled = true; button.textContent = 'Wird geprüft …';
  $('#adminLoginError').hidden = true;
  try {
    const response = await sendCloudJsonpAction('adminLogin', {
      username: $('#adminUsername').value.trim(),
      password: $('#adminPassword').value
    });
    setAdminToken(response.adminToken || '');
    $('#adminLoginDialog').close();
    showPage('adminPage');
    renderAdminProjects();
    renderAdminProducts();
    loadInventoryDraft();
    renderInventory();
    toast('Administration entsperrt.');
  } catch (error) {
    $('#adminLoginError').textContent = error.message || 'Anmeldung fehlgeschlagen.';
    $('#adminLoginError').hidden = false;
  } finally { button.disabled = false; button.textContent = 'Anmelden'; }
}

function bind() {
  $('#search').oninput = render;
  $$('.menu-nav').forEach(button => button.onclick = () => { if (button.dataset.page === 'adminPage') openAdministration(); else { showPage(button.dataset.page); closeMainMenu(); } });
  $('#menuBtn').onclick = toggleMainMenu;
  $('#menuSettingsBtn').onclick = () => { closeMainMenu(); openSettingsDialog(); };
  $('#adminLoginForm').onsubmit = submitAdminLogin;
  $('#adminLogoutBtn').onclick = () => { setAdminToken(''); showPage('equipmentPage'); toast('Administration wurde gesperrt.'); };
  document.addEventListener('click', event => {
    if (!event.target.closest('.topbar-actions')) closeMainMenu();
  });
  $('#addProjectBtn').onclick = openProjectDialog;
  $('#adminAddProductBtn').onclick = openProductDialog;
  $('#scanProductQrBtn').onclick = openProductQrScanner;
  $('#generateQrBatchBtn').onclick = generateQrBatch;
  $('#downloadQrCsvBtn').onclick = downloadFreeQrCsv;
  $('#projectForm').onsubmit = submitProject;
  $('#calculationPreviewBtn').onclick = previewProjectCalculation;
  $('#calculationEmailBtn').onclick = emailProjectCalculation;
  ['calculationDiscount','calculationExtraCost','calculationExtraLabel','calculationTaxMode'].forEach(id => {
    const el = $('#'+id); if (el) el.oninput = el.onchange = updateCalculationTotal;
  });
  $('#projectName').addEventListener('input', updateProjectNumberPreview);
  $('#projectStart').addEventListener('change', updateProjectNumberPreview);
  $('#reservationForm').onsubmit = submitReservation;
  $('#reservationProject').onchange = updateReservationProjectInfo;
  $('#reservationProduct').onchange = updateReservationAvailability;
  $('#reservationFrom').onchange = updateReservationAvailability;
  $('#reservationTo').onchange = updateReservationAvailability;
  $('#reservationQuantity').oninput = updateReservationAvailability;
  $('#reservationQuantity').onchange = () => setReservationQuantity($('#reservationQuantity').value, true);
  $('#reservationQuantity').onblur = () => setReservationQuantity($('#reservationQuantity').value, false);
  $('#reservationQuantityMinus').onclick = () => changeReservationQuantity(-1);
  $('#reservationQuantityPlus').onclick = () => changeReservationQuantity(1);
  $('#deleteReservationBtn').onclick = removeReservationFromProject;
  $('#refreshCalendarBtn').onclick = renderCalendar;
  $('#actionForm').onsubmit = submitMovement;
  $('#actionProject').onchange = updateActionProjectInfo;
  $('#actionFrom').onchange = updateActionAvailability;
  $('#actionTo').onchange = updateActionAvailability;
  $('#damageQuantity').oninput = updateDamageTotal;
  $('#damageUnitValue').oninput = updateDamageTotal;
  $('#quantity').oninput = updateActionAvailability;
  $('#productForm').onsubmit = submitProduct;
  if ($('#addProductBtn')) $('#addProductBtn').onclick = openProductDialog;
  $('#productCategory').onchange = updateProductIdPreview;
  $('#productDriveImage').onchange = event => {
    const url = event.target.value;
    if (!url) { selectedProductImage = null; return; }
    const option = event.target.selectedOptions[0];
    if ($('#productImage')) $('#productImage').value = '';
    selectedProductImage = { existingUrl: url, filename: option?.dataset?.name || 'Drive-Bild' };
    $('#productImagePreview').innerHTML = `<img src="${escapeHtml(url)}" alt="Vorschau"><span>${escapeHtml(selectedProductImage.filename)}</span>`;
  };
  $('#syncDriveImagesBtn').onclick = syncDriveImages;
  bindImageUpload();

  $('#scanBtn').onclick = () => {
    scanTarget = 'detail';
    reservationScanSnapshot = null;
    $('#scanDialog').showModal();
  };
  $('#reservationScanBtn').onclick = openReservationScanner;
  $('#inventoryScanBtn').onclick = openInventoryScanner;
  $('#inventoryResetBtn').onclick = resetInventory;
  $('#inventorySaveBtn').onclick = saveInventory;
  $('#calculationSaveTopBtn').onclick = saveProjectCalculation;
  $('#calculationSaveBottomBtn').onclick = saveProjectCalculation;

  $$('[data-close]').forEach(button => {
    button.onclick = async () => {
      const dialog = button.closest('dialog');
      if (dialog.id === 'scanDialog') await stopCameraScan();
      dialog.close();
      if (dialog.id === 'scanDialog' && scanTarget === 'reservation' && reservationScanSnapshot) {
        restoreReservationAfterScan('');
        scanTarget = 'detail';
      }
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
    const newSettings = { apiUrl: DEFAULT_API_URL, cloudMode: true };
    try {
      if (newSettings.cloudMode) await testCloudConnection(newSettings.apiUrl);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
      await refreshCatalog();
      render();
      $('#settingsDialog').close();
      toast('Verbindung gespeichert. Synchronisierung ist aktiv.');
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
    handleScannedArticle(extractArticleId($('#manualId').value.trim()));
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

function normalizeQrCode(value) {
  const match = String(value || '').trim().toUpperCase().match(/CMEQR-\d{8,}/);
  return match ? match[0] : '';
}

function extractArticleId(decodedText) {
  const text = String(decodedText || '').trim();
  const qrCode = normalizeQrCode(text);
  if (qrCode) return qrCode;
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
        handleScannedArticle(id);
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
function normalizeDamage(item) {
  return {
    id: String(item.id || ''), productId: String(item.productId || '').toUpperCase(),
    quantity: Number(item.quantity || 0), date: String(item.date || ''),
    description: String(item.description || ''), projectId: String(item.projectId || ''),
    projectLinked: Boolean(item.projectLinked), unitValue: Number(item.unitValue || 0),
    totalValue: Number(item.totalValue || 0), status: String(item.status || 'Offen')
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
  const apiUrlInput = $('#apiUrl');
  const cloudModeInput = $('#cloudMode');
  const settingsDialog = $('#settingsDialog');
  if (apiUrlInput) {
    apiUrlInput.value = currentSettings.apiUrl;
    apiUrlInput.readOnly = true;
  }
  if (cloudModeInput) {
    cloudModeInput.checked = true;
    cloudModeInput.disabled = true;
  }
  settingsDialog?.showModal();
}
async function deleteProject(projectId) {
  const project = projects.find(item => item.id === projectId);
  if (!project) return;
  const linked = reservations.filter(item => item.projectId === projectId && item.status !== 'Storniert');
  const bookingNote = linked.length ? ` Dabei werden auch ${linked.length} zugehörige Buchung${linked.length === 1 ? '' : 'en'} gelöscht.` : '';
  if (!confirm(`Projekt „${project.name}“ wirklich löschen?${bookingNote} Diese Aktion kann nicht rückgängig gemacht werden.`)) return;
  try {
    if (settings().cloudMode) await sendCloudJsonpAction('deleteProject',adminPayload({projectId}));
    $('#projectDetailDialog')?.close();
    await refreshCatalog(); render(); showPage('adminPage'); renderAdminProjects(); toast('Projekt gelöscht.');
  } catch (error) { toast(error.message || 'Projekt konnte nicht gelöscht werden.'); }
}
function showPage(pageId) {
  $$('.app-page').forEach(page => page.classList.toggle('hidden', page.id !== pageId));
  $$('.menu-nav').forEach(btn => btn.classList.toggle('active', btn.dataset.page === pageId));
  const titles = {equipmentPage:'Equipment',projectsPage:'Projekte',calendarPage:'Kalender',inventoryPage:'Administration',adminPage:'Administration'};
  const title = titles[pageId] || 'Equipment';
  const heading = document.querySelector('.topbar h1');
  if (heading) heading.textContent = title;
  if(pageId==='calendarPage') renderCalendar();
  if(pageId==='inventoryPage') renderInventory();
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
  const words = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .match(/[A-Z0-9]+/g) || [];

  const code = [];
  for (const word of words) {
    if (code.length >= 3) break;
    code.push(/^\d+$/.test(word) ? word.slice(0, 1) : word.charAt(0));
  }

  // Bei kurzen Namen mit nur ein oder zwei Wörtern werden weitere Buchstaben
  // aus dem Projektnamen ergänzt, damit das Kürzel immer drei Zeichen hat.
  const remaining = words.join('').replace(/[^A-Z0-9]/g, '');
  for (const character of remaining) {
    if (code.length >= 3) break;
    if (!code.includes(character) || remaining.length < 3) code.push(character);
  }
  return (code.join('').slice(0, 3) || 'PRJ').padEnd(3, 'X');
}
function projectDateCode(date) {
  const [year, month, day] = String(date || todayIso()).split('-');
  return `${day}${month}${String(year).slice(-2)}`;
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
  const previousProjects = [...projects];
  const index = projects.findIndex(item => item.id === project.id);
  if (index >= 0) projects[index] = project; else projects.unshift(project);
  projects.sort((a,b) => String(b.start).localeCompare(String(a.start)));
  render(); $('#projectDialog').close(); showPage('projectsPage'); openProjectDetail(project.id);
  toast('Projekt gespeichert. Synchronisierung läuft im Hintergrund.');
  try {
    if(settings().cloudMode) await sendCloudJsonpAction('saveProject',project);
  } catch (error) {
    projects = previousProjects; render();
    toast('Projekt konnte nicht synchronisiert werden: ' + error.message);
  }
}
function projectReservations(projectId) { return reservations.filter(r=>r.projectId===projectId && r.status!=='Storniert'); }
function openProjectDetail(projectId) {
  const p=projects.find(x=>x.id===projectId); if(!p) return toast('Projekt nicht gefunden.'); activeProjectId=p.id;
  const rows=projectReservations(p.id);
  $('#projectDetailContent').innerHTML=`<small>COCOMAC ESSENTIAL</small><h2>${escapeHtml(p.name)}</h2><div class="project-meta-grid"><div><b>Zeitraum</b><br>${formatDate(p.start)} – ${formatDate(p.end)}</div><div><b>Status</b><br>${escapeHtml(p.status)}</div><div><b>Ansprechpartner</b><br>${escapeHtml(p.contact||'–')}</div><div><b>E-Mail</b><br>${escapeHtml([p.email1,p.email2].filter(Boolean).join(', ')||'–')}</div></div>${p.notes?`<p>${escapeHtml(p.notes)}</p>`:''}<div class="project-actions"><button id="addReservationBtn" type="button">+ Equipment hinzufügen</button><button id="editProjectBtn" type="button" class="ghost">Projekt bearbeiten</button><button id="projectCalculationBtn" type="button" class="ghost">Projektkalkulation</button></div><div class="booking-table">${rows.length?rows.map(r=>{const item=catalog.find(x=>x.id===r.productId);return `<button type="button" class="booking-row booking-row-button" data-edit-reservation="${escapeHtml(r.id)}"><div><b>${r.quantity} × ${escapeHtml(item?.name||r.productId)}</b><br><small>${escapeHtml(r.productId)} · ${formatDate(r.from)}–${formatDate(r.to)}</small></div><div class="booking-row-side"><span class="status-badge">${escapeHtml(r.status)}</span><small>Bearbeiten</small></div></button>`}).join(''):'<div class="empty-state">Noch kein Equipment zugeordnet.</div>'}</div>`;
  $('#addReservationBtn').onclick=()=>openReservationDialog(p.id);
  $$('[data-edit-reservation]').forEach(button => button.onclick = () => openReservationDialog(p.id, '', 'project', button.dataset.editReservation));
  $('#editProjectBtn').onclick=()=>{ $('#projectDetailDialog').close(); openProjectDialog(p.id); };
  $('#projectCalculationBtn').onclick=()=>openProjectCalculation(p.id);
  $('#projectDetailDialog').showModal();
}
function projectOptionLabel(project) {
  const number = project.number ? ` · ${project.number}` : '';
  return `${project.name}${number} (${formatDate(project.start)}–${formatDate(project.end)})`;
}

function openReservationScanner() {
  reservationScanSnapshot = {
    projectId: $('#reservationProject')?.value || '',
    editId: $('#reservationEditId')?.value || '',
    origin: reservationOrigin,
    quantity: $('#reservationQuantity')?.value || '1',
    status: $('#reservationStatus')?.value || 'Reserviert',
    from: $('#reservationFrom')?.value || '',
    to: $('#reservationTo')?.value || '',
    note: $('#reservationNote')?.value || ''
  };
  scanTarget = 'reservation';
  $('#reservationDialog').close();
  $('#scanDialog').showModal();
}

async function handleScannedArticle(id) {
  if (scanTarget === 'inventory') {
    addInventoryScan(id);
    return;
  }
  if (scanTarget === 'reservation') {
    handleReservationScan(id);
    return;
  }
  if (scanTarget === 'productQr') {
    handleProductQrScan(id);
    return;
  }
  openScannedProduct(id);
}
function restoreReservationAfterScan(productId) {
  const snapshot = reservationScanSnapshot;
  reservationScanSnapshot = null;
  if (!snapshot) return;
  openReservationDialog(snapshot.projectId, productId, snapshot.origin, snapshot.editId);
  $('#reservationQuantity').value = snapshot.quantity;
  $('#reservationStatus').value = snapshot.status;
  if (snapshot.from) $('#reservationFrom').value = snapshot.from;
  if (snapshot.to) $('#reservationTo').value = snapshot.to;
  $('#reservationNote').value = snapshot.note;
  updateReservationAvailability();
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
      <div><small>Zeitraum</small><b>${project.start ? `${formatDate(project.start)}–${formatDate(project.end)}` : 'Kein Projektzeitraum'}</b></div>
      <div><small>Ansprechpartner</small><b>${escapeHtml(project.contact || '–')}</b></div>
      <div><small>E-Mail</small><b>${escapeHtml(emails)}</b></div>
      <div><small>Bereits zugeordnet</small><b>${projectReservations(project.id).reduce((sum, row) => sum + row.quantity, 0)} Teile</b></div>
    </div>`;
  updateReservationAvailability();
}

function reservationQuantityMaximum() {
  const productId = $('#reservationProduct')?.value || '';
  const from = $('#reservationFrom')?.value || '';
  const to = $('#reservationTo')?.value || '';
  const editId = $('#reservationEditId')?.value || '';
  if (!productId || !from || !to) return 1;
  return Math.max(0, Number(availableFor(productId, from, to, editId) || 0));
}

function setReservationQuantity(nextValue, showLimitMessage = false) {
  const input = $('#reservationQuantity');
  if (!input) return;
  const maximum = reservationQuantityMaximum();
  let value = Math.round(Number(nextValue));
  if (!Number.isFinite(value)) value = 1;
  value = Math.max(1, value);
  if (maximum > 0 && value > maximum) {
    value = maximum;
    if (showLimitMessage) toast(`Maximalkapazität erreicht: Es sind nur ${maximum} Stück verfügbar.`);
  } else if (maximum < 1) {
    value = 1;
    if (showLimitMessage) toast('Für diesen Zeitraum ist kein weiteres Stück verfügbar.');
  }
  input.value = String(value);
  updateReservationAvailability();
}

function changeReservationQuantity(direction) {
  const input = $('#reservationQuantity');
  const current = Math.max(1, Math.round(Number(input?.value || 1)));
  const maximum = reservationQuantityMaximum();
  if (direction > 0 && maximum > 0 && current >= maximum) {
    input.value = String(maximum);
    toast(`Maximalkapazität erreicht: Es sind nur ${maximum} Stück verfügbar.`);
    return;
  }
  if (direction < 0 && current <= 1) {
    input.value = '1';
    toast('Die Mindestmenge ist 1.');
    return;
  }
  setReservationQuantity(current + direction, true);
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
  const button = $('#reservationSubmitBtn');
  const originalText = button?.textContent || 'Equipment hinzufügen';
  const editId = $('#reservationEditId').value;
  const r = normalizeReservation({
    id: editId || (crypto.randomUUID ? crypto.randomUUID() : `RES-${Date.now()}-${Math.random().toString(36).slice(2,8)}`),
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

  const previousReservations = [...reservations];
  const existingIndex = reservations.findIndex(item => String(item.id) === String(r.id));
  if (existingIndex >= 0) reservations[existingIndex] = r; else reservations.push(r);

  // Sofortige Reaktion: Dialog schließen und Projektansicht aktualisieren.
  $('#reservationDialog').close();
  render();
  if (reservationOrigin === 'project') {
    showPage('projectsPage');
    openProjectDetail(r.projectId);
  } else {
    openDetail(r.productId);
  }
  toast(editId ? 'Änderung gespeichert. Synchronisierung läuft.' : 'Equipment hinzugefügt. Synchronisierung läuft.');

  try {
    if (button) { button.disabled = true; button.textContent = 'Synchronisierung …'; }
    if (!settings().cloudMode) throw new Error('Die Cloud-Verbindung ist nicht aktiv.');
    const response = await sendCloudJsonpAction('saveReservation', r);
    if (!response || response.ok === false) throw new Error(response?.error || 'Die Buchung wurde nicht bestätigt.');
    if (response.reservation) {
      const confirmed = normalizeReservation(response.reservation);
      const confirmedIndex = reservations.findIndex(item => String(item.id) === String(confirmed.id));
      if (confirmedIndex >= 0) reservations[confirmedIndex] = confirmed;
    }
  } catch (error) {
    reservations = previousReservations;
    render();
    if (reservationOrigin === 'project') openProjectDetail(r.projectId); else openDetail(r.productId);
    toast('Buchung konnte nicht synchronisiert werden: ' + error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

async function removeReservationFromProject() {
  const reservationId = $('#reservationEditId').value;
  const reservation = reservations.find(item => item.id === reservationId);
  if (!reservation) return toast('Buchung nicht gefunden.');
  const product = catalog.find(item => item.id === reservation.productId);
  if (!confirm(`${product?.name || reservation.productId} wirklich aus diesem Projekt entfernen?`)) return;
  const cancelled = normalizeReservation({...reservation, status:'Storniert'});
  try {
    if (settings().cloudMode) await sendCloudJsonpAction('saveReservation',cancelled);
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



function openProductQrScanner() {
  productQrScanReturnDialog = $('#productDialog');
  productQrScanReturnDialog.close();
  scanTarget = 'productQr';
  $('#manualId').value = '';
  $('#scanDialog').showModal();
  setScannerStatus('Scanne einen freien vorgedruckten Cocomac-QR-Code.');
}

async function loadQrCodes() {
  const result = await sendCloudJsonpAction('listQrCodes', adminPayload({ limit: 250 }));
  qrCodes = Array.isArray(result?.qrCodes) ? result.qrCodes : [];
  renderQrDatabase();
  return qrCodes;
}

function renderQrDatabase() {
  const summary = $('#qrDatabaseSummary');
  const wrap = $('#qrCodeList');
  if (!summary || !wrap) return;
  const free = qrCodes.filter(code => code.status === 'frei');
  const assigned = qrCodes.filter(code => code.status === 'zugeordnet');
  summary.textContent = `${qrCodes.length} zuletzt geladene Codes: ${free.length} frei, ${assigned.length} zugeordnet. Die Datenbank kann jederzeit weiter hochgezählt werden.`;
  wrap.innerHTML = qrCodes.slice(0, 100).map(code => `<div class="admin-product-row"><div><div class="qr-code-value">${escapeHtml(code.qrCode)}</div><small class="${code.status === 'frei' ? 'qr-status-free' : 'qr-status-assigned'}">${escapeHtml(code.status)}${code.productId ? ` · ${escapeHtml(code.productId)}` : ''}</small></div><div class="admin-row-actions"><button type="button" class="ghost" data-copy-qr="${escapeHtml(code.qrCode)}">Kopieren</button></div></div>`).join('') || '<p>Noch keine QR-Codes erzeugt.</p>';
  $$('[data-copy-qr]').forEach(button => button.onclick = async () => { await navigator.clipboard.writeText(button.dataset.copyQr); toast('QR-Code kopiert.'); });
}

async function generateQrBatch() {
  if (!(await ensureAdminAccess())) return;
  const count = Math.max(1, Math.min(1000, Math.round(Number($('#qrBatchCount').value || 100))));
  const button = $('#generateQrBatchBtn');
  button.disabled = true; button.textContent = 'Codes werden erzeugt …';
  try {
    const result = await sendCloudJsonpAction('generateQrCodes', adminPayload({ count }));
    qrCodes = Array.isArray(result?.qrCodes) ? result.qrCodes : qrCodes;
    renderQrDatabase();
    downloadQrCsv(result?.created || []);
    toast(`${Number(result?.created?.length || count)} neue QR-Codes wurden erzeugt.`);
  } catch (error) { toast('QR-Codes konnten nicht erzeugt werden: ' + error.message); }
  finally { button.disabled = false; button.textContent = 'QR-Codes erzeugen'; }
}

async function downloadFreeQrCsv() {
  if (!(await ensureAdminAccess())) return;
  try {
    const result = await sendCloudJsonpAction('listQrCodes', adminPayload({ status: 'frei', limit: 5000 }));
    downloadQrCsv(result?.qrCodes || []);
  } catch (error) { toast('CSV konnte nicht erstellt werden: ' + error.message); }
}

function downloadQrCsv(codes) {
  if (!Array.isArray(codes) || !codes.length) return toast('Es sind keine freien QR-Codes vorhanden.');
  const rows = [['QR-Code','QR-Inhalt','Status'], ...codes.map(code => [code.qrCode, `${PRODUCT_URL_BASE}?qr=${encodeURIComponent(code.qrCode)}`, code.status || 'frei'])];
  const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g,'""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `cocomac-qr-codes-${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function renderAdminProjects() {
  const wrap = $('#adminProjectList');
  if (!wrap) return;
  const sorted = projects.slice().sort((a,b) => String(b.start).localeCompare(String(a.start)));
  wrap.innerHTML = sorted.length ? sorted.map(project => {
    const linked = reservations.filter(item => item.projectId === project.id && item.status !== 'Storniert');
    return `<div class="admin-product-row admin-project-row">
      <div class="admin-project-icon">CME</div>
      <div><b>${escapeHtml(project.name)}</b><br><small>${escapeHtml(project.number || project.id)} · ${formatDate(project.start)}–${formatDate(project.end)} · ${linked.length} Buchungen</small></div>
      <div class="admin-row-actions"><button type="button" class="ghost" data-admin-edit-project="${escapeHtml(project.id)}">Bearbeiten</button><button type="button" class="danger" data-admin-delete-project="${escapeHtml(project.id)}">Löschen</button></div>
    </div>`;
  }).join('') : '<div class="empty-state">Keine Projekte vorhanden.</div>';
  $$('[data-admin-edit-project]').forEach(button => button.onclick = () => openProjectDialog(button.dataset.adminEditProject));
  $$('[data-admin-delete-project]').forEach(button => button.onclick = () => deleteProject(button.dataset.adminDeleteProject));
}

function renderAdminProducts() {
  const wrap = $('#adminProductList');
  if (!wrap) return;
  const sorted = catalog.slice().sort((a,b) => a.name.localeCompare(b.name, 'de'));
  wrap.innerHTML = sorted.length ? sorted.map(item => {
    const image = productImageSource(item);
    return `<div class="admin-product-row">
      ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}">` : '<div class="image-placeholder">Kein Foto</div>'}
      <div class="admin-product-copy"><b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(item.id)} · ${escapeHtml(item.category)} · Bestand ${item.total}</small></div>
      <div class="admin-row-actions"><button type="button" class="ghost" data-edit-product="${escapeHtml(item.id)}">Bearbeiten</button></div>
    </div>`;
  }).join('') : '<div class="empty-state">Keine Produkte vorhanden.</div>';
  $$('[data-edit-product]').forEach(button => button.onclick = () => openProductDialog(button.dataset.editProduct));
}

async function deleteProduct(productId, options = {}) {
  if (!(await ensureAdminAccess())) {
    toast('Bitte zuerst als Administrator anmelden.');
    return;
  }
  const product = catalog.find(item => item.id === productId);
  if (!product) return;
  const linked = reservations.filter(item => item.productId === productId && !['Storniert','Zurückgegeben'].includes(item.status));
  if (linked.length) return toast('Dieses Produkt ist noch in aktiven Projekten reserviert und kann deshalb nicht gelöscht werden.');
  if (!confirm(`„${product.name}“ wirklich löschen? Dieser Schritt blendet das Produkt auf allen Geräten aus.`)) return;
  try {
    if (settings().cloudMode) await sendCloudJsonpAction('deleteProduct',adminPayload({productId}));
    const deleted = new Set(readJson(LOCAL_DELETED_PRODUCTS_KEY, []).map(id => String(id).toUpperCase()));
    deleted.add(productId.toUpperCase());
    localStorage.setItem(LOCAL_DELETED_PRODUCTS_KEY, JSON.stringify([...deleted]));
    const localProducts = readJson(LOCAL_PRODUCTS_KEY, []).filter(item => String(item.id).toUpperCase() !== productId.toUpperCase());
    localStorage.setItem(LOCAL_PRODUCTS_KEY, JSON.stringify(localProducts));
    await refreshCatalog();
    render();
    if (options.closeDialog && $('#productDialog')?.open) $('#productDialog').close();
    toast('Produkt gelöscht.');
  } catch (error) {
    toast('Produkt konnte nicht gelöscht werden: ' + error.message);
  }
}

function openInventoryScanner() {
  scanTarget = 'inventory';
  $('#manualScanForm label').firstChild.textContent = 'Artikel-ID oder QR-Code manuell eingeben';
  $('#manualId').placeholder = 'CME-KIT-001 oder CMEQR-00000001';
  $('#scanDialog h2').textContent = 'Inventur scannen';
  $('#scanDialog').showModal();
  setScannerStatus('Scanne einen Artikel für die laufende Inventur.');
}

async function resolveScannedProductId(value) {
  const qrCode = normalizeQrCode(value);
  if (!qrCode) return String(value || '').toUpperCase();
  if (!settings().cloudMode) return '';
  const result = await sendCloudJsonpAction('resolveQrCode', { qrCode });
  return String(result?.productId || '').toUpperCase();
}

async function addInventoryScan(value) {
  try {
    const productId = await resolveScannedProductId(value);
    const product = catalog.find(item => item.id === productId);
    if (!product) return toast('Dieser Artikel wurde nicht gefunden.');
    inventoryCounts[productId] = Math.min(Number(product.total || 0) + 999, Number(inventoryCounts[productId] || 0) + 1);
    persistInventoryDraft();
    renderInventory();
    toast(`${product.name}: ${inventoryCounts[productId]} gezählt.`);
  } catch (error) { toast(error.message || 'QR-Code konnte nicht aufgelöst werden.'); }
}

function persistInventoryDraft() {
  localStorage.setItem(LOCAL_INVENTORY_KEY, JSON.stringify({ date: $('#inventoryDate')?.value || todayIso(), name: $('#inventoryName')?.value || '', counts: inventoryCounts }));
}

function loadInventoryDraft() {
  const draft = readJson(LOCAL_INVENTORY_KEY, {});
  inventoryCounts = draft.counts && typeof draft.counts === 'object' ? draft.counts : {};
  if ($('#inventoryDate')) $('#inventoryDate').value = draft.date || todayIso();
  if ($('#inventoryName')) $('#inventoryName').value = draft.name || `Inventur ${formatDate(todayIso())}`;
}

function resetInventory() {
  if (Object.keys(inventoryCounts).length && !confirm('Laufende Inventur wirklich zurücksetzen?')) return;
  inventoryCounts = {};
  localStorage.removeItem(LOCAL_INVENTORY_KEY);
  loadInventoryDraft();
  renderInventory();
}

function renderInventory() {
  if (!$('#inventoryList')) return;
  if (!$('#inventoryDate').value) loadInventoryDraft();
  const rows = catalog.slice().sort((a,b)=>a.category.localeCompare(b.category,'de') || a.name.localeCompare(b.name,'de'));
  const expected = rows.reduce((sum,item)=>sum+Number(item.total||0),0);
  const counted = rows.reduce((sum,item)=>sum+Number(inventoryCounts[item.id]||0),0);
  const complete = rows.filter(item=>Number(inventoryCounts[item.id]||0)===Number(item.total||0)).length;
  $('#inventorySummary').innerHTML = [['Soll',expected],['Gezählt',counted],['Vollständig',`${complete}/${rows.length}`]].map(([l,v])=>`<div class="stat"><strong>${v}</strong><span>${l}</span></div>`).join('');
  $('#inventoryList').innerHTML = rows.map(item=>{
    const count=Number(inventoryCounts[item.id]||0), diff=count-Number(item.total||0);
    return `<div class="inventory-row ${diff===0&&count>0?'inventory-ok':diff!==0&&count>0?'inventory-difference':''}">
      <img src="${escapeHtml(item.image || item.imageUrl || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="inventory-copy"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.id)} · ${escapeHtml(item.category)} · Soll ${item.total}</small></div>
      <div class="inventory-count-control"><button type="button" class="ghost" data-inventory-minus="${escapeHtml(item.id)}">−</button><input type="number" min="0" inputmode="numeric" data-inventory-count="${escapeHtml(item.id)}" value="${count}"><button type="button" data-inventory-plus="${escapeHtml(item.id)}">+</button></div>
      <div class="inventory-diff ${diff===0?'ok':diff<0?'missing':'extra'}">${diff===0?'✓':diff>0?'+'+diff:String(diff)}</div>
    </div>`;
  }).join('') || '<div class="empty-state">Keine Produkte vorhanden.</div>';
  $$('[data-inventory-count]').forEach(input=>input.onchange=()=>{inventoryCounts[input.dataset.inventoryCount]=Math.max(0,Math.round(Number(input.value||0)));persistInventoryDraft();renderInventory();});
  $$('[data-inventory-minus]').forEach(btn=>btn.onclick=()=>{const id=btn.dataset.inventoryMinus;inventoryCounts[id]=Math.max(0,Number(inventoryCounts[id]||0)-1);persistInventoryDraft();renderInventory();});
  $$('[data-inventory-plus]').forEach(btn=>btn.onclick=()=>{const id=btn.dataset.inventoryPlus;inventoryCounts[id]=Number(inventoryCounts[id]||0)+1;persistInventoryDraft();renderInventory();});
  $('#inventoryDate').onchange = persistInventoryDraft;
  $('#inventoryName').oninput = persistInventoryDraft;
}

async function saveInventory() {
  if (!(await ensureAdminAccess())) return toast('Bitte zuerst als Administrator anmelden.');
  const payload = adminPayload({
    id: `INV-${Date.now()}`,
    date: $('#inventoryDate').value || todayIso(),
    name: $('#inventoryName').value.trim() || `Inventur ${formatDate(todayIso())}`,
    items: catalog.map(item=>({productId:item.id, expected:Number(item.total||0), counted:Number(inventoryCounts[item.id]||0)}))
  });
  const button=$('#inventorySaveBtn'); button.disabled=true; button.textContent='Wird gespeichert …';
  try {
    if (settings().cloudMode) await sendCloudJsonpAction('saveInventory', payload, 30000);
    localStorage.setItem('cocomac-last-inventory', JSON.stringify(payload));
    toast('Inventur wurde gespeichert.');
  } catch(error) { toast('Inventur konnte nicht gespeichert werden: '+error.message); }
  finally { button.disabled=false; button.textContent='Inventur speichern'; }
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
function rentalDays(from, to) {
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}
function euro(value) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

let activeCalculation = null;

function buildDefaultCalculation(projectId) {
  const project = projects.find(item => item.id === projectId);
  if (!project) throw new Error('Projekt nicht gefunden.');
  const lines = projectReservations(projectId).map(reservation => {
    const product = catalog.find(item => item.id === reservation.productId);
    const days = rentalDays(reservation.from, reservation.to);
    return {
      reservationId: reservation.id,
      productId: reservation.productId,
      name: product?.name || reservation.productId,
      stock: Number(product?.total || 0),
      quantity: Number(reservation.quantity || 0),
      from: reservation.from,
      to: reservation.to,
      days,
      unitPrice: Number(product?.dailyPrice || 0),
      billingType: 'fixed',
      discount: 0,
      free: false
    };
  });
  return {
    projectId,
    lines,
    discount: 0,
    extraCost: 0,
    extraLabel: '',
    taxMode: 'net',
    note: '',
    emailTo: [project.email1, project.email2].filter(Boolean).join(', '),
    emailCc: '',
    emailSubject: `Cocomac Essentials – Equipment für ${project.name}`,
    emailBody: `Hallo,\n\nanbei findest du die Equipmentübersicht für das Projekt ${project.name}.\n\nViele Grüße\nCocomac Film GmbH`
  };
}

async function openProjectCalculation(projectId) {
  const project = projects.find(item => item.id === projectId);
  if (!project) return toast('Projekt nicht gefunden.');
  activeCalculation = buildDefaultCalculation(projectId);
  const localSaved = readJson(LOCAL_CALCULATIONS_KEY, {})[projectId];
  if (localSaved) activeCalculation = mergeSavedCalculation(activeCalculation, localSaved);
  if (settings().cloudMode) {
    try {
      const response = await sendCloudJsonpAction('getProjectCalculation', {projectId});
      if (response?.calculation) activeCalculation = mergeSavedCalculation(activeCalculation, response.calculation);
    } catch (error) { console.warn('Gespeicherte Kalkulation konnte nicht geladen werden:', error); }
  }
  calculationDirty = false;
  $('#calculationProjectId').value = projectId;
  $('#calculationProjectMeta').innerHTML = `<div><b>Projekt</b><br>${escapeHtml(project.name)}</div><div><b>Nummer</b><br>${escapeHtml(project.number || project.id)}</div><div><b>Zeitraum</b><br>${formatDate(project.start)} – ${formatDate(project.end)}</div><div><b>Ansprechpartner</b><br>${escapeHtml(project.contact || '–')}</div>`;
  $('#calculationDiscount').value = String(activeCalculation.discount || 0);
  $('#calculationExtraCost').value = String(activeCalculation.extraCost || 0);
  $('#calculationExtraLabel').value = activeCalculation.extraLabel || '';
  $('#calculationTaxMode').value = activeCalculation.taxMode || 'net';
  $('#calculationNote').value = activeCalculation.note || '';
  $('#calculationEmailTo').value = activeCalculation.emailTo;
  $('#calculationEmailCc').value = activeCalculation.emailCc || '';
  $('#calculationEmailSubject').value = activeCalculation.emailSubject;
  $('#calculationEmailBody').value = activeCalculation.emailBody;
  renderCalculationRows();
  setCalculationSaveStatus('');
  $('#projectCalculationDialog').showModal();
  $('#projectCalculationForm').oninput = () => { calculationDirty=true; setCalculationSaveStatus('Ungespeicherte Änderungen'); };
}

function renderCalculationRows() {
  const wrap = $('#calculationRows');
  wrap.innerHTML = activeCalculation.lines.length ? activeCalculation.lines.map((line,index)=>`
    <div class="calculation-row" data-calculation-index="${index}">
      <div class="product-cell"><b>${escapeHtml(line.name)}</b><br><small>${escapeHtml(line.productId)} · Bestand ${line.stock}<br>${formatDate(line.from)}–${formatDate(line.to)} · ${line.days} Tag${line.days===1?'':'e'}</small></div>
      <label>Menge<input data-calc-field="quantity" type="number" min="0" step="1" value="${line.quantity}"></label>
      <label>Abrechnung<select data-calc-field="billingType">
        <option value="fixed" ${line.billingType==='fixed'?'selected':''}>Fixpreis</option>
        <option value="daily" ${line.billingType==='daily'?'selected':''}>Tagespreis</option>
        <option value="weekly" ${line.billingType==='weekly'?'selected':''}>Wochenpreis</option>
        <option value="monthly" ${line.billingType==='monthly'?'selected':''}>Monatspreis</option>
      </select></label>
      <label><span data-price-label>${billingPriceLabel(line.billingType)}</span><input data-calc-field="unitPrice" type="number" min="0" step="0.01" value="${line.unitPrice}"></label>
      <label>Rabatt %<input data-calc-field="discount" type="number" min="0" max="100" step="1" inputmode="numeric" value="${Math.round(Number(line.discount || 0))}"></label>
      <label class="checkbox-line"><input data-calc-field="free" type="checkbox" ${line.free?'checked':''}> Kostenlos</label>
    </div>`).join('') : '<div class="empty-state">Noch kein Equipment im Projekt.</div>';
  $$('[data-calculation-index]').forEach(row => {
    const index = Number(row.dataset.calculationIndex);
    row.querySelectorAll('[data-calc-field]').forEach(input => {
      input.oninput = input.onchange = () => {
        const field = input.dataset.calcField;
        if (field === 'free') {
          activeCalculation.lines[index][field] = input.checked;
        } else if (field === 'billingType') {
          activeCalculation.lines[index][field] = input.value;
          const priceLabel = row.querySelector('[data-price-label]');
          if (priceLabel) priceLabel.textContent = billingPriceLabel(input.value);
        } else if (field === 'discount') {
          const rounded = Math.min(100, Math.max(0, Math.round(Number(input.value || 0))));
          input.value = String(rounded);
          activeCalculation.lines[index][field] = rounded;
        } else {
          activeCalculation.lines[index][field] = Number(input.value || 0);
        }
        calculationDirty = true;
        setCalculationSaveStatus('Ungespeicherte Änderungen');
        updateCalculationTotal();
      };
    });
  });
  updateCalculationTotal();
}

function mergeSavedCalculation(base, saved) {
  const savedLines = new Map((saved.lines || []).map(line => [line.reservationId || line.productId, line]));
  return {
    ...base, ...saved,
    lines: base.lines.map(line => ({...line, ...(savedLines.get(line.reservationId) || savedLines.get(line.productId) || {})})),
    projectId: base.projectId
  };
}

function setCalculationSaveStatus(text) {
  ['#calculationSaveStatusTop','#calculationSaveStatusBottom'].forEach(selector=>{const el=$(selector);if(el)el.textContent=text;});
}

async function saveProjectCalculation() {
  if (!activeCalculation) return;
  const calculation = readCalculationForm();
  const store = readJson(LOCAL_CALCULATIONS_KEY, {});
  store[calculation.projectId] = calculation;
  localStorage.setItem(LOCAL_CALCULATIONS_KEY, JSON.stringify(store));
  const buttons=[$('#calculationSaveTopBtn'),$('#calculationSaveBottomBtn')].filter(Boolean);
  buttons.forEach(button=>{button.disabled=true;button.textContent='Wird gespeichert …';});
  try {
    if (settings().cloudMode) await sendCloudJsonpAction('saveProjectCalculation', calculation, 30000);
    calculationDirty=false;
    setCalculationSaveStatus(`Gespeichert um ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})} Uhr`);
    toast('Projektkalkulation wurde zwischengespeichert.');
  } catch(error) { setCalculationSaveStatus('Speichern fehlgeschlagen'); toast('Kalkulation konnte nicht gespeichert werden: '+error.message); }
  finally { buttons.forEach(button=>{button.disabled=false;button.textContent='Zwischenstand speichern';}); }
}

function readCalculationForm() {
  activeCalculation.discount = Math.min(100, Math.max(0, Math.round(Number($('#calculationDiscount').value || 0))));
  $('#calculationDiscount').value = String(activeCalculation.discount);
  activeCalculation.extraCost = Math.max(0, Math.round(Number($('#calculationExtraCost').value || 0)));
  $('#calculationExtraCost').value = String(activeCalculation.extraCost);
  activeCalculation.extraLabel = $('#calculationExtraLabel').value.trim();
  activeCalculation.taxMode = $('#calculationTaxMode').value;
  activeCalculation.note = $('#calculationNote').value.trim();
  activeCalculation.emailTo = $('#calculationEmailTo').value.trim();
  activeCalculation.emailCc = $('#calculationEmailCc').value.trim();
  activeCalculation.emailSubject = $('#calculationEmailSubject').value.trim();
  activeCalculation.emailBody = $('#calculationEmailBody').value.trim();
  if ($('#calculationCopySelf').checked) {
    const project = projects.find(item => item.id === activeCalculation.projectId);
    const extra = project?.email2 || '';
    if (extra && !activeCalculation.emailCc.includes(extra)) activeCalculation.emailCc = [activeCalculation.emailCc, extra].filter(Boolean).join(', ');
  }
  return activeCalculation;
}

function billingPriceLabel(type) {
  return ({fixed:'Fixpreis / Stück',daily:'Tagespreis / Stück',weekly:'Wochenpreis / Stück',monthly:'Monatspreis / Stück'})[type] || 'Fixpreis / Stück';
}

function billingTypeLabel(type) {
  return ({fixed:'Fixpreis',daily:'Tagespreis',weekly:'Wochenpreis',monthly:'Monatspreis'})[type] || 'Fixpreis';
}

function billingUnits(line) {
  const days = Math.max(1, Number(line.days || 1));
  switch (line.billingType) {
    case 'daily': return days;
    case 'weekly': return Math.ceil(days / 7);
    case 'monthly': return Math.ceil(days / 30);
    default: return 1;
  }
}

function calculationTotals(calculation) {
  let subtotal = calculation.lines.reduce((sum,line)=>{
    const base = line.free ? 0 : Number(line.quantity||0) * Number(line.unitPrice||0) * billingUnits(line);
    return sum + base * (1-Math.min(100,Math.max(0,Number(line.discount||0)))/100);
  },0);
  subtotal *= 1-Math.min(100,Math.max(0,Number(calculation.discount||0)))/100;
  const net = subtotal + Number(calculation.extraCost||0);
  const gross = net * 1.19;
  return {subtotal,net,gross,total:calculation.taxMode==='gross'?gross:net};
}

function updateCalculationTotal() {
  if (!activeCalculation) return;
  readCalculationForm();
  $('#calculationGrandTotal').textContent = euro(calculationTotals(activeCalculation).total);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForEmailResult(requestId, timeoutMs = 90000, onStatus) {
  const started = Date.now();
  let lastStatus = '';
  while (Date.now() - started < timeoutMs) {
    const result = await sendCloudJsonpAction('emailStatus', { requestId }, 12000);
    if (result.status && result.status !== lastStatus) {
      lastStatus = result.status;
      if (typeof onStatus === 'function') onStatus(result);
    }
    if (result.status === 'sent') return result;
    if (result.status === 'error') throw new Error(result.error || 'E-Mail konnte nicht verschickt werden.');
    await sleep(1200);
  }
  throw new Error('Der Versand konnte nicht bestätigt werden. Bitte im Tabellenblatt „E-Mail-Protokoll“ nachsehen.');
}

function projectCalculationHtml(calculation) {
  const p = projects.find(item => item.id === calculation.projectId);
  if (!p) throw new Error('Projekt nicht gefunden.');
  const totals = calculationTotals(calculation);
  const rows = calculation.lines.map(line=>{
    const units = billingUnits(line);
    const base = line.free ? 0 : Number(line.quantity||0) * Number(line.unitPrice||0) * units;
    const lineTotal = base*(1-Math.min(100,Math.max(0,Number(line.discount||0)))/100);
    const billingText = line.free ? 'kostenlos' : `${euro(line.unitPrice)} · ${billingTypeLabel(line.billingType)}${units > 1 ? ` × ${units}` : ''}`;
    return `<tr><td>${escapeHtml(line.productId)}</td><td><b>${escapeHtml(line.name)}</b><br><small>Gesamtbestand: ${line.stock}</small></td><td>${line.quantity}</td><td>${formatDate(line.from)} – ${formatDate(line.to)}<br><small>${line.days} Tag${line.days===1?'':'e'}</small></td><td>${billingText}</td><td>${line.discount?line.discount+' %':'–'}</td><td>${euro(lineTotal)}</td></tr>`;
  }).join('');
  const taxRows = calculation.taxMode==='gross'
    ? `<div class="sumrow"><span>Netto</span><b>${euro(totals.net)}</b></div><div class="sumrow"><span>19 % MwSt.</span><b>${euro(totals.gross-totals.net)}</b></div><div class="sumrow total"><span>Brutto</span><b>${euro(totals.gross)}</b></div>`
    : `<div class="sumrow total"><span>Gesamtsumme netto</span><b>${euro(totals.net)}</b></div>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projektbeleg ${escapeHtml(p.name)}</title><style>*{box-sizing:border-box}body{font:14px Arial,sans-serif;padding:32px;color:#171716;max-width:1150px;margin:auto}h1{margin:8px 0 4px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px 7px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase}.summary{margin:24px 0 0 auto;width:min(390px,100%)}.sumrow{display:flex;justify-content:space-between;padding:7px 0}.total{border-top:2px solid;font-size:18px}.note{margin-top:25px;padding:14px;background:#f4f1e8}.sign{margin-top:70px;display:flex;gap:70px}.line{border-top:1px solid;width:240px;padding-top:7px}@media print{.no-print{display:none}body{padding:0}}</style></head><body><small>COCOMAC FILM GMBH · COCOMAC ESSENTIALS</small><h1>Equipment-Nachweisbeleg</h1><h2>${escapeHtml(p.name)}</h2><p><b>${escapeHtml(p.number||p.id)}</b><br>Projektzeitraum: ${formatDate(p.start)} – ${formatDate(p.end)}<br>Ansprechpartner: ${escapeHtml(p.contact||'–')}</p><table><thead><tr><th>Artikelnummer</th><th>Produkt</th><th>Menge</th><th>Zeitraum</th><th>Preis / Abrechnung</th><th>Rabatt</th><th>Summe</th></tr></thead><tbody>${rows||'<tr><td colspan="7">Keine Positionen.</td></tr>'}${calculation.extraCost?`<tr><td>Zusatz</td><td colspan="5">${escapeHtml(calculation.extraLabel||'Zusätzliche Kosten')}</td><td>${euro(calculation.extraCost)}</td></tr>`:''}</tbody></table><div class="summary">${calculation.discount?`<div class="sumrow"><span>Gesamtrabatt</span><b>${calculation.discount} %</b></div>`:''}${taxRows}</div>${calculation.note?`<div class="note"><b>Hinweis</b><br>${escapeHtml(calculation.note).replace(/\n/g,'<br>')}</div>`:''}<div class="sign"><div class="line">Ausgabe / Datum</div><div class="line">Unterschrift</div></div><div class="no-print" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:40px"><button onclick="window.print()" style="padding:12px 18px;font:inherit;font-weight:700">Drucken / als PDF sichern</button><button onclick="if(window.opener&&!window.opener.closed){window.close()}else{history.back()}" style="padding:12px 18px;font:inherit;font-weight:700;background:#fff;border:1px solid #171716">Zurück zur Kalkulation</button></div></body></html>`;
}

function previewProjectCalculation() {
  const calculation = readCalculationForm();
  sessionStorage.setItem('cocomacActiveCalculation', JSON.stringify(calculation));
  const popup = window.open('', '_blank');
  if (!popup) return toast('Bitte Pop-ups erlauben.');
  popup.document.open(); popup.document.write(projectCalculationHtml(calculation)); popup.document.close();
}

async function emailProjectCalculation() {
  const calculation = readCalculationForm();
  if (!calculation.emailTo) return toast('Bitte mindestens einen Empfänger eintragen.');
  if (!settings().cloudMode) return toast('Der E-Mail-Versand ist nur im Cloud-Modus möglich.');
  const button = $('#calculationEmailBtn');
  const originalLabel = button.textContent;
  const requestId = `mail_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  button.disabled = true;
  button.textContent = 'PDF und E-Mail werden erstellt …';
  try {
    const result = await sendCloudJsonpAction('emailProjectCalculation', {...calculation, requestId}, 120000);
    if (!result || result.ok === false || result.status !== 'sent') {
      throw new Error(result?.error || 'Der Versand wurde vom Backend nicht bestätigt.');
    }
    button.textContent = 'E-Mail versendet ✓';
    toast(`E-Mail wirklich versendet${result.from ? ` von ${result.from}` : ''}.`);
    await sleep(1500);
  } catch (error) {
    console.error('E-Mail-Versand fehlgeschlagen', error);
    toast(error.message || 'E-Mail konnte nicht verschickt werden.');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function projectDocumentHtml(projectId) {
  const p = projects.find(x => x.id === projectId);
  if (!p) throw new Error('Projekt nicht gefunden.');
  const rows = projectReservations(projectId);
  const projectDamages = damages.filter(d => d.projectLinked && d.projectId === projectId);
  let grandTotal = 0;
  const items = rows.map(r => {
    const item = catalog.find(x => x.id === r.productId);
    const days = rentalDays(r.from, r.to);
    const unitPrice = Number(item?.dailyPrice || 0);
    const lineTotal = unitPrice * Number(r.quantity || 0);
    grandTotal += lineTotal;
    return `<tr>
      <td>${escapeHtml(r.productId)}</td>
      <td><b>${escapeHtml(item?.name || r.productId)}</b><br><small>Gesamtbestand: ${Number(item?.total || 0)}</small></td>
      <td>${Number(r.quantity || 0)}</td>
      <td>${formatDate(r.from)} – ${formatDate(r.to)}<br><small>${days} Tag${days === 1 ? '' : 'e'}</small></td>
      <td>${euro(unitPrice)}</td>
      <td>${euro(lineTotal)}</td>
    </tr>`;
  }).join('');
  const damageTotal = projectDamages.reduce((sum, d) => sum + Number(d.totalValue || 0), 0);
  grandTotal += damageTotal;
  const damageItems = projectDamages.map(d => { const item = catalog.find(x => x.id === d.productId); return `<tr class="damage-line"><td>${escapeHtml(d.productId)}</td><td><b>Schaden: ${escapeHtml(item?.name || d.productId)}</b><br><small>${escapeHtml(d.description)}</small></td><td>${d.quantity}</td><td>${formatDate(d.date)}</td><td>${euro(d.unitValue)}</td><td>${euro(d.totalValue)}</td></tr>`; }).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Equipment ${escapeHtml(p.name)}</title><style>
    *{box-sizing:border-box}body{font:14px Arial,sans-serif;padding:32px;color:#171716;max-width:1100px;margin:auto}h1{margin:8px 0 4px}h2{margin:0 0 16px}.project-number{font-weight:700;letter-spacing:.05em}.meta{line-height:1.7;margin:18px 0}.table-wrap{width:100%;overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:24px;min-width:780px}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em}small{color:#666}.total{margin:20px 0 0 auto;width:min(340px,100%);display:flex;justify-content:space-between;border-top:2px solid #171716;padding-top:12px;font-size:18px}.sign{margin-top:70px;display:flex;gap:70px}.line{border-top:1px solid;width:240px;padding-top:7px}@media(max-width:700px){body{padding:18px}.sign{gap:30px}.line{width:50%}}@media print{body{padding:0}.table-wrap{overflow:visible}table{min-width:0}.no-print{display:none}}
  </style></head><body><small>COCOMAC FILM GMBH · COCOMAC ESSENTIALS</small><h1>Equipment-Ausgabe / Reservierung</h1><h2>${escapeHtml(p.name)}</h2><div class="project-number">${escapeHtml(p.number || p.id)}</div><div class="meta"><b>Projektzeitraum:</b> ${formatDate(p.start)} – ${formatDate(p.end)}<br><b>Ansprechpartner:</b> ${escapeHtml(p.contact || '–')}<br><b>Status:</b> ${escapeHtml(p.status)}</div><div class="table-wrap"><table><thead><tr><th>Artikelnummer</th><th>Produkt</th><th>Menge</th><th>Buchungszeitraum</th><th>Mietpreis / Stück</th><th>Positionspreis</th></tr></thead><tbody>${items || '<tr><td colspan="6">Kein Equipment zugeordnet.</td></tr>'}${damageItems}</tbody></table></div><div class="total"><b>Gesamter Mietpreis</b><b>${euro(grandTotal)}</b></div><div class="sign"><div class="line">Ausgabe / Datum</div><div class="line">Unterschrift</div></div><p class="no-print" style="margin-top:40px;text-align:center"><button onclick="window.print()" style="padding:12px 18px;font:inherit;font-weight:700">Drucken / als PDF sichern</button></p></body></html>`;
}
function printProjectDocument(projectId) {
  let html;
  try { html = projectDocumentHtml(projectId); }
  catch (error) { return toast(error.message || 'Beleg konnte nicht erstellt werden.'); }
  const printWindow = window.open('', '_blank');
  if (!printWindow) return toast('Bitte Pop-ups erlauben, damit die Belegübersicht geöffnet werden kann.');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
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
