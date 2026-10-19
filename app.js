const DEFAULT_ROOMS = [
  ["001", "Ruang Kalak BPBD"], ["002", "Ruang Sekre BPBD"], ["003", "Ruang Kasi PK BPBD"],
  ["004", "Ruang Kasi Darlog BPBD"], ["005", "Ruang Kasi RR BPBD"], ["006", "Ruang Pusdalop PB BPBD"],
  ["007", "Ruang Barak TRC PB BPBD"], ["008", "Ruang Aula BPBD"], ["009", "Ruang Bendahara BPBD"],
  ["010", "Ruang Rapat"], ["011", "Ruang DWP"], ["012", "Ruang Arsip"], ["013", "Ruang Penyimpanan Rescue"]
].map(([code, name]) => ({ opdCode: "08.00.000", opdName: "BADAN PENANGGULANGAN BENCANA DAERAH", code, name, active: true }));
const KIB_LABELS = {
  A: "Tanah", B: "Peralatan dan Mesin", EC: "Peralatan dan Mesin", G: "Peralatan dan Mesin",
  C: "Gedung/Bangunan", D: "Jalan, Irigasi, Jaringan", E: "Aset Tetap Lainnya", F: "Konstruksi dalam Pengerjaan"
};
const DB_NAME = "bpbd-inventaris-aset-v1";
const DB_VERSION = 3;
let assets = [];
let rooms = [];
let itemReferences = [];
let db;
let activeAssetId = null;
let selectedFiles = [];
let selectedReferenceFiles = [];
let toastTimer;
const STORAGE_CONFIG = window.APP_CONFIG || {};
const SUPABASE_URL = String(STORAGE_CONFIG.supabaseUrl || "").replace(/\/$/, "");
const SUPABASE_KEY = STORAGE_CONFIG.supabasePublishableKey || "";
const CLOUD_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);
const CLOUD_STORES = {
  assets: { table: "bmd_assets", key: "id" },
  rooms: { table: "bmd_rooms", key: "key" },
  itemReferences: { table: "bmd_item_references", key: "code" }
};
let cloudStatus = "local";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
const normal = value => String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const roomKey = room => `${room.opdCode}|${room.code}`;
const formatNumber = value => new Intl.NumberFormat("id-ID").format(Number(value) || 0);
const opdLabel = item => {
  if (item.opdName || item.skpdName) return item.opdName || item.skpdName;
  const parsed = parseOpd("", "", item.skpd || "");
  return parsed.opdName || item.skpd || item.opdCode || "OPD belum terdata";
};
const opdCode = item => item.opdCode || item.skpdCode || parseOpd("", "", item.skpd || "").opdCode || "";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("assets")) database.createObjectStore("assets", { keyPath: "id" });
      if (!database.objectStoreNames.contains("rooms")) database.createObjectStore("rooms", { keyPath: "key" });
      if (!database.objectStoreNames.contains("itemReferences")) database.createObjectStore("itemReferences", { keyPath: "code" });
    };
    request.onblocked = () => showToast("Tutup tab aplikasi lama lalu muat ulang untuk menambahkan referensi kode barang.");
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
}
function storeRequest(storeName, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    callback(store, resolve, reject);
    tx.onerror = () => reject(tx.error);
  });
}
function listLocalStore(storeName) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
function setStorageStatus(status, detail = "") {
  cloudStatus = status;
  const title = $("#storageTitle");
  const description = $("#storageDescription");
  const dot = $("#storageDot");
  if (!title || !description || !dot) return;
  if (status === "connected") {
    title.textContent = "Supabase aktif";
    description.textContent = "Data tersimpan bersama di cloud";
    dot.style.background = "#40a875";
  } else if (status === "error") {
    title.textContent = "Cloud belum tersambung";
    description.textContent = detail || "Periksa URL, key, dan kebijakan SQL";
    dot.style.background = "#c78639";
  } else {
    title.textContent = "Penyimpanan lokal";
    description.textContent = "Tambahkan konfigurasi Supabase untuk berbagi data";
    dot.style.background = "#40a875";
  }
}
function cloudHeaders(prefer = "") {
  return { apikey: SUPABASE_KEY, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) };
}
function cloudRows(storeName, items) {
  const config = CLOUD_STORES[storeName];
  return items.map(item => ({ [config.key]: item[config.key], payload: item, updated_at: new Date(item.updatedAt || item.importedAt || Date.now()).toISOString() }));
}
async function cloudRequest(storeName, method, items = []) {
  const config = CLOUD_STORES[storeName];
  const url = `${SUPABASE_URL}/rest/v1/${config.table}`;
  const query = method === "GET" ? `?select=${config.key},payload,updated_at}` : `?on_conflict=${config.key}`;
  const response = await fetch(`${url}${query}`, {
    method,
    headers: cloudHeaders(method === "GET" ? "" : "resolution=merge-duplicates,return=minimal"),
    ...(method === "GET" ? {} : { body: JSON.stringify(cloudRows(storeName, items)) })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return method === "GET" ? response.json() : null;
}
async function listStore(storeName) {
  if (!CLOUD_ENABLED || !CLOUD_STORES[storeName] || cloudStatus === "error") return listLocalStore(storeName);
  try {
    const rows = await cloudRequest(storeName, "GET");
    setStorageStatus("connected");
    return rows.map(row => row.payload || { [CLOUD_STORES[storeName].key]: row[CLOUD_STORES[storeName].key] });
  } catch (error) {
    setStorageStatus("error", "Data sementara dibaca dari perangkat ini");
    return listLocalStore(storeName);
  }
}
async function syncCloudOnStart() {
  if (!CLOUD_ENABLED) { setStorageStatus("local"); return; }
  try {
    for (const storeName of Object.keys(CLOUD_STORES)) {
      const config = CLOUD_STORES[storeName];
      const localItems = await listLocalStore(storeName);
      const remoteRows = await cloudRequest(storeName, "GET");
      const remoteByKey = new Map(remoteRows.map(row => [String(row[config.key]), row]));
      if (!remoteRows.length && localItems.length) {
        await cloudRequest(storeName, "POST", localItems);
        continue;
      }
      const newerLocal = localItems.filter(item => {
        const remote = remoteByKey.get(String(item[config.key]));
        const localAt = Number(item.updatedAt || item.importedAt || 0);
        return !remote || localAt > (Date.parse(remote.updated_at || "") || 0);
      });
      if (newerLocal.length) await cloudRequest(storeName, "POST", newerLocal);
      const refreshedRows = newerLocal.length ? await cloudRequest(storeName, "GET") : remoteRows;
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      refreshedRows.forEach(row => store.put(row.payload || { [config.key]: row[config.key] }));
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
    setStorageStatus("connected");
  } catch (error) {
    setStorageStatus("error", "Periksa URL, key, dan kebijakan SQL Supabase");
  }
}
function putOne(storeName, item) {
  return storeRequest(storeName, "readwrite", (store, resolve) => {
    const tx = store.transaction;
    store.put(item);
    tx.oncomplete = async () => {
      if (CLOUD_ENABLED && CLOUD_STORES[storeName]) {
        try { await cloudRequest(storeName, "POST", [item]); setStorageStatus("connected"); }
        catch (error) { setStorageStatus("error", "Tersimpan di perangkat; sinkronisasi gagal"); }
      }
      resolve(item);
    };
  });
}
function putMany(storeName, items) {
  return storeRequest(storeName, "readwrite", (store, resolve) => {
    const tx = store.transaction;
    items.forEach(item => store.put(item));
    tx.oncomplete = async () => {
      if (CLOUD_ENABLED && CLOUD_STORES[storeName] && items.length) {
        try { await cloudRequest(storeName, "POST", items); setStorageStatus("connected"); }
        catch (error) { setStorageStatus("error", "Tersimpan di perangkat; sinkronisasi gagal"); }
      }
      resolve(items.length);
    };
  });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3300);
}
function setView(view) {
  const views = { overview: "Ringkasan", kib: "Data KIB", assets: "Inventarisasi", rooms: "Ruangan", references: "Referensi Kode Barang", recommendations: "Rekomendasi" };
  Object.keys(views).forEach(key => $(`#${key}View`)?.classList.toggle("hidden", key !== view));
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $("#crumb").textContent = view === "kib" && $("#kibTypeFilter").value ? `Data KIB · KIB ${$("#kibTypeFilter").value} ${KIB_LABELS[$("#kibTypeFilter").value] || ""}` : views[view] || "Ringkasan";
  if (view === "kib") renderKibTable();
  if (view === "assets") renderAssetTable();
  if (view === "rooms") renderRoomList();
  if (view === "references") renderReferenceTable();
  if (view === "recommendations") renderRecommendations();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function conditionLabel(value) {
  const key = normal(value);
  if (["b", "baik"].includes(key)) return "Baik";
  if (["kb", "kurang baik"].includes(key)) return "Kurang Baik";
  if (["rr", "rusak ringan"].includes(key)) return "Rusak Ringan";
  if (["rb", "rusak berat"].includes(key)) return "Rusak Berat";
  return value || "Belum dicatat";
}
function conditionTag(value) {
  const key = normal(value);
  if (key === "baik") return "tag good";
  if (key === "kurang baik") return "tag warn";
  if (key === "rusak ringan") return "tag warn";
  if (key === "rusak berat") return "tag bad";
  return "tag";
}
function statusTag(value) {
  if (value === "Sesuai") return "tag good";
  if (value === "Dipindahkan") return "tag blue-tag";
  if (value === "Tidak ditemukan") return "tag bad";
  return "tag";
}
function parseOpd(rawCode, rawName, legacySkpd) {
  let code = String(rawCode || "").trim();
  let name = String(rawName || "").trim();
  if (!code && legacySkpd) {
    const match = String(legacySkpd).trim().match(/^([\d.]+)\s*[-–:]\s*(.*)$/);
    if (match) { code = match[1].trim(); name = name || match[2].trim(); }
    else name = name || String(legacySkpd).trim();
  }
  return { opdCode: code, opdName: name };
}
function roomForAsset(asset) {
  const code = asset.roomCode || asset.room || "";
  return rooms.find(room => (asset.roomKey && roomKey(room) === asset.roomKey) || (room.code === code && room.opdCode === opdCode(asset))) || null;
}
function assetRoomName(asset) { return roomForAsset(asset)?.name || asset.roomName || "Belum dipilih"; }
function getOpds() {
  const map = new Map();
  [...assets, ...rooms].forEach(item => {
    const code = opdCode(item);
    if (!code) return;
    const key = code;
    if (!map.has(key)) map.set(key, { code, name: opdLabel(item) });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
}
function renderOpdFilters() {
  const selectors = ["#kibOpdFilter", "#inventoryOpdFilter", "#roomOpdFilter", "#recommendationOpdFilter"];
  const options = getOpds();
  selectors.forEach(selector => {
    const select = $(selector);
    if (!select) return;
    const chosen = select.value;
    select.innerHTML = '<option value="">Semua OPD</option>' + options.map(opd => `<option value="${escapeHtml(opd.code)}">${escapeHtml(opd.name)}${opd.code ? ` · ${escapeHtml(opd.code)}` : ""}</option>`).join("");
    select.value = chosen;
  });
}
function renderAll() {
  renderOpdFilters();
  renderMetrics();
  renderRecent();
  renderRoomSummary();
  renderRoomFilter();
  renderRoomList();
  renderKibTable();
  renderAssetTable();
  renderRecommendations();
  renderReferenceTable();
  $("#navAssetCount").textContent = formatNumber(assets.length);
  $("#recommendationCount").textContent = formatNumber(getRecommendations().length);
  $("#referenceCount").textContent = formatNumber(itemReferences.length);
}
function renderMetrics() {
  const total = assets.length;
  const checked = assets.filter(asset => asset.inventoryStatus && asset.inventoryStatus !== "Belum diperiksa").length;
  const follow = assets.filter(asset => asset.inventoryStatus === "Tidak ditemukan" || asset.conditionCurrent === "Rusak Ringan" || asset.conditionCurrent === "Rusak Berat").length;
  const barcodePending = assets.filter(asset => !asset.barcodeKib || !asset.barcodeKir).length;
  $("#totalMetric").textContent = formatNumber(total);
  $("#checkedMetric").textContent = formatNumber(checked);
  $("#checkedNote").textContent = `${total ? Math.round(checked / total * 100) : 0}% dari total aset`;
  $("#followMetric").textContent = formatNumber(follow);
  $("#barcodeMetric").textContent = formatNumber(barcodePending);
}
function assetTitle(asset) { return asset.name || "Aset tanpa nama"; }
function assetIcon(asset) { return asset.kibType === "B" || asset.kibType === "EC" || asset.kibType === "G" ? "▣" : asset.kibType === "A" ? "⌂" : asset.kibType === "C" || asset.kibType === "F" ? "▥" : asset.kibType === "D" ? "═" : "▤"; }
function renderRecent() {
  const tbody = $("#recentRows");
  const latest = [...assets].sort((a, b) => (b.updatedAt || b.importedAt || 0) - (a.updatedAt || a.importedAt || 0)).slice(0, 5);
  $("#recentEmpty").classList.toggle("hidden", latest.length > 0);
  tbody.innerHTML = latest.map(asset => `<tr data-id="${escapeHtml(asset.id)}"><td><div class="asset-name"><span class="asset-avatar">${assetIcon(asset)}</span><span><b>${escapeHtml(assetTitle(asset))}</b><small>${escapeHtml(asset.nibar || "NIBAR belum ada")}</small></span></div></td><td class="code-cell">${escapeHtml(asset.currentCode || asset.sourceCode || "—")}</td><td>${escapeHtml(assetRoomName(asset))}</td><td><span class="${conditionTag(asset.conditionCurrent)}">${escapeHtml(conditionLabel(asset.conditionCurrent))}</span></td><td><span class="${statusTag(asset.inventoryStatus)}">${escapeHtml(asset.inventoryStatus || "Belum diperiksa")}</span></td></tr>`).join("");
  $$("#recentRows tr").forEach(row => row.addEventListener("click", () => openAsset(row.dataset.id)));
}
function renderRoomSummary() {
  const container = $("#roomSummary");
  const counts = rooms.filter(room => room.active).map(room => ({ ...room, count: assets.filter(asset => roomForAsset(asset) && roomKey(roomForAsset(asset)) === roomKey(room)).length })).filter(room => room.count > 0).sort((a, b) => b.count - a.count);
  if (!counts.length) { container.innerHTML = '<div class="room-no-data">Belum ada aset ditempatkan pada ruangan.</div>'; return; }
  const max = Math.max(...counts.map(room => room.count));
  container.innerHTML = counts.slice(0, 6).map(room => `<div class="room-sum-row"><span class="room-sum-name" title="${escapeHtml(room.opdName)} · ${escapeHtml(room.name)}">${escapeHtml(room.name)} <small>${escapeHtml(room.opdCode)}</small></span><div class="room-track"><div class="room-fill" style="width:${Math.max(5, room.count / max * 100)}%"></div></div><span class="room-sum-count">${room.count}</span></div>`).join("");
}
function renderRoomFilter() {
  const select = $("#roomFilter");
  if (!select) return;
  const chosen = select.value;
  const active = rooms.filter(room => room.active);
  select.innerHTML = '<option value="">Semua ruangan</option>' + active.map(room => `<option value="${escapeHtml(roomKey(room))}">${escapeHtml(room.name)} · ${escapeHtml(room.opdCode)}</option>`).join("");
  select.value = chosen;
}
function renderRoomList() {
  const filter = $("#roomOpdFilter")?.value || "";
  const visible = rooms.filter(room => room.active && (!filter || room.opdCode === filter)).sort((a, b) => a.opdName.localeCompare(b.opdName, "id") || a.name.localeCompare(b.name, "id"));
  $("#activeRoomCount").textContent = `${formatNumber(visible.length)} AKTIF`;
  $("#roomCountLabel").textContent = `${visible.length} ruangan`;
  $("#roomEmpty").classList.toggle("hidden", visible.length > 0);
  $("#roomList").innerHTML = visible.map(room => {
    const count = assets.filter(asset => { const assigned = roomForAsset(asset); return assigned && roomKey(assigned) === roomKey(room); }).length;
    return `<div class="room-list-item"><span class="room-code">${escapeHtml(room.code)}</span><span><b>${escapeHtml(room.name)}</b><small>${escapeHtml(room.opdName)} · ${escapeHtml(room.opdCode)} · ${count} aset</small></span></div>`;
  }).join("");
  renderRoomFilter();
}
function filteredAssets(view = "inventory") {
  const kibView = view === "kib";
  const query = normal($(kibView ? "#kibSearchInput" : "#searchInput")?.value || "");
  const type = $(kibView ? "#kibTypeFilter" : "#typeFilter")?.value || "";
  const room = kibView ? "" : $("#roomFilter").value;
  const status = kibView ? "" : $("#statusFilter").value;
  const opd = $(kibView ? "#kibOpdFilter" : "#inventoryOpdFilter")?.value || "";
  return assets.filter(asset => {
    const searchable = normal([asset.name, asset.nibar, asset.idCode, asset.sourceCode, asset.currentCode, asset.merk, asset.pemakai, asset.specsCurrent, asset.opdName, asset.opdCode].join(" "));
    const assetRoom = roomForAsset(asset);
    return (!query || searchable.includes(query)) && (!type || asset.kibType === type) && (!room || (assetRoom && roomKey(assetRoom) === room)) && (!status || (asset.inventoryStatus || "Belum diperiksa") === status) && (!opd || opdCode(asset) === opd);
  }).sort((a, b) => assetTitle(a).localeCompare(assetTitle(b), "id"));
}
function barcodeDisplay(value) {
  if (!value) return '<span class="tag">Belum dicatat</span>';
  return value === "Tersedia" ? '<span class="tag good">Tersedia</span>' : '<span class="tag bad">Tidak</span>';
}
function renderKibTable() {
  const tbody = $("#kibRows");
  if (!tbody) return;
  const result = filteredAssets("kib");
  tbody.innerHTML = result.map(asset => `<tr><td><div class="asset-name"><span class="asset-avatar">${assetIcon(asset)}</span><span><b>${escapeHtml(assetTitle(asset))}</b><small>${escapeHtml(asset.nibar || "NIBAR belum ada")}</small></span></div></td><td><div class="opd-cell"><b>${escapeHtml(opdLabel(asset))}</b><small>${escapeHtml(opdCode(asset))}</small></div></td><td><span class="tag blue-tag">KIB ${escapeHtml(asset.kibType)}</span></td><td class="code-cell">${escapeHtml(asset.sourceCode || "—")}</td><td class="code-cell">${escapeHtml(asset.register || "—")}</td><td>${escapeHtml(asset.idCode || "—")}</td><td>${escapeHtml(asset.pemakai || "—")}</td><td>${escapeHtml(asset.quantity || "—")}</td><td>${escapeHtml(asset.price ? formatNumber(asset.price) : "—")}</td><td><button class="row-action" data-kib-open="${escapeHtml(asset.id)}">Rincian</button></td></tr>`).join("");
  $("#kibEmpty").classList.toggle("hidden", result.length > 0);
  $("#kibEmptyTitle").textContent = assets.length ? "Data tidak ditemukan" : "Belum ada data KIB";
  $("#kibResultCount").textContent = `${formatNumber(result.length)} dari ${formatNumber(assets.length)} aset`;
  $$('[data-kib-open]', tbody).forEach(button => button.addEventListener("click", () => openAsset(button.dataset.kibOpen)));
}
function renderAssetTable() {
  const tbody = $("#assetRows");
  if (!tbody) return;
  const result = filteredAssets("inventory");
  tbody.innerHTML = result.map(asset => `<tr><td><div class="asset-name"><span class="asset-avatar">${assetIcon(asset)}</span><span><b>${escapeHtml(assetTitle(asset))}</b><small>${escapeHtml(asset.nibar || "NIBAR belum ada")}</small></span></div></td><td><span class="tag blue-tag">KIB ${escapeHtml(asset.kibType)}</span></td><td class="code-cell">${escapeHtml(asset.currentCode || asset.sourceCode || "—")}</td><td><div class="opd-cell"><b>${escapeHtml(assetRoomName(asset))}</b><small>${escapeHtml(opdCode(asset))}</small></div></td><td><span class="${conditionTag(asset.conditionCurrent)}">${escapeHtml(conditionLabel(asset.conditionCurrent))}</span></td><td>${barcodeDisplay(asset.barcodeKib)}</td><td>${barcodeDisplay(asset.barcodeKir)}</td><td><span class="${statusTag(asset.inventoryStatus)}">${escapeHtml(asset.inventoryStatus || "Belum diperiksa")}</span></td><td><button class="row-action" data-edit="${escapeHtml(asset.id)}">Buka</button></td></tr>`).join("");
  $("#assetEmpty").classList.toggle("hidden", result.length > 0);
  $("#assetEmptyTitle").textContent = assets.length ? "Aset tidak ditemukan" : "Belum ada data aset";
  $("#assetEmptyDesc").textContent = assets.length ? "Coba ubah kata kunci atau filter." : "Impor file KIB untuk memulai inventarisasi.";
  $("#resultCount").textContent = `${formatNumber(result.length)} dari ${formatNumber(assets.length)} aset`;
  $$('[data-edit]', tbody).forEach(button => button.addEventListener("click", () => openAsset(button.dataset.edit)));
}

function recommendationRows() {
  const rows = [];
  for (const asset of assets) {
    const currentCondition = conditionLabel(asset.conditionCurrent);
    const kibCondition = conditionLabel(asset.conditionSource);
    if (currentCondition === "Rusak Berat" && kibCondition !== "Rusak Berat") {
      rows.push({ asset, type: "Reklasifikasi ke RB", reason: kibCondition === "Belum dicatat" ? "Kondisi fisik tercatat Rusak Berat; kondisi pada KIB belum mencatat Rusak Berat." : `Kondisi fisik Rusak Berat berbeda dari catatan KIB (${kibCondition}).` });
    }
    if (asset.inventoryStatus === "Tidak ditemukan") rows.push({ asset, type: "Telusuri aset tidak ditemukan", reason: "Aset tidak ditemukan saat pemeriksaan fisik." });
    if (currentCondition === "Rusak Ringan") rows.push({ asset, type: "Tindak lanjut kerusakan ringan", reason: "Aset tercatat Rusak Ringan; tentukan pemeliharaan atau pemantauan." });
    if (!asset.barcodeKib || !asset.barcodeKir || asset.barcodeKib === "Tidak tersedia" || asset.barcodeKir === "Tidak tersedia") {
      const missing = [!asset.barcodeKib || asset.barcodeKib === "Tidak tersedia" ? "KIB" : "", !asset.barcodeKir || asset.barcodeKir === "Tidak tersedia" ? "KIR" : ""].filter(Boolean).join(" dan ");
      rows.push({ asset, type: "Lengkapi barcode", reason: `Barcode ${missing} belum tersedia atau belum dicatat.` });
    }
    if (!asset.inventoryStatus || asset.inventoryStatus === "Belum diperiksa") rows.push({ asset, type: "Selesaikan inventarisasi", reason: "Hasil pemeriksaan fisik belum dicatat." });
  }
  return rows;
}
function getRecommendations() {
  const opd = $("#recommendationOpdFilter")?.value || "";
  const type = $("#recommendationTypeFilter")?.value || "";
  const query = normal($("#recommendationSearch")?.value || "");
  return recommendationRows().filter(row => {
    const asset = row.asset;
    const searchable = normal([asset.name, asset.nibar, asset.sourceCode, asset.currentCode, asset.idCode, asset.opdName, row.reason].join(" "));
    return (!opd || opdCode(asset) === opd) && (!type || row.type === type) && (!query || searchable.includes(query));
  }).sort((a, b) => a.type.localeCompare(b.type, "id") || assetTitle(a.asset).localeCompare(assetTitle(b.asset), "id"));
}
function renderRecommendations() {
  const select = $("#recommendationTypeFilter");
  if (!select) return;
  const selectedType = select.value;
  const all = recommendationRows();
  const types = [...new Set(all.map(row => row.type))].sort((a, b) => a.localeCompare(b, "id"));
  select.innerHTML = '<option value="">Semua rekomendasi</option>' + types.map(type => `<option>${escapeHtml(type)}</option>`).join("");
  select.value = selectedType;
  const result = getRecommendations();
  const counts = new Map();
  all.forEach(row => counts.set(row.type, (counts.get(row.type) || 0) + 1));
  $("#recommendationSummary").innerHTML = types.length ? types.map(type => `<button class="recommendation-chip ${selectedType === type ? "selected" : ""}" data-rec="${escapeHtml(type)}"><b>${formatNumber(counts.get(type))}</b><span>${escapeHtml(type)}</span></button>`).join("") : '<div class="no-recommendations">Belum ada rekomendasi. Hasil akan muncul setelah kondisi dan status pemeriksaan dicatat.</div>';
  $$("[data-rec]").forEach(button => button.addEventListener("click", () => { $("#recommendationTypeFilter").value = button.dataset.rec; renderRecommendations(); }));
  $("#recommendationRows").innerHTML = result.map(({ asset, type, reason }) => `<tr><td><span class="tag warn">${escapeHtml(type)}</span></td><td><div class="asset-name"><span class="asset-avatar">${assetIcon(asset)}</span><span><b>${escapeHtml(assetTitle(asset))}</b><small>${escapeHtml(asset.nibar || "NIBAR belum ada")}</small></span></div></td><td><div class="opd-cell"><b>${escapeHtml(opdLabel(asset))}</b><small>${escapeHtml(opdCode(asset))}</small></div></td><td>${escapeHtml(assetRoomName(asset))}</td><td><span class="${conditionTag(asset.conditionSource)}">${escapeHtml(conditionLabel(asset.conditionSource))}</span></td><td><span class="${conditionTag(asset.conditionCurrent)}">${escapeHtml(conditionLabel(asset.conditionCurrent))}</span></td><td class="reason-cell">${escapeHtml(reason)}</td><td><button class="row-action" data-edit="${escapeHtml(asset.id)}">Buka</button></td></tr>`).join("");
  $("#recommendationEmpty").classList.toggle("hidden", result.length > 0);
  $("#recommendationResultCount").textContent = `${formatNumber(result.length)} objek rekomendasi`;
  $("#recommendationCount").textContent = formatNumber(all.length);
  $$('[data-edit]', $("#recommendationRows")).forEach(button => button.addEventListener("click", () => openAsset(button.dataset.edit)));
}

function referenceType(value) {
  const text = String(value || "").trim().toUpperCase().replace(/^KIB\s*/, "");
  return ["A", "B", "EC", "G", "C", "D", "E", "F"].includes(text) ? text : String(value || "").trim();
}
function referenceHeaderIndex(header, choices) {
  return header.findIndex(value => choices.includes(normal(value)));
}
function parseReferenceSheet(rows, fileName, sheetName) {
  const headerAt = rows.findIndex(row => {
    const labels = row.map(normal);
    const hasCode = labels.some(label => ["kode barang", "kode"].includes(label));
    const hasName = labels.some(label => ["nama barang", "uraian", "nama barang uraian", "nama barang atau uraian", "nama barang uraian barang"].includes(label));
    return hasCode && hasName;
  });
  if (headerAt < 0) return [];
  const header = rows[headerAt] || [];
  const codeAt = referenceHeaderIndex(header, ["kode barang", "kode"]);
  const nameAt = referenceHeaderIndex(header, ["nama barang uraian", "nama barang atau uraian", "nama barang", "uraian", "nama barang uraian barang"]);
  const typeAt = referenceHeaderIndex(header, ["jenis kib", "kib", "jenis aset"]);
  const unitAt = referenceHeaderIndex(header, ["satuan", "unit"]);
  const noteAt = referenceHeaderIndex(header, ["keterangan", "catatan", "deskripsi"]);
  return rows.slice(headerAt + 1).map(row => {
    const code = String(row[codeAt] ?? "").trim();
    const name = String(row[nameAt] ?? "").trim();
    if (!code || !name) return null;
    return { code, name, type: typeAt >= 0 ? referenceType(row[typeAt]) : "", unit: unitAt >= 0 ? String(row[unitAt] ?? "").trim() : "", note: noteAt >= 0 ? String(row[noteAt] ?? "").trim() : "", sourceFile: fileName, sourceSheet: sheetName, updatedAt: Date.now() };
  }).filter(Boolean);
}
function parseReferenceWorkbook(workbook, fileName) {
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const parsed = parseReferenceSheet(rows, fileName, sheetName);
    if (parsed.length) return parsed;
  }
  throw new Error(`${fileName}: kolom Kode Barang dan Nama Barang/Uraian tidak ditemukan.`);
}
function renderReferenceTable() {
  const tbody = $("#referenceRows");
  if (!tbody) return;
  const query = normal($("#referenceSearch")?.value || "");
  const type = $("#referenceTypeFilter")?.value || "";
  const rows = itemReferences.filter(item => (!type || item.type === type) && (!query || normal([item.code, item.name, item.type, item.unit, item.note].join(" ")).includes(query)))
    .sort((a, b) => a.code.localeCompare(b.code, "id", { numeric: true, sensitivity: "base" }));
  tbody.innerHTML = rows.map(item => `<tr><td class="code-cell">${escapeHtml(item.code)}</td><td><b class="reference-name">${escapeHtml(item.name)}</b>${item.note ? `<small class="reference-note">${escapeHtml(item.note)}</small>` : ""}</td><td>${item.type ? `KIB ${escapeHtml(item.type)}` : "Semua KIB"}</td><td>${escapeHtml(item.unit || "—")}</td></tr>`).join("");
  $("#referenceEmpty").classList.toggle("hidden", rows.length > 0);
  $("#referenceCountLabel").textContent = `${formatNumber(rows.length)} dari ${formatNumber(itemReferences.length)} referensi`;
  $("#referenceResultCount").textContent = `${formatNumber(rows.length)} referensi kode barang`;
  $("#referenceCount").textContent = formatNumber(itemReferences.length);
}
function updateReferenceSelection(files) {
  selectedReferenceFiles = [...files];
  $("#selectedReferenceFiles").textContent = selectedReferenceFiles.length ? selectedReferenceFiles.map(file => file.name).join(" · ") : "Belum ada file dipilih.";
  $("#startReferenceImport").disabled = !selectedReferenceFiles.length;
}
async function importSelectedReferences() {
  if (!selectedReferenceFiles.length) return;
  const imported = new Map(itemReferences.map(item => [normal(item.code), item]));
  let loaded = 0;
  const errors = [];
  for (const file of selectedReferenceFiles) {
    try {
      const workbook = await readWorkbook(file);
      for (const item of parseReferenceWorkbook(workbook, file.name)) { imported.set(normal(item.code), item); loaded += 1; }
    } catch (error) { errors.push(error.message); }
  }
  if (!loaded) { showToast(errors[0] || "Tidak ada baris referensi yang bisa diimpor."); return; }
  itemReferences = [...imported.values()];
  await putMany("itemReferences", itemReferences);
  $("#referenceImportDialog").close();
  updateReferenceSelection([]); $("#referenceFiles").value = ""; renderAll();
  showToast(`${formatNumber(loaded)} baris kode barang diproses${errors.length ? `; ${errors.length} file gagal` : ""}.`);
}

function openAsset(id) {
  const asset = assets.find(item => item.id === id);
  if (!asset) return;
  activeAssetId = id;
  const form = $("#assetForm");
  form.elements.currentCode.value = asset.currentCode ?? asset.sourceCode ?? "";
  const assetRooms = rooms.filter(room => room.active && room.opdCode === opdCode(asset));
  form.elements.room.innerHTML = '<option value="">Pilih ruangan</option>' + assetRooms.map(room => `<option value="${escapeHtml(roomKey(room))}">${escapeHtml(room.code)} · ${escapeHtml(room.name)}</option>`).join("");
  const linkedRoom = roomForAsset(asset);
  form.elements.room.value = linkedRoom ? roomKey(linkedRoom) : "";
  form.elements.inventoryStatus.value = asset.inventoryStatus || "Belum diperiksa";
  form.elements.conditionCurrent.value = asset.conditionCurrent || "";
  form.elements.barcodeKib.value = asset.barcodeKib || "";
  form.elements.barcodeKir.value = asset.barcodeKir || "";
  form.elements.specsCurrent.value = asset.specsCurrent || "";
  form.elements.notes.value = asset.notes || "";
  form.elements.photo.value = "";
  $("#dialogTitle").textContent = assetTitle(asset);
  $("#dialogSubtitle").textContent = `${opdLabel(asset)} · KIB ${asset.kibType} · NIBAR ${asset.nibar || "belum tersedia"}`;
  const details = (asset.sourceDetails || []).filter(detail => !["no", "rincian"].includes(normal(detail.label))).slice(0, 14);
  const detailsHtml = details.length ? `<div class="source-detail-list">${details.map(detail => `<span><small>${escapeHtml(detail.label)}</small><b>${escapeHtml(detail.value)}</b></span>`).join("")}</div>` : "";
  $("#sourceSummary").innerHTML = `<b>Data KIB ${escapeHtml(asset.kibType)} · ${escapeHtml(KIB_LABELS[asset.kibType] || "")}</b><br>OPD: ${escapeHtml(opdLabel(asset))} (${escapeHtml(opdCode(asset))})<br>Kode awal: ${escapeHtml(asset.sourceCode || "—")} · ID: ${escapeHtml(asset.idCode || "—")}<br>Kondisi KIB: ${escapeHtml(conditionLabel(asset.conditionSource))}<br>Spesifikasi sumber: ${escapeHtml(asset.specsSource || "Belum ada spesifikasi")}${asset.pemakai ? `<br>Pemakai: ${escapeHtml(asset.pemakai)}` : ""}${detailsHtml}${!assetRooms.length ? "<br><em>Master ruangan untuk OPD ini belum diunggah.</em>" : ""}`;
  $("#photoPreview").innerHTML = asset.photoData ? `<img src="${asset.photoData}" alt="Foto aset">` : "";
  $("#assetDialog").showModal();
}

function detectType(filename) {
  const name = normal(filename).replace(/\s+/g, " ");
  if (/\bkib ec\b|\bkib extracomptable\b/.test(name)) return "EC";
  for (const type of ["A", "B", "C", "D", "E", "F", "G"]) if (new RegExp(`\\bkib ${type.toLowerCase()}\\b`).test(name)) return type;
  return "";
}
function findHeaderRow(rows, fields) {
  return rows.slice(0, 15).findIndex(row => {
    const labels = row.map(normal);
    const hasNibar = labels.some(label => label === "nibar");
    const hasCode = labels.some(label => label === "kode barang");
    const hasSkpd = labels.some(label => label === "skpd" || label === "kode skpd");
    const hasRoomName = labels.some(label => label === "uraian" || label.includes("nama ruangan"));
    return fields === "rooms" ? hasSkpd && hasRoomName : hasNibar && (hasSkpd || hasCode);
  });
}
function colByLabel(rows, matchers) {
  for (const row of rows.slice(0, 15)) {
    for (let index = 0; index < row.length; index++) {
      const label = normal(row[index]);
      if (label && matchers.some(matcher => matcher(label))) return index;
    }
  }
  return -1;
}
function get(row, index) { return index >= 0 ? row[index] ?? "" : ""; }
function makeSpecs(row, cols) {
  const parts = [get(row, cols.merk), get(row, cols.size), get(row, cols.bahan), get(row, cols.serial), get(row, cols.rangka), get(row, cols.mesin), get(row, cols.polisi), get(row, cols.bpkb), get(row, cols.warna)];
  return [...new Set(parts.map(value => String(value || "").trim()).filter(value => value && !/^null\s*\/\s*null/i.test(value) && value !== "-"))].join(" · ");
}
function sourceDetailFields(rows, headerAt, row, ignoredColumns, type) {
  const primary = rows[headerAt] || [];
  const secondary = rows[headerAt + 1] || [];
  const details = [];
  const width = Math.max(primary.length, secondary.length, row.length);
  for (let index = 0; index < width; index++) {
    if (ignoredColumns.has(index)) continue;
    const value = String(row[index] ?? "").trim();
    if (!value || value === "-") continue;
    const top = String(primary[index] ?? "").trim();
    const sub = String(secondary[index] ?? "").trim();
    let label = sub && normal(sub) !== normal(top) ? `${top ? `${top} · ` : ""}${sub}` : (top || sub);
    if (type === "F" && index === 18 && !label) label = "Tahun";
    if (!label || ["no", "nomor"].includes(normal(label))) label = `Rincian ${index + 1}`;
    details.push({ label, value });
  }
  return details;
}
function parseKibSheet(sheet, type, filename) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerAt = findHeaderRow(rows, "kib");
  if (headerAt < 0) throw new Error(`Header KIB tidak ditemukan pada sheet ${sheet.name || sheet.Name || ""}.`);
  const cols = {
    opdCode: colByLabel(rows, [label => label === "kode skpd"]),
    opdName: colByLabel(rows, [label => label === "nama skpd"]),
    skpd: colByLabel(rows, [label => label === "skpd"]),
    name: colByLabel(rows, [label => label.includes("jenis barang"), label => label.includes("nama barang")]),
    code: colByLabel(rows, [label => label === "kode barang"]),
    register: colByLabel(rows, [label => label === "no register" || label === "nomor register"]),
    nibar: colByLabel(rows, [label => label === "nibar"]),
    id: colByLabel(rows, [label => label === "id"]),
    merk: colByLabel(rows, [label => label.includes("merk type")]),
    size: colByLabel(rows, [label => label.includes("ukuran")]),
    bahan: colByLabel(rows, [label => label === "bahan"]),
    year: colByLabel(rows, [label => label.includes("tahun pembelian")]),
    serial: colByLabel(rows, [label => label.includes("sertifikat") || label.includes("pabrik")]),
    rangka: colByLabel(rows, [label => label === "no rangka" || label === "rangka"]),
    mesin: colByLabel(rows, [label => label === "no mesin" || label === "mesin"]),
    polisi: colByLabel(rows, [label => label === "no polisi" || label === "polisi"]),
    bpkb: colByLabel(rows, [label => label === "bpkb"]),
    warna: colByLabel(rows, [label => label === "warna"]),
    condition: colByLabel(rows, [label => label === "kondisi" || label.includes("kondisi bangunan")]),
    quantity: colByLabel(rows, [label => label === "jumlah"]),
    price: colByLabel(rows, [label => label === "harga"]),
    origin: colByLabel(rows, [label => label.includes("asal usul")]),
    pemakai: colByLabel(rows, [label => label.includes("nama pemakai")]),
    nip: colByLabel(rows, [label => label.includes("nip pemakai")]),
    jabatan: colByLabel(rows, [label => label.includes("jabatan pemakai")]),
    area: colByLabel(rows, [label => label === "luas" || label.includes("luas lantai")]),
    address: colByLabel(rows, [label => label.includes("letak") || label.includes("lokasi alamat")]),
    landStatus: colByLabel(rows, [label => label === "status tanah"]),
    landCode: colByLabel(rows, [label => label === "kode tanah"]),
    construction: colByLabel(rows, [label => label === "konstruksi" || label === "kontruksi bangunan"]),
    length: colByLabel(rows, [label => label === "panjang"]),
    width: colByLabel(rows, [label => label === "lebar"]),
    contractValue: colByLabel(rows, [label => label.includes("nilai kontrak")]),
    documents: colByLabel(rows, [label => label.includes("dokumen")]),
    sourceYear: colByLabel(rows, [label => label.includes("tahun cetak") || label.includes("tahun pembelian") || label === "tahun"])
  };
  if (cols.name < 0 || cols.code < 0 || cols.nibar < 0) throw new Error(`Kolom nama barang, kode barang, atau NIBAR tidak ditemukan pada ${filename}.`);
  const parsed = [];
  for (let index = headerAt + 1; index < rows.length; index++) {
    const row = rows[index];
    const name = String(get(row, cols.name)).trim();
    const nibar = String(get(row, cols.nibar)).trim();
    const sourceCode = String(get(row, cols.code)).trim();
    if (!name || !sourceCode || normal(name).includes("subtotal")) continue;
    const legacySkpd = String(get(row, cols.skpd)).trim();
    const opd = parseOpd(get(row, cols.opdCode), get(row, cols.opdName), legacySkpd);
    const register = String(get(row, cols.register)).trim();
    const idCode = String(get(row, cols.id)).trim();
    const unique = nibar || `${sourceCode}|${register}|${normal(name)}`;
    const sourceCondition = conditionLabel(String(get(row, cols.condition)).trim());
    const ignored = new Set([0, 1, 2, cols.opdCode, cols.opdName, cols.skpd, cols.name, cols.code, cols.register, cols.nibar, cols.id].filter(index => index >= 0));
    const sourceDetails = sourceDetailFields(rows, headerAt, row, ignored, type);
    const commonSpecs = makeSpecs(row, cols);
    const specsSource = [commonSpecs, ...sourceDetails.map(detail => `${detail.label}: ${detail.value}`)].filter(Boolean).join(" · ");
    parsed.push({
      id: `${type}|${opd.opdCode || "unknown"}|${unique}`, kibType: type, filename, nibar, idCode, sourceCode, register,
      opdCode: opd.opdCode, opdName: opd.opdName, skpd: legacySkpd, name,
      merk: String(get(row, cols.merk)).trim(), specsSource, sourceDetails,
      specsCurrent: specsSource,
      conditionSource: sourceCondition === "Belum dicatat" ? "" : sourceCondition,
      conditionCurrent: sourceCondition === "Belum dicatat" ? "" : sourceCondition,
      quantity: String(get(row, cols.quantity)).trim(), price: String(get(row, cols.price)).trim(),
      year: String(get(row, cols.year >= 0 ? cols.year : cols.sourceYear >= 0 ? cols.sourceYear : type === "F" ? 18 : -1)).trim(), origin: String(get(row, cols.origin)).trim(),
      area: String(get(row, cols.area)).trim(), address: String(get(row, cols.address)).trim(),
      construction: String(get(row, cols.construction)).trim(), length: String(get(row, cols.length)).trim(), width: String(get(row, cols.width)).trim(),
      landStatus: String(get(row, cols.landStatus)).trim(), landCode: String(get(row, cols.landCode)).trim(), contractValue: String(get(row, cols.contractValue)).trim(),
      documentDate: String(get(row, colByLabel(rows, [label => label === "tanggal"]))).trim(),
      documentNumber: String(get(row, colByLabel(rows, [label => label === "nomor"]))).trim(),
      pemakai: String(get(row, cols.pemakai)).trim(), nipPemakai: String(get(row, cols.nip)).trim(),
      jabatanPemakai: String(get(row, cols.jabatan)).trim(), importedAt: Date.now()
    });
  }
  return parsed;
}
function parseKibWorkbook(workbook, filename) {
  const jobs = [];
  const recognizedSheets = workbook.SheetNames.map(name => ({ name, type: detectType(name) })).filter(item => item.type);
  if (recognizedSheets.length) {
    for (const item of recognizedSheets) jobs.push(...parseKibSheet(workbook.Sheets[item.name], item.type, filename));
  } else {
    const type = detectType(filename);
    if (!type) throw new Error("Jenis KIB tidak dikenali. Gunakan nama file KIB A, B, EC, C, D, E, F, atau G, atau unggah template KIB.");
    jobs.push(...parseKibSheet(workbook.Sheets[workbook.SheetNames[0]], type, filename));
  }
  if (!jobs.length) throw new Error("Tidak ada baris aset yang terbaca dari file KIB.");
  return jobs;
}
function parseRoomWorkbook(workbook, filename) {
  const sheet = workbook.Sheets[workbook.SheetNames.find(name => normal(name).includes("master ruangan")) || workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerAt = findHeaderRow(rows, "rooms");
  if (headerAt < 0) throw new Error("Header ruangan tidak ditemukan. Unggah template master ruangan.");
  const cols = {
    opdCode: colByLabel(rows, [label => label === "kode skpd"]),
    opdName: colByLabel(rows, [label => label === "nama skpd"]),
    code: colByLabel(rows, [label => label === "kode ruangan" || label === "kode"]),
    name: colByLabel(rows, [label => label === "nama ruangan" || label === "uraian"]),
    status: colByLabel(rows, [label => label === "status"])
  };
  const parsed = [];
  for (let index = headerAt + 1; index < rows.length; index++) {
    const row = rows[index];
    const code = String(get(row, cols.code)).trim();
    const name = String(get(row, cols.name)).trim();
    const opd = parseOpd(get(row, cols.opdCode), get(row, cols.opdName), "");
    if (!opd.opdCode || !opd.opdName || !code || !name) continue;
    const active = cols.status < 0 ? true : !["0", "tidak", "nonaktif", "false"].includes(normal(get(row, cols.status)));
    parsed.push({ key: `${opd.opdCode}|${code}`, opdCode: opd.opdCode, opdName: opd.opdName, code, name, active, sourceFile: filename });
  }
  if (!parsed.length) throw new Error("Tidak ada baris ruangan valid. Isi Kode SKPD, Nama SKPD, Kode Ruangan, dan Nama Ruangan.");
  return parsed;
}
async function readWorkbook(file) { return XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false }); }

function openImport() {
  selectedFiles = [];
  $("#kibFiles").value = "";
  $("#selectedFiles").textContent = "Belum ada file dipilih.";
  $("#startImport").disabled = true;
  $("#importDialog").showModal();
}
function updateFileSelection(files) {
  selectedFiles = [...files];
  $("#selectedFiles").textContent = selectedFiles.length ? selectedFiles.map(file => file.name).join(" · ") : "Belum ada file dipilih.";
  $("#startImport").disabled = selectedFiles.length === 0;
}
async function importSelectedFiles() {
  if (!selectedFiles.length) return;
  const button = $("#startImport");
  button.disabled = true;
  button.textContent = "Memproses…";
  const updates = [];
  const errors = [];
  let importedCount = 0;
  try {
    for (const file of selectedFiles) {
      try { updates.push(...parseKibWorkbook(await readWorkbook(file), file.name)); importedCount += updates.length; }
      catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    const latest = new Map();
    for (const item of updates) {
      const previous = assets.find(asset => asset.id === item.id || (item.nibar && asset.kibType === item.kibType && asset.nibar === item.nibar && opdCode(asset) === item.opdCode));
      const merged = previous ? {
        ...item, id: previous.id, currentCode: previous.currentCode ?? item.sourceCode,
        room: previous.room || "", roomCode: previous.roomCode || previous.room || "", roomKey: previous.roomKey || "", roomName: previous.roomName || "",
        inventoryStatus: previous.inventoryStatus || "Belum diperiksa", conditionCurrent: previous.conditionCurrent || item.conditionCurrent,
        barcodeKib: previous.barcodeKib || "", barcodeKir: previous.barcodeKir || "", specsCurrent: previous.specsCurrent ?? item.specsCurrent,
        notes: previous.notes || "", photoData: previous.photoData || "", updatedAt: previous.updatedAt || 0
      } : { ...item, currentCode: item.sourceCode, inventoryStatus: "Belum diperiksa", barcodeKib: "", barcodeKir: "", notes: "", photoData: "", room: "", roomCode: "", roomKey: "", roomName: "", updatedAt: 0 };
      latest.set(merged.id, merged);
    }
    if (latest.size) {
      await putMany("assets", [...latest.values()]);
      assets = await listStore("assets");
      renderAll();
    }
    $("#importDialog").close();
    if (errors.length) showToast(errors.slice(0, 2).join(" "));
    else showToast(`${formatNumber(latest.size)} aset berhasil diimpor atau diperbarui.`);
  } finally {
    button.disabled = false;
    button.textContent = "Impor aset";
  }
}
async function importRooms(file) {
  try {
    const parsed = parseRoomWorkbook(await readWorkbook(file), file.name);
    const old = new Map(rooms.map(room => [room.key, room]));
    const merged = parsed.map(room => ({ ...old.get(room.key), ...room }));
    await putMany("rooms", merged);
    rooms = await listStore("rooms");
    renderAll();
    showToast(`${formatNumber(parsed.length)} ruangan berhasil diimpor untuk ${new Set(parsed.map(room => room.opdCode)).size} OPD.`);
  } catch (error) { showToast(`Impor ruangan gagal: ${error.message}`); }
}

async function saveCurrentAsset(event) {
  event.preventDefault();
  const asset = assets.find(item => item.id === activeAssetId);
  if (!asset) return;
  const form = event.currentTarget;
  const selectedRoom = rooms.find(room => roomKey(room) === form.elements.room.value);
  const photoFile = form.elements.photo.files[0];
  let photoData = asset.photoData || "";
  if (photoFile) photoData = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(photoFile);
  });
  const next = {
    ...asset, currentCode: form.elements.currentCode.value.trim(),
    room: selectedRoom?.code || "", roomCode: selectedRoom?.code || "", roomKey: selectedRoom ? roomKey(selectedRoom) : "", roomName: selectedRoom?.name || "",
    inventoryStatus: form.elements.inventoryStatus.value, conditionCurrent: form.elements.conditionCurrent.value,
    barcodeKib: form.elements.barcodeKib.value, barcodeKir: form.elements.barcodeKir.value,
    specsCurrent: form.elements.specsCurrent.value.trim(), notes: form.elements.notes.value.trim(), photoData, updatedAt: Date.now()
  };
  await putOne("assets", next);
  assets = assets.map(item => item.id === next.id ? next : item);
  $("#assetDialog").close(); renderAll(); showToast("Pemeriksaan aset tersimpan.");
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function exportBackup() {
  const backup = { application: "Inventaris Aset BMD", version: 3, exportedAt: new Date().toISOString(), rooms, assets, itemReferences };
  downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), `cadangan-inventaris-bmd-${new Date().toISOString().slice(0, 10)}.json`);
  showToast("Cadangan inventaris berhasil diunduh.");
}
async function restoreBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (!Array.isArray(backup.assets)) throw new Error("File cadangan tidak berisi data aset.");
    if (!window.confirm(`Pulihkan ${backup.assets.length} aset dari cadangan? Data akan digabung berdasarkan ID aset.`)) return;
    await putMany("assets", backup.assets);
    if (Array.isArray(backup.itemReferences)) await putMany("itemReferences", backup.itemReferences);
    if (Array.isArray(backup.rooms)) {
      const restoredRooms = backup.rooms.map(room => Array.isArray(room)
        ? { opdCode: "08.00.000", opdName: "BADAN PENANGGULANGAN BENCANA DAERAH", code: String(room[0]), name: room[1], active: true, key: `08.00.000|${room[0]}` }
        : ({ ...room, key: room.key || `${room.opdCode}|${room.code}` }));
      await putMany("rooms", restoredRooms);
    }
    assets = await listStore("assets"); rooms = await listStore("rooms"); itemReferences = await listStore("itemReferences"); renderAll(); showToast("Cadangan berhasil dipulihkan.");
  } catch (error) { showToast(`Tidak bisa memulihkan cadangan: ${error.message}`); }
}
function exportCsv() {
  const columns = ["OPD", "Kode OPD", "KIB", "Nama Barang", "NIBAR", "ID", "Kode KIB", "Kode Barang Terkini", "No Register", "Ruangan", "Kondisi KIB", "Kondisi Terkini", "Barcode KIB", "Barcode KIR", "Status Pemeriksaan", "Spesifikasi Terkini", "Catatan", "Pemakai"];
  const rows = filteredAssets("inventory").map(asset => [opdLabel(asset), opdCode(asset), asset.kibType, asset.name, asset.nibar, asset.idCode, asset.sourceCode, asset.currentCode, asset.register, assetRoomName(asset), conditionLabel(asset.conditionSource), conditionLabel(asset.conditionCurrent), asset.barcodeKib, asset.barcodeKir, asset.inventoryStatus, asset.specsCurrent, asset.notes, asset.pemakai]);
  const csv = [columns, ...rows].map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
  downloadBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), `inventarisasi-bmd-${new Date().toISOString().slice(0, 10)}.csv`);
}
function exportRecommendations() {
  const list = getRecommendations().map(({ asset, type, reason }) => ({
    Rekomendasi: type, Alasan: reason, OPD: opdLabel(asset), "Kode SKPD": opdCode(asset), KIB: `KIB ${asset.kibType}`,
    "Nama Barang": asset.name, NIBAR: asset.nibar, ID: asset.idCode, "Kode Barang KIB": asset.sourceCode,
    "Kode Barang Terkini": asset.currentCode, "No Register": asset.register, Ruangan: assetRoomName(asset),
    "Kondisi KIB": conditionLabel(asset.conditionSource), "Kondisi Terkini": conditionLabel(asset.conditionCurrent),
    "Status Inventarisasi": asset.inventoryStatus, "Barcode KIB": asset.barcodeKib, "Barcode KIR": asset.barcodeKir,
    Spesifikasi: asset.specsCurrent, Catatan: asset.notes, Pemakai: asset.pemakai
  }));
  if (!list.length) { showToast("Tidak ada objek untuk rekomendasi yang dipilih."); return; }
  const sheet = XLSX.utils.json_to_sheet(list);
  sheet["!cols"] = Object.keys(list[0]).map(key => ({ wch: Math.min(42, Math.max(14, key.length + 3)) }));
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, "Rekomendasi");
  XLSX.writeFile(workbook, `rekomendasi-bmd-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(`${list.length} objek rekomendasi berhasil diunduh.`);
}

function wireEvents() {
  $$("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $$('[data-view-link="rooms"]').forEach(button => button.addEventListener("click", () => setView("rooms")));
  $$('[data-open-assets]').forEach(button => button.addEventListener("click", () => setView("assets")));
  $$('[data-trigger-import]').forEach(button => button.addEventListener("click", openImport));
  $("#importButton").addEventListener("click", openImport);
  $("#chooseFiles").addEventListener("click", () => $("#kibFiles").click());
  $("#kibFiles").addEventListener("change", event => updateFileSelection(event.target.files));
  $("#startImport").addEventListener("click", event => { event.preventDefault(); importSelectedFiles(); });
  $("#roomFiles").addEventListener("change", event => { if (event.target.files[0]) importRooms(event.target.files[0]); event.target.value = ""; });
  $("#importRoomsButton").addEventListener("click", () => $("#roomFiles").click());
  $("#importReferenceButton").addEventListener("click", () => { updateReferenceSelection([]); $("#referenceFiles").value = ""; $("#referenceImportDialog").showModal(); });
  $("#chooseReferenceFile").addEventListener("click", () => $("#referenceFiles").click());
  $("#referenceFiles").addEventListener("change", event => updateReferenceSelection(event.target.files));
  $("#startReferenceImport").addEventListener("click", event => { event.preventDefault(); importSelectedReferences(); });
  ["#referenceSearch", "#referenceTypeFilter"].forEach(selector => $(selector).addEventListener("input", renderReferenceTable));
  $("#assetForm").addEventListener("submit", saveCurrentAsset);
  ["#searchInput", "#typeFilter", "#roomFilter", "#statusFilter", "#inventoryOpdFilter"].forEach(selector => $(selector).addEventListener("input", renderAssetTable));
  $("#kibSearchInput").addEventListener("input", renderKibTable);
  $("#kibOpdFilter").addEventListener("input", renderKibTable);
  $("#kibTypeFilter").addEventListener("input", () => {
    renderKibTable();
    if (!$("#kibView").classList.contains("hidden")) $("#crumb").textContent = $("#kibTypeFilter").value ? `Data KIB · KIB ${$("#kibTypeFilter").value} ${KIB_LABELS[$("#kibTypeFilter").value] || ""}` : "Data KIB";
  });
  $("#roomOpdFilter").addEventListener("input", renderRoomList);
  ["#recommendationOpdFilter", "#recommendationTypeFilter", "#recommendationSearch"].forEach(selector => $(selector).addEventListener("input", renderRecommendations));
  $("#recommendationExportButton").addEventListener("click", exportRecommendations);
  $("#exportButton").addEventListener("click", exportBackup);
  $("#restoreButton").addEventListener("click", () => { $("#backupFile").value = ""; $("#backupFile").click(); });
  $("#backupFile").addEventListener("change", event => { if (event.target.files[0]) restoreBackup(event.target.files[0]); });
  $("#csvButton").addEventListener("click", exportCsv);
  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  $("#assetForm [name=photo]").addEventListener("change", event => {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader(); reader.onload = () => { $("#photoPreview").innerHTML = `<img src="${reader.result}" alt="Pratinjau foto">`; }; reader.readAsDataURL(file);
  });
}

async function init() {
  $("#today").textContent = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date());
  wireEvents();
  try {
    db = await openDatabase();
    assets = await listLocalStore("assets");
    rooms = await listLocalStore("rooms");
    itemReferences = await listLocalStore("itemReferences");
    if (!rooms.length) { rooms = DEFAULT_ROOMS.map(room => ({ ...room, key: roomKey(room) })); await putMany("rooms", rooms); }
    await syncCloudOnStart();
    if (cloudStatus === "connected") {
      assets = await listStore("assets"); rooms = await listStore("rooms"); itemReferences = await listStore("itemReferences");
    }
    renderAll();
  } catch (error) { showToast("Penyimpanan lokal tidak tersedia. Buka aplikasi melalui browser modern."); console.error(error); }
}
init();
