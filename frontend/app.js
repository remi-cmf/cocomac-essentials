const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const LOCAL_KEY = 'cocomac-essential-state-v1';
const SETTINGS_KEY = 'cocomac-essential-settings-v1';

let catalog = [];
let state = { movements: [] };
let deferredPrompt = null;
let html5QrCode = null;
let scannerRunning = false;
let scanResultHandled = false;

async function boot() {
  catalog = await fetch('./data/equipment.json').then(r => r.json());
  state = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{"movements":[]}');

  const params = new URLSearchParams(location.search);

  bind();
  render();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.warn('Service Worker konnte nicht registriert werden:', error);
    }
  }

  const directId = params.get('id') || params.get('item');
  if (directId) openDetail(directId);
}

function settings() {
  return JSON.parse(
    localStorage.getItem(SETTINGS_KEY) ||
    '{"cloudMode":false,"apiUrl":""}'
  );
}

function totals(item) {
  const ms = state.movements.filter(m => m.articleId === item.id);
  let loaned = 0;
  let blocked = 0;

  for (const m of ms) {
    if (m.action === 'checkout') loaned += m.quantity;
    if (m.action === 'return') loaned -= m.quantity;
    if (m.action === 'defect') blocked += m.quantity;
    if (m.action === 'release') blocked -= m.quantity;
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
  const q = $('#search').value.trim().toLowerCase();

  const items = catalog.filter(x =>
    [x.id, x.name, x.category, x.location]
      .join(' ')
      .toLowerCase()
      .includes(q)
  );

  const all = catalog.map(x => ({ ...x, ...totals(x) }));
  const sum = key => all.reduce((a, x) => a + x[key], 0);

  $('#stats').innerHTML = [
    ['Artikelarten', catalog.length],
    ['Verfügbar', sum('available')],
    ['Ausgeliehen', sum('loaned')],
    ['Defekt', sum('blocked')]
  ]
    .map(([label, value]) =>
      `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
    )
    .join('');

  $('#list').innerHTML = items.map(x => {
    const t = totals(x);

    return `
      <article class="card" data-id="${x.id}">
        <img src="./assets/images/${x.image}" alt="">
        <div class="card-body">
          <div class="meta">${x.category}</div>
          <h3>${x.name}</h3>
          <div class="meta">${x.id} · ${x.location}</div>
          <span class="pill">${t.available} von ${x.total} verfügbar</span>
        </div>
      </article>
    `;
  }).join('');

  $$('.card').forEach(card => {
    card.onclick = () => openDetail(card.dataset.id);
  });

  const s = settings();

  $('#syncBanner').textContent = s.cloudMode
    ? 'Cloud-Modus aktiv: Buchungen werden an Google Sheets übertragen.'
    : 'Testmodus: Daten werden nur auf diesem Gerät gespeichert.';

  $('#syncBanner').classList.toggle('demo', !s.cloudMode);
}

function openDetail(id) {
  const item = catalog.find(
    x => x.id.toUpperCase() === String(id).toUpperCase()
  );

  if (!item) return toast('Artikel nicht gefunden.');

  const t = totals(item);

  $('#detailContent').innerHTML = `
    <img class="hero" src="./assets/images/${item.image}">
    <div class="meta">${item.category}</div>
    <h2>${item.name}</h2>
    <p>${item.description || ''}</p>
    <div class="meta">
      ${item.id} · ${item.location} · Zustand: ${item.condition}
    </div>

    <div class="detail-grid">
      <div class="detail-stat"><b>${t.available}</b><br><small>verfügbar</small></div>
      <div class="detail-stat"><b>${t.loaned}</b><br><small>ausgeliehen</small></div>
      <div class="detail-stat"><b>${t.blocked}</b><br><small>defekt</small></div>
    </div>

    <p>
      <b>Maße:</b> ${item.dimensions || '–'}<br>
      <b>Tagespreis:</b> ${item.dailyPrice ? item.dailyPrice.toFixed(2) + ' €' : '–'}<br>
      <b>Wiederbeschaffung:</b> ${item.replacementValue ? item.replacementValue.toFixed(2) + ' €' : '–'}
      ${item.notes ? '<br><b>Notiz:</b> ' + item.notes : ''}
    </p>

    <div class="actions">
      ${
        [
          ['checkout', 'Ausleihen'],
          ['return', 'Zurückgeben'],
          ['defect', 'Defekt melden'],
          ['release', 'Wieder freigeben']
        ]
          .map(([action, label]) =>
            `<button
              data-action="${action}"
              data-id="${item.id}"
              class="${action === 'defect' ? 'danger' : ''}">
              ${label}
            </button>`
          )
          .join('')
      }
      <button type="button" class="ghost qr-button" data-qr-id="${item.id}">QR-Code anzeigen</button>
    </div>
  `;

  $$('[data-action]').forEach(button => {
    button.onclick = () =>
      openAction(button.dataset.id, button.dataset.action);
  });

  $('[data-qr-id]').onclick = () => openQr(item.id);

  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('id', item.id);
  history.replaceState({}, '', url);

  $('#detailDialog').showModal();
}


function openQr(id) {
  const item = catalog.find(x => x.id === id);
  if (!item) return toast('Artikel nicht gefunden.');

  $('#qrTitle').textContent = item.name;
  $('#qrArticleId').textContent = item.id;
  $('#qrImageWrap').innerHTML = `<img src="./assets/qr/${item.id}.png" alt="QR-Code für ${item.id}">`;

  $('#downloadQrBtn').onclick = () => downloadQr(item);
  $('#printQrBtn').onclick = () => printQr(item);

  $('#detailDialog').close();
  $('#qrDialog').showModal();
}

function downloadQr(item) {
  const link = document.createElement('a');
  link.href = `./assets/qr/${item.id}.png`;
  link.download = `${item.id}-qr.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function printQr(item) {
  const printWindow = window.open('', '_blank', 'width=520,height=700');
  if (!printWindow) return toast('Bitte Pop-ups für das Drucken erlauben.');

  printWindow.document.write(`<!doctype html>
    <html lang="de"><head><meta charset="utf-8"><title>${item.id}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:32px;color:#171716}
      .label{display:inline-block;border:1px solid #bbb;border-radius:18px;padding:24px;min-width:280px}
      small{letter-spacing:.16em;color:#666}h1{font-size:22px;margin:10px 0 4px}p{margin:0 0 16px;color:#555}
      img{width:240px;height:240px;image-rendering:pixelated}.id{font-size:20px;font-weight:800;letter-spacing:.08em;margin-top:12px}
      @media print{body{padding:0}.label{border:0}}
    </style></head><body><div class="label"><small>COCOMAC ESSENTIAL</small><h1>${item.name}</h1><p>${item.category}</p><img src="${new URL(`./assets/qr/${item.id}.png`, location.href).href}" alt="QR-Code"><div class="id">${item.id}</div></div>
    <script>window.onload=()=>{window.print();window.close()}<\/script></body></html>`);
  printWindow.document.close();
}

function openAction(id, action) {
  const item = catalog.find(x => x.id === id);

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

  const item = catalog.find(x => x.id === movement.articleId);
  const t = totals(item);

  if (!Number.isInteger(movement.quantity) || movement.quantity < 1) {
    return toast('Bitte eine gültige Menge eingeben.');
  }

  if (movement.action === 'checkout' && movement.quantity > t.available) {
    return toast(`Es sind nur noch ${t.available} Stück verfügbar.`);
  }

  if (movement.action === 'return' && movement.quantity > t.loaned) {
    return toast(`Es sind nur ${t.loaned} Stück als ausgeliehen gebucht.`);
  }

  if (movement.action === 'release' && movement.quantity > t.blocked) {
    return toast(`Es sind nur ${t.blocked} Stück als defekt gebucht.`);
  }

  const s = settings();

  if (s.cloudMode) {
    try {
      await sendMovementToCloud(movement);
    } catch (error) {
      return toast('Nicht gespeichert: ' + error.message);
    }
  }

  state.movements.push(movement);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));

  $('#actionDialog').close();
  $('#actionForm').reset();

  render();
  toast(
    s.cloudMode
      ? 'Buchung gespeichert und an Google Sheets gesendet.'
      : 'Buchung lokal gespeichert.'
  );
}

function cleanApiUrl(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/\s+/g, '');

  if (!cleaned) {
    throw new Error('Backend-URL fehlt.');
  }

  if (
    !cleaned.startsWith('https://script.google.com/macros/s/') ||
    !cleaned.endsWith('/exec')
  ) {
    throw new Error(
      'Bitte die Web-App-URL verwenden. Sie muss mit https://script.google.com/macros/s/ beginnen und mit /exec enden.'
    );
  }

  return cleaned;
}

/*
  Google Apps Script liefert bei Aufrufen aus Safari/localhost keine
  normalen CORS-Header. Deshalb wird die Anfrage im no-cors-Modus gesendet.
  Die Antwort ist für den Browser nicht lesbar, die Buchung kommt aber beim
  Apps-Script-Backend an.
*/
async function sendMovementToCloud(movement) {
  const s = settings();
  const apiUrl = cleanApiUrl(s.apiUrl);

  await fetch(apiUrl, {
    method: 'POST',
    mode: 'no-cors',
    redirect: 'follow',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify({
      action: 'movement',
      payload: movement
    })
  });

  return { ok: true };
}

/*
  Ein echter Antworttest ist wegen der CORS-Regeln von Apps Script aus
  localhost/Safari nicht zuverlässig möglich. Wir prüfen deshalb die URL
  und senden eine harmlose Anfrage. Wenn fetch nicht scheitert, speichern
  wir die Verbindung.
*/
async function testCloudConnection(apiUrl) {
  const url = cleanApiUrl(apiUrl);

  await fetch(url, {
    method: 'GET',
    mode: 'no-cors',
    cache: 'no-store',
    redirect: 'follow'
  });

  return true;
}

function bind() {
  $('#search').oninput = render;
  $('#actionForm').onsubmit = submitMovement;

  $('#settingsBtn').onclick = () => {
    const s = settings();
    $('#apiUrl').value = s.apiUrl;
    $('#cloudMode').checked = s.cloudMode;
    $('#settingsDialog').showModal();
  };

  $('#scanBtn').onclick = () => $('#scanDialog').showModal();

  $$('[data-close]').forEach(button => {
    button.onclick = () => {
      const dialog = button.closest('dialog');
      if (dialog.id === 'scanDialog') stopCameraScan();
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

    const newSettings = {
      apiUrl: $('#apiUrl').value.trim(),
      cloudMode: $('#cloudMode').checked
    };

    try {
      if (newSettings.cloudMode) {
        await testCloudConnection(newSettings.apiUrl);
      }

      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(newSettings)
      );

      render();
      $('#settingsDialog').close();

      toast(
        newSettings.cloudMode
          ? 'Verbindung gespeichert. Cloud-Modus ist aktiv.'
          : 'Testmodus ist aktiv.'
      );
    } catch (error) {
      toast('Verbindung fehlgeschlagen: ' + error.message);
    }
  };

  $('#resetDemo').onclick = () => {
    if (confirm('Lokale Buchungen wirklich löschen?')) {
      localStorage.removeItem(LOCAL_KEY);
      state = { movements: [] };
      render();
      toast('Testdaten gelöscht.');
    }
  };

  $('#manualScanForm').onsubmit = async event => {
    event.preventDefault();
    await stopCameraScan();
    $('#scanDialog').close();
    openDetail($('#manualId').value.trim());
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
    const parameterNames = [
      'id',
      'item',
      'article',
      'articleId',
      'artikel',
      'artikelId'
    ];

    for (const name of parameterNames) {
      const value = url.searchParams.get(name);
      if (value) return value.trim().toUpperCase();
    }

    const pathId = url.pathname.match(/CME-[A-Z0-9]+-\d+/i);
    if (pathId) return pathId[0].toUpperCase();
  } catch {
    // Der Inhalt ist kein vollständiger Link.
  }

  return text.toUpperCase();
}

async function startCameraScan() {
  if (scannerRunning) return;

  if (typeof window.Html5Qrcode === 'undefined') {
    setScannerStatus(
      'Der QR-Scanner konnte nicht geladen werden. Bitte prüfe die Internetverbindung und lade die Seite neu.'
    );
    return;
  }

  scanResultHandled = false;
  setScannerStatus('Kamera wird gestartet …');

  $('#cameraScanBtn')?.classList.add('hidden');
  $('#stopScannerBtn')?.classList.remove('hidden');

  try {
    html5QrCode = new window.Html5Qrcode('qrReader');

    const config = {
      fps: 10,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const size = Math.floor(
          Math.min(viewfinderWidth, viewfinderHeight) * 0.72
        );

        return {
          width: size,
          height: size
        };
      },
      aspectRatio: 1,
      disableFlip: false
    };

    await html5QrCode.start(
      { facingMode: { ideal: 'environment' } },
      config,
      async decodedText => {
        if (scanResultHandled) return;
        scanResultHandled = true;

        const id = extractArticleId(decodedText);
        setScannerStatus(`Erkannt: ${id}`);

        await stopCameraScan();
        $('#scanDialog').close();

        openDetail(id);

        window.setTimeout(() => {
          scanResultHandled = false;
        }, 1000);
      },
      () => {
        // Fehlversuche während der Suche werden nicht angezeigt.
      }
    );

    scannerRunning = true;
    setScannerStatus('Halte den QR-Code in den markierten Bereich.');
  } catch (error) {
    console.error('Kamera konnte nicht gestartet werden:', error);

    scannerRunning = false;
    $('#cameraScanBtn')?.classList.remove('hidden');
    $('#stopScannerBtn')?.classList.add('hidden');

    const errorText = String(error || '').toLowerCase();

    if (
      error?.name === 'NotAllowedError' ||
      errorText.includes('permission') ||
      errorText.includes('notallowed')
    ) {
      setScannerStatus(
        'Der Kamerazugriff wurde nicht erlaubt. Erlaube die Kamera in den Browser-Einstellungen.'
      );
    } else if (
      error?.name === 'NotFoundError' ||
      errorText.includes('notfound')
    ) {
      setScannerStatus('Auf diesem Gerät wurde keine Kamera gefunden.');
    } else if (!window.isSecureContext) {
      setScannerStatus(
        'Der Scanner benötigt eine sichere HTTPS-Verbindung.'
      );
    } else {
      setScannerStatus(
        'Die Kamera konnte nicht gestartet werden. Lade die Seite neu und versuche es noch einmal.'
      );
    }

    try {
      await html5QrCode?.clear();
    } catch {
      // Kein weiterer Schritt erforderlich.
    }

    html5QrCode = null;
  }
}

async function stopCameraScan() {
  if (html5QrCode) {
    try {
      if (scannerRunning) {
        await html5QrCode.stop();
      }
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

function toast(message) {
  const element = $('#toast');

  element.textContent = message;
  element.classList.remove('hidden');

  setTimeout(() => {
    element.classList.add('hidden');
  }, 3500);
}

boot();    '{"cloudMode":false,"apiUrl":""}'
