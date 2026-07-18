const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const LOCAL_KEY = 'cocomac-essential-state-v1';
const SETTINGS_KEY = 'cocomac-essential-settings-v1';
const LOCAL_PRODUCTS_KEY = 'cocomac-essential-products-v1';
const PRODUCT_URL_BASE = 'https://remi-cmf.github.io/cocomac-essentials/';

let baseCatalog = [];
let catalog = [];
let state = { movements: [] };
let deferredPrompt = null;
let html5QrCode = null;
let scannerRunning = false;
let scanResultHandled = false;
let selectedProductImage = null;

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
  let cloudProducts = [];
  const currentSettings = settings();

  if (currentSettings.cloudMode && currentSettings.apiUrl) {
    try {
      cloudProducts = await loadCloudProducts(currentSettings.apiUrl);
    } catch (error) {
      console.warn('Cloud-Produkte konnten nicht geladen werden:', error);
    }
  }

  const merged = new Map();
  [...baseCatalog, ...localProducts, ...cloudProducts].forEach(item => {
    if (item?.id) merged.set(String(item.id).toUpperCase(), normalizeProduct(item));
  });
  catalog = [...merged.values()];
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

function totals(item) {
  const movements = state.movements.filter(m => m.articleId === item.id);
  let loaned = 0;
  let blocked = 0;

  for (const movement of movements) {
    if (movement.action === 'checkout') loaned += movement.quantity;
    if (movement.action === 'return') loaned -= movement.quantity;
    if (movement.action === 'defect') blocked += movement.quantity;
    if (movement.action === 'release') blocked -= movement.quantity;
  }

  loaned = Math.max(0, loaned);
  blocked = Math.max(0, blocked);

  return {
    loaned,
    blocked,
    available: Math.max(0, item.total - loaned - blocked)
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
    ['Artikelarten', catalog.length],
    ['Verfügbar', sum('available')],
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
          <span class="pill">${itemTotals.available} von ${item.total} verfügbar</span>
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
  $('#actionArticleId').value = id;
  $('#actionType').value = action;
  $('#actionTitle').textContent = item.name;
  $('#location').value = item.location;
  $('#detailDialog').close();
  $('#actionDialog').showModal();
}

async function submitMovement(event) {
  event.preventDefault();
  const movement = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    articleId: $('#actionArticleId').value,
    action: $('#actionType').value,
    quantity: Number($('#quantity').value),
    person: $('#person').value.trim(),
    project: $('#project').value.trim(),
    dueDate: $('#dueDate').value,
    location: $('#location').value.trim(),
    note: $('#note').value.trim()
  };

  const item = catalog.find(product => product.id === movement.articleId);
  const itemTotals = totals(item);
  if (!Number.isInteger(movement.quantity) || movement.quantity < 1) return toast('Bitte eine gültige Menge eingeben.');
  if (movement.action === 'checkout' && movement.quantity > itemTotals.available) return toast(`Es sind nur noch ${itemTotals.available} Stück verfügbar.`);
  if (movement.action === 'return' && movement.quantity > itemTotals.loaned) return toast(`Es sind nur ${itemTotals.loaned} Stück als ausgeliehen gebucht.`);
  if (movement.action === 'release' && movement.quantity > itemTotals.blocked) return toast(`Es sind nur ${itemTotals.blocked} Stück als defekt gebucht.`);

  const currentSettings = settings();
  if (currentSettings.cloudMode) {
    try {
      await sendCloudAction({ action: 'movement', payload: movement });
    } catch (error) {
      return toast('Nicht gespeichert: ' + error.message);
    }
  }

  state.movements.push(movement);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  $('#actionDialog').close();
  $('#actionForm').reset();
  render();
  toast(currentSettings.cloudMode ? 'Buchung gespeichert und an Google Sheets gesendet.' : 'Buchung lokal gespeichert.');
}

function openProductDialog() {
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

function loadCloudProducts(apiUrl) {
  const url = cleanApiUrl(apiUrl);
  return new Promise((resolve, reject) => {
    const callbackName = `cocomacProducts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timeout = setTimeout(() => cleanup(new Error('Zeitüberschreitung beim Laden der Produkte.')), 12000);

    function cleanup(error, products) {
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
      error ? reject(error) : resolve(Array.isArray(products) ? products : []);
    }

    window[callbackName] = response => {
      if (response?.ok === false) cleanup(new Error(response.error || 'Cloud-Fehler'));
      else cleanup(null, response?.products || []);
    };
    script.onerror = () => cleanup(new Error('Backend konnte nicht erreicht werden.'));
    script.src = `${url}?action=listProducts&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

async function testCloudConnection(apiUrl) {
  await loadCloudProducts(apiUrl);
  return true;
}

function bind() {
  $('#search').oninput = render;
  $('#actionForm').onsubmit = submitMovement;
  $('#productForm').onsubmit = submitProduct;
  $('#addProductBtn').onclick = openProductDialog;
  $('#productCategory').oninput = updateProductIdPreview;
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
