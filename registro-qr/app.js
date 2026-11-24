/* ============================================================================
 * REGISTRO QR – TAREAS Y ACTIVIDADES (PWA 100% OFFLINE)
 * Vanilla JS + IndexedDB + Web Crypto API + html5-qrcode + qrcode.js
 * ============================================================================ */

'use strict';

const DB_NAME = 'RegistroQR_DB';
const DB_VERSION = 1;

const state = {
  db: null,
  students: [],
  activities: [],
  deliveries: [],
  settings: {},
  activeActivityId: '',
  lastDeliveryId: null,
  scanner: null,
  isCameraRunning: false,
  isScanCooldown: false,
  cooldownTimer: null,
  audioCtx: null,
  waitingWorker: null,
  currentSingleQrStudent: null
};

/* ============================================================================
 * 1. UTILIDADES DE FECHA/HORA (MÉXICO), SONIDO, VIBRACIÓN Y CRIPTOGRAFÍA
 * ============================================================================ */

function getMexicoTimestampObj(dateObj = new Date()) {
  const iso = dateObj.toISOString();
  let formatted = '';
  try {
    const parts = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(dateObj);

    const map = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const hour = map.hour === '24' ? '00' : map.hour;
    formatted = `${map.day}/${map.month}/${map.year} ${hour}:${map.minute}:${map.second}`;
  } catch (e) {
    const pad = (n) => String(n).padStart(2, '0');
    formatted = `${pad(dateObj.getDate())}/${pad(dateObj.getMonth() + 1)}/${dateObj.getFullYear()} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
  }

  const [fechaPart, horaPart] = formatted.split(' ');
  const [dd, mm, yyyy] = fechaPart.split('/');
  const ymd = `${yyyy}-${mm}-${dd}`;

  return {
    iso,
    formatted,
    fecha: fechaPart,
    hora: horaPart,
    ymd,
    epoch: dateObj.getTime()
  };
}

function formatDeadlineDisplay(datetimeLocalStr) {
  if (!datetimeLocalStr) return 'Sin fecha límite';
  const d = new Date(datetimeLocalStr);
  if (isNaN(d.getTime())) return datetimeLocalStr;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function hashPinSHA256(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`registro-qr-salt::${String(pin).trim()}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function playBeep(type = 'success') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!state.audioCtx) {
      state.audioCtx = new AudioContextClass();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }

    const now = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1174.66, now + 0.07);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.setValueAtTime(440, now + 0.1);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      osc.start(now);
      osc.stop(now + 0.24);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(240, now);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    }
  } catch (err) {
    // Ignorar si el navegador bloquea Web Audio sin interacción previa
  }
}

function triggerVibration(type = 'success') {
  try {
    if (!navigator.vibrate) return;
    if (type === 'success') {
      navigator.vibrate(120);
    } else if (type === 'warning') {
      navigator.vibrate([90, 60, 90]);
    } else {
      navigator.vibrate([180, 70, 180]);
    }
  } catch (err) {
    // Ignorar en dispositivos sin soporte de vibración (ej. iOS)
  }
}

function showToast(message, duration = 2800) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, duration);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================================================================
 * 2. BASE DE DATOS LOCAL (INDEXEDDB)
 * ============================================================================ */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('students')) {
        const studentStore = db.createObjectStore('students', { keyPath: 'id' });
        studentStore.createIndex('matricula', 'matricula', { unique: true });
        studentStore.createIndex('grupo', 'grupo', { unique: false });
      }

      if (!db.objectStoreNames.contains('activities')) {
        const activityStore = db.createObjectStore('activities', { keyPath: 'id' });
        activityStore.createIndex('tipo', 'tipo', { unique: false });
        activityStore.createIndex('grupo', 'grupo', { unique: false });
      }

      if (!db.objectStoreNames.contains('deliveries')) {
        const deliveryStore = db.createObjectStore('deliveries', { keyPath: 'id' });
        deliveryStore.createIndex('activityId', 'activityId', { unique: false });
        deliveryStore.createIndex('studentId', 'studentId', { unique: false });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbClearStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function saveSetting(key, value) {
  state.settings[key] = value;
  await dbPut('settings', { key, value });
}

async function loadAllDataFromDB() {
  const [students, activities, deliveries, settingsArr] = await Promise.all([
    dbGetAll('students'),
    dbGetAll('activities'),
    dbGetAll('deliveries'),
    dbGetAll('settings')
  ]);

  state.students = students.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  state.activities = activities.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  state.deliveries = deliveries.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));

  state.settings = {};
  for (const s of settingsArr) {
    state.settings[s.key] = s.value;
  }

  if (state.settings.activeActivityId) {
    const exists = state.activities.some((a) => a.id === state.settings.activeActivityId);
    state.activeActivityId = exists ? state.settings.activeActivityId : '';
  } else if (state.activities.length > 0 && !state.activeActivityId) {
    state.activeActivityId = state.activities[0].id;
  }
}

/* ============================================================================
 * 3. SEGURIDAD Y PIN (SHA-256)
 * ============================================================================ */

function initPinScreen() {
  const pinScreen = document.getElementById('pin-screen');
  const appShell = document.getElementById('app-shell');
  const pinTitle = document.getElementById('pin-title');
  const pinSubtitle = document.getElementById('pin-subtitle');
  const pinInput = document.getElementById('pin-input');
  const pinConfirmGroup = document.getElementById('pin-confirm-group');
  const pinConfirmInput = document.getElementById('pin-confirm-input');
  const pinSubmitBtn = document.getElementById('pin-submit-btn');
  const pinError = document.getElementById('pin-error');

  const storedHash = state.settings.pinHash;
  pinInput.value = '';
  pinConfirmInput.value = '';
  pinError.classList.add('hidden');

  if (!storedHash) {
    pinTitle.textContent = 'Configura tu PIN de Seguridad';
    pinSubtitle.textContent = 'Crea un PIN de 4 a 6 dígitos para proteger el registro de entregas.';
    pinConfirmGroup.classList.remove('hidden');
    pinConfirmInput.required = true;
    pinSubmitBtn.textContent = 'Guardar PIN y entrar';
  } else {
    pinTitle.textContent = 'Acceso a Registro QR';
    pinSubtitle.textContent = 'Ingresa tu PIN de 4 a 6 dígitos para desbloquear.';
    pinConfirmGroup.classList.add('hidden');
    pinConfirmInput.required = false;
    pinSubmitBtn.textContent = 'Desbloquear';
  }

  pinScreen.classList.remove('hidden');
  appShell.classList.add('hidden');
}

async function handlePinSubmit(event) {
  event.preventDefault();
  const pinInput = document.getElementById('pin-input');
  const pinConfirmInput = document.getElementById('pin-confirm-input');
  const pinError = document.getElementById('pin-error');

  const pin = pinInput.value.trim();
  const isValidFormat = /^[0-9]{4,6}$/.test(pin);

  if (!isValidFormat) {
    pinError.textContent = 'El PIN debe contener entre 4 y 6 números.';
    pinError.classList.remove('hidden');
    return;
  }

  const storedHash = state.settings.pinHash;

  if (!storedHash) {
    const confirmPin = pinConfirmInput.value.trim();
    if (pin !== confirmPin) {
      pinError.textContent = 'Los PIN ingresados no coinciden.';
      pinError.classList.remove('hidden');
      return;
    }
    const newHash = await hashPinSHA256(pin);
    await saveSetting('pinHash', newHash);
    unlockApp();
    showToast('🔐 PIN configurado correctamente');
  } else {
    const enteredHash = await hashPinSHA256(pin);
    if (enteredHash !== storedHash) {
      pinError.textContent = 'PIN incorrecto. Inténtalo de nuevo.';
      pinError.classList.remove('hidden');
      triggerVibration('error');
      pinInput.value = '';
      pinInput.focus();
      return;
    }
    unlockApp();
  }
}

function unlockApp() {
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  renderAll();
  checkBackupReminder();
}

async function handleChangePinSubmit(event) {
  event.preventDefault();
  const currentPin = document.getElementById('current-pin-input').value.trim();
  const newPin = document.getElementById('new-pin-input').value.trim();
  const confirmNewPin = document.getElementById('confirm-new-pin-input').value.trim();

  const currentHash = await hashPinSHA256(currentPin);
  if (currentHash !== state.settings.pinHash) {
    showToast('❌ El PIN actual es incorrecto');
    return;
  }

  if (!/^[0-9]{4,6}$/.test(newPin)) {
    showToast('⚠️ El nuevo PIN debe tener de 4 a 6 dígitos numéricos');
    return;
  }

  if (newPin !== confirmNewPin) {
    showToast('⚠️ La confirmación del nuevo PIN no coincide');
    return;
  }

  const newHash = await hashPinSHA256(newPin);
  await saveSetting('pinHash', newHash);
  document.getElementById('form-change-pin').reset();
  showToast('✅ PIN actualizado con éxito');
}

/* ============================================================================
 * 4. GESTIÓN DE ALUMNOS, IMPORTACIÓN CSV Y CREDENCIALES QR
 * ============================================================================ */

function getDistinctGroups() {
  const set = new Set();
  for (const s of state.students) {
    if (s.grupo && s.grupo.trim()) set.add(s.grupo.trim());
  }
  for (const a of state.activities) {
    if (a.grupo && a.grupo.trim()) set.add(a.grupo.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
}

function populateGroupDropdowns() {
  const groups = getDistinctGroups();
  const selectIds = [
    'filter-students-group',
    'filter-activities-group',
    'report-filter-group',
    'print-filter-group'
  ];

  for (const id of selectIds) {
    const selectEl = document.getElementById(id);
    if (!selectEl) continue;
    const currentVal = selectEl.value;
    selectEl.innerHTML = '<option value="">Todos los grupos</option>';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = `Grupo ${g}`;
      selectEl.appendChild(opt);
    }
    if (groups.includes(currentVal)) {
      selectEl.value = currentVal;
    }
  }
}

function openStudentModal(student = null) {
  const title = document.getElementById('modal-student-title');
  const idInput = document.getElementById('student-id-hidden');
  const matInput = document.getElementById('student-matricula');
  const nomInput = document.getElementById('student-nombre');
  const grpInput = document.getElementById('student-grupo');

  if (student) {
    title.textContent = 'Editar Alumno';
    idInput.value = student.id;
    matInput.value = student.matricula;
    nomInput.value = student.nombre;
    grpInput.value = student.grupo || '';
  } else {
    title.textContent = 'Nuevo Alumno';
    idInput.value = '';
    matInput.value = '';
    nomInput.value = '';
    grpInput.value = '';
  }

  document.getElementById('modal-student').classList.remove('hidden');
  matInput.focus();
}

async function handleSaveStudent(event) {
  event.preventDefault();
  const id = document.getElementById('student-id-hidden').value.trim();
  const matricula = document.getElementById('student-matricula').value.trim();
  const nombre = document.getElementById('student-nombre').value.trim();
  const grupo = document.getElementById('student-grupo').value.trim();

  if (!matricula || !nombre) {
    showToast('⚠️ Matrícula y nombre son obligatorios');
    return;
  }

  // Verificar duplicado de matrícula
  const duplicate = state.students.find(
    (s) => s.matricula.toLowerCase() === matricula.toLowerCase() && s.id !== id
  );
  if (duplicate) {
    showToast(`⚠️ La matrícula "${matricula}" ya pertenece a ${duplicate.nombre}`);
    return;
  }

  const studentObj = {
    id: id || generateId('stu'),
    matricula,
    nombre,
    grupo,
    createdAt: id
      ? (state.students.find((s) => s.id === id)?.createdAt || Date.now())
      : Date.now()
  };

  await dbPut('students', studentObj);
  await loadAllDataFromDB();
  closeModal('modal-student');
  renderAll();
  showToast(id ? '✅ Alumno actualizado' : '✅ Alumno registrado');
}

async function deleteStudent(studentId) {
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return;

  const confirmDel = window.confirm(
    `¿Eliminar al alumno "${student.nombre}" (${student.matricula}) y su historial de entregas?`
  );
  if (!confirmDel) return;

  await dbDelete('students', studentId);

  // Eliminar entregas asociadas a este alumno
  const relatedDeliveries = state.deliveries.filter((d) => d.studentId === studentId);
  for (const d of relatedDeliveries) {
    await dbDelete('deliveries', d.id);
  }

  await loadAllDataFromDB();
  renderAll();
  showToast('🗑️ Alumno eliminado');
}

function generateNextAutoMatricula(usedSet) {
  let num = state.students.length + 1;
  while (true) {
    const candidate = `ALU-${String(num).padStart(3, '0')}`;
    if (!usedSet.has(candidate.toLowerCase())) {
      usedSet.add(candidate.toLowerCase());
      return candidate;
    }
    num++;
  }
}

function parseExcelRowsToNormalizedLines(rows2D) {
  if (!Array.isArray(rows2D) || rows2D.length === 0) return [];

  const usedMatriculas = new Set(state.students.map((s) => s.matricula.toLowerCase()));
  const resultLines = [];

  // Detectar si la primera fila es un encabezado
  let startIdx = 0;
  let colMap = { matricula: -1, nombre: -1, grupo: -1 };

  const firstRow = rows2D[0].map((c) => String(c ?? '').trim());
  const hasHeaderKeywords = firstRow.some((cell) =>
    /^(matr[ií]cula|id|no\.?\s*lista|n[uú]mero|control|clave|nombre|alumno|estudiante|grupo|secci[oó]n|grado)$/i.test(cell)
  );

  if (hasHeaderKeywords) {
    startIdx = 1;
    firstRow.forEach((cell, idx) => {
      if (colMap.matricula === -1 && /matr[ií]cula|id|lista|n[uú]mero|control|clave/i.test(cell)) {
        colMap.matricula = idx;
      } else if (colMap.nombre === -1 && /nombre|alumno|estudiante/i.test(cell)) {
        colMap.nombre = idx;
      } else if (colMap.grupo === -1 && /grupo|secci[oó]n|grado|sal[oó]n/i.test(cell)) {
        colMap.grupo = idx;
      }
    });
  }

  for (let i = startIdx; i < rows2D.length; i++) {
    const rawRow = rows2D[i];
    if (!Array.isArray(rawRow)) continue;
    const cells = rawRow.map((c) => String(c ?? '').trim());
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 0) continue;

    let matricula = '';
    let nombre = '';
    let grupo = '';

    if (hasHeaderKeywords && (colMap.nombre !== -1 || colMap.matricula !== -1)) {
      if (colMap.matricula !== -1) matricula = cells[colMap.matricula] || '';
      if (colMap.nombre !== -1) nombre = cells[colMap.nombre] || '';
      if (colMap.grupo !== -1) grupo = cells[colMap.grupo] || '';

      // Si no encontró columna explícita de nombre pero hay otra columna con texto
      if (!nombre) {
        const otherIdx = cells.findIndex((val, idx) => val && idx !== colMap.matricula && idx !== colMap.grupo);
        if (otherIdx !== -1) nombre = cells[otherIdx];
      }
    } else if (nonEmpty.length === 1) {
      // Solo viene el nombre del alumno en una columna -> generar matrícula automática
      nombre = nonEmpty[0];
      matricula = generateNextAutoMatricula(usedMatriculas);
    } else if (nonEmpty.length === 2) {
      // Si la primera columna parece un nombre largo con espacios y la segunda un grupo corto (ej. "Juan Pérez", "3A")
      const firstLooksLikeName = nonEmpty[0].includes(' ') && !/\d/.test(nonEmpty[0]);
      const secondLooksLikeGroup = nonEmpty[1].length <= 6;
      if (firstLooksLikeName && secondLooksLikeGroup) {
        nombre = nonEmpty[0];
        grupo = nonEmpty[1];
        matricula = generateNextAutoMatricula(usedMatriculas);
      } else {
        matricula = nonEmpty[0];
        nombre = nonEmpty[1];
      }
    } else {
      matricula = nonEmpty[0];
      nombre = nonEmpty[1];
      grupo = nonEmpty[2] || '';
    }

    if (!nombre && matricula) {
      // Caso donde solo pusieron una columna y cayó en matrícula
      nombre = matricula;
      matricula = generateNextAutoMatricula(usedMatriculas);
    }

    if (!matricula && nombre) {
      matricula = generateNextAutoMatricula(usedMatriculas);
    }

    if (matricula && nombre) {
      usedMatriculas.add(matricula.toLowerCase());
      resultLines.push(`${matricula}, ${nombre}${grupo ? `, ${grupo}` : ''}`);
    }
  }

  return resultLines;
}

async function readSpreadsheetFileToLines(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if ((ext === 'xlsx' || ext === 'xls') && typeof XLSX !== 'undefined') {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows2D = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    return parseExcelRowsToNormalizedLines(rows2D);
  }

  // Fallback para archivos .csv o .txt
  const text = await file.text();
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows2D = rawLines.map((line) => {
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    return line.split(sep).map((p) => p.replace(/^["']|["']$/g, '').trim());
  });
  return parseExcelRowsToNormalizedLines(rows2D);
}

async function importNormalizedStudentLines(lines) {
  let added = 0;
  let updated = 0;
  const usedMatriculas = new Set(state.students.map((s) => s.matricula.toLowerCase()));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    const cleanParts = line.split(sep).map((p) => p.replace(/^["']|["']$/g, '').trim()).filter(Boolean);

    if (cleanParts.length === 0) continue;

    let matricula = '';
    let nombre = '';
    let grupo = '';

    if (cleanParts.length === 1) {
      nombre = cleanParts[0];
      matricula = generateNextAutoMatricula(usedMatriculas);
    } else {
      const [firstCol, secondCol, thirdCol] = cleanParts;
      if (
        i === 0 &&
        /matr[ií]cula|id|lista/i.test(firstCol) &&
        /nombre|alumno/i.test(secondCol)
      ) {
        continue;
      }
      matricula = firstCol;
      nombre = secondCol;
      grupo = thirdCol || '';
    }

    if (!matricula || !nombre) continue;

    const existing = state.students.find(
      (s) => s.matricula.toLowerCase() === matricula.toLowerCase()
    );

    if (existing) {
      existing.nombre = nombre;
      if (grupo) existing.grupo = grupo;
      await dbPut('students', existing);
      updated++;
    } else {
      const newStudent = {
        id: generateId('stu'),
        matricula,
        nombre,
        grupo,
        createdAt: Date.now()
      };
      await dbPut('students', newStudent);
      state.students.push(newStudent);
      usedMatriculas.add(matricula.toLowerCase());
      added++;
    }
  }

  await loadAllDataFromDB();
  renderAll();
  return { added, updated };
}

async function handleImportStudents(event) {
  event.preventDefault();
  const rawText = document.getElementById('import-students-textarea').value;
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    showToast('⚠️ No hay alumnos para importar');
    return;
  }

  const { added, updated } = await importNormalizedStudentLines(lines);
  document.getElementById('form-import-students').reset();
  closeModal('modal-import-students');
  showToast(`✅ Excel importado: ${added} alumnos nuevos con QR generado (${updated} actualizados)`);
}

async function handleQuickExcelUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const normalizedLines = await readSpreadsheetFileToLines(file);
    if (normalizedLines.length === 0) {
      showToast('⚠️ No se encontraron filas de alumnos en el archivo Excel');
      return;
    }
    const { added, updated } = await importNormalizedStudentLines(normalizedLines);
    showToast(`📗 Excel cargado: ${added} alumnos con su QR generado (${updated} actualizados)`);
  } catch (err) {
    showToast('❌ Error al leer el archivo Excel. Verifica que sea .xlsx, .xls o .csv');
  } finally {
    event.target.value = '';
  }
}

function renderStudentsList() {
  const listEl = document.getElementById('students-list');
  const summaryEl = document.getElementById('students-count-summary');
  const searchVal = document.getElementById('filter-students-search').value.trim().toLowerCase();
  const groupVal = document.getElementById('filter-students-group').value;

  const filtered = state.students.filter((s) => {
    const matchGroup = !groupVal || (s.grupo || '') === groupVal;
    const matchSearch =
      !searchVal ||
      s.nombre.toLowerCase().includes(searchVal) ||
      s.matricula.toLowerCase().includes(searchVal);
    return matchGroup && matchSearch;
  });

  summaryEl.textContent = `${filtered.length} de ${state.students.length} alumnos mostrados (cada alumno tiene su código QR único listo)`;

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state card">
        <div class="empty-icon">🎓</div>
        <h3>No hay alumnos registrados</h3>
        <p>Sube tu lista desde un archivo Excel (.xlsx / .csv) arriba y a cada alumno se le generará su código QR automáticamente.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = filtered
    .map((s) => {
      const deliveriesCount = state.deliveries.filter((d) => d.studentId === s.id).length;
      return `
        <div class="item-card">
          <div class="student-card-layout">
            <div>
              <div class="item-card-title">${escapeHtml(s.nombre)}</div>
              <div class="item-card-meta">
                <span class="badge badge-primary">ID / Matrícula: ${escapeHtml(s.matricula)}</span>
                ${s.grupo ? `<span class="badge">Grupo: ${escapeHtml(s.grupo)}</span>` : ''}
                <span class="badge">${deliveriesCount} entregas</span>
              </div>
            </div>
            <div
              class="student-inline-qr"
              data-action="view-qr"
              data-id="${s.id}"
              data-qr-value="${escapeHtml(s.matricula)}"
              title="Toca para ampliar o descargar este QR"
            >
              <div class="inline-qr-Mount"></div>
              <small>${escapeHtml(s.matricula)}</small>
            </div>
          </div>
          <div class="item-card-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="view-qr" data-id="${s.id}">
              🔳 Ampliar / Descargar QR
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="student-history" data-id="${s.id}">
              📋 Historial
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-student" data-id="${s.id}">
              ✏️ Editar
            </button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-student" data-id="${s.id}">
              🗑️ Eliminar
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  // Renderizar automáticamente el código QR en cada tarjeta de alumno
  if (typeof QRCode !== 'undefined') {
    listEl.querySelectorAll('.student-inline-qr').forEach((holder) => {
      const val = holder.dataset.qrValue;
      const mount = holder.querySelector('.inline-qr-Mount');
      if (val && mount) {
        new QRCode(mount, {
          text: val,
          width: 76,
          height: 76,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    });
  }
}

function openSingleStudentQR(studentId) {
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return;

  state.currentSingleQrStudent = student;
  const wrap = document.getElementById('single-qr-canvas-wrap');
  wrap.innerHTML = '';

  new QRCode(wrap, {
    text: student.matricula,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  document.getElementById('single-qr-name').textContent = student.nombre;
  document.getElementById('single-qr-meta').textContent = `Matrícula: ${student.matricula}${student.grupo ? ` • Grupo: ${student.grupo}` : ''}`;
  document.getElementById('modal-single-qr').classList.remove('hidden');
}

function downloadSingleStudentQR() {
  const student = state.currentSingleQrStudent;
  if (!student) return;

  const wrap = document.getElementById('single-qr-canvas-wrap');
  const qrCanvas = wrap.querySelector('canvas');
  const qrImg = wrap.querySelector('img');

  const outCanvas = document.createElement('canvas');
  outCanvas.width = 320;
  outCanvas.height = 380;
  const ctx = outCanvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 3;
  ctx.strokeRect(8, 8, outCanvas.width - 16, outCanvas.height - 16);

  const drawAndSave = (source) => {
    ctx.drawImage(source, 60, 28, 200, 200);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    const nameText = student.nombre.length > 28 ? student.nombre.slice(0, 28) + '…' : student.nombre;
    ctx.fillText(nameText, 160, 265);

    ctx.fillStyle = '#334155';
    ctx.font = '15px sans-serif';
    ctx.fillText(`ID: ${student.matricula}${student.grupo ? ` | Grupo: ${student.grupo}` : ''}`, 160, 295);

    const link = document.createElement('a');
    link.download = `QR_${student.matricula}_${student.nombre.replace(/\s+/g, '_')}.png`;
    link.href = outCanvas.toDataURL('image/png');
    link.click();
  };

  if (qrCanvas) {
    drawAndSave(qrCanvas);
  } else if (qrImg && qrImg.complete) {
    drawAndSave(qrImg);
  }
}

function openPrintCredentialsView() {
  if (state.students.length === 0) {
    showToast('⚠️ Registra alumnos primero para generar sus credenciales QR');
    return;
  }
  document.getElementById('print-sheet-overlay').classList.remove('hidden');
  renderPrintCredentialsSheet();
}

function renderPrintCredentialsSheet() {
  const groupFilter = document.getElementById('print-filter-group').value;
  const subtitle = document.getElementById('print-sheet-subtitle');
  const grid = document.getElementById('print-qr-grid');

  const studentsToPrint = state.students.filter(
    (s) => !groupFilter || (s.grupo || '') === groupFilter
  );

  subtitle.textContent = groupFilter
    ? `Grupo: ${groupFilter} (${studentsToPrint.length} alumnos)`
    : `Todos los grupos (${studentsToPrint.length} alumnos)`;

  grid.innerHTML = '';

  for (const s of studentsToPrint) {
    const card = document.createElement('div');
    card.className = 'credential-card';

    const qrHolder = document.createElement('div');
    qrHolder.className = 'credential-qr-holder';

    const nameEl = document.createElement('div');
    nameEl.className = 'credential-name';
    nameEl.textContent = s.nombre;

    const metaEl = document.createElement('div');
    metaEl.className = 'credential-meta';
    metaEl.textContent = `ID: ${s.matricula}${s.grupo ? ` • Grupo ${s.grupo}` : ''}`;

    card.appendChild(qrHolder);
    card.appendChild(nameEl);
    card.appendChild(metaEl);
    grid.appendChild(card);

    new QRCode(qrHolder, {
      text: s.matricula,
      width: 132,
      height: 132,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }
}

function downloadCredentialsSheetAsPNG() {
  const groupFilter = document.getElementById('print-filter-group').value;
  const cards = Array.from(document.querySelectorAll('#print-qr-grid .credential-card'));
  if (cards.length === 0) {
    showToast('⚠️ No hay credenciales para descargar');
    return;
  }

  const cols = 3;
  const rows = Math.ceil(cards.length / cols);
  const cardW = 260;
  const cardH = 240;
  const gap = 20;
  const pad = 30;

  const canvas = document.createElement('canvas');
  canvas.width = pad * 2 + cols * cardW + (cols - 1) * gap;
  canvas.height = pad * 2 + 60 + rows * cardH + (rows - 1) * gap;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Credenciales QR - ${groupFilter ? `Grupo ${groupFilter}` : 'Todos los grupos'}`,
    canvas.width / 2,
    45
  );

  cards.forEach((card, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = pad + col * (cardW + gap);
    const y = pad + 60 + row * (cardH + gap);

    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cardW, cardH);

    const qrCanvas = card.querySelector('canvas');
    const nameText = card.querySelector('.credential-name')?.textContent || '';
    const metaText = card.querySelector('.credential-meta')?.textContent || '';

    if (qrCanvas) {
      ctx.drawImage(qrCanvas, x + (cardW - 140) / 2, y + 16, 140, 140);
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    const shortName = nameText.length > 28 ? nameText.slice(0, 28) + '…' : nameText;
    ctx.fillText(shortName, x + cardW / 2, y + 185);

    ctx.fillStyle = '#475569';
    ctx.font = '12px sans-serif';
    ctx.fillText(metaText, x + cardW / 2, y + 208);
  });

  const link = document.createElement('a');
  link.download = `Credenciales_QR_${groupFilter || 'Todos'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('🖼️ Lámina PNG descargada');
}

/* ============================================================================
 * 5. GESTIÓN DE ACTIVIDADES (SE CREAN ANTES DE ESCANEAR)
 * ============================================================================ */

function openActivityModal(activity = null) {
  const title = document.getElementById('modal-activity-title');
  const idInput = document.getElementById('activity-id-hidden');
  const nomInput = document.getElementById('activity-nombre');
  const descInput = document.getElementById('activity-descripcion');
  const tipoInput = document.getElementById('activity-tipo');
  const ptsInput = document.getElementById('activity-puntos');
  const limInput = document.getElementById('activity-fecha-limite');
  const grpInput = document.getElementById('activity-grupo');

  if (activity) {
    title.textContent = 'Editar Actividad';
    idInput.value = activity.id;
    nomInput.value = activity.nombre;
    descInput.value = activity.descripcion || '';
    tipoInput.value = activity.tipo || 'Tarea';
    ptsInput.value = activity.puntos ?? 1;
    limInput.value = activity.fechaLimite || '';
    grpInput.value = activity.grupo || '';
  } else {
    title.textContent = 'Nueva Actividad';
    idInput.value = '';
    nomInput.value = '';
    descInput.value = '';
    tipoInput.value = 'Tarea';
    ptsInput.value = 1;
    limInput.value = '';
    grpInput.value = '';
  }

  document.getElementById('modal-activity').classList.remove('hidden');
  nomInput.focus();
}

async function handleSaveActivity(event) {
  event.preventDefault();
  const id = document.getElementById('activity-id-hidden').value.trim();
  const nombre = document.getElementById('activity-nombre').value.trim();
  const descripcion = document.getElementById('activity-descripcion').value.trim();
  const tipo = document.getElementById('activity-tipo').value;
  const puntosVal = parseFloat(document.getElementById('activity-puntos').value);
  const puntos = isNaN(puntosVal) ? 1 : puntosVal;
  const fechaLimite = document.getElementById('activity-fecha-limite').value;
  const grupo = document.getElementById('activity-grupo').value.trim();

  if (!nombre) {
    showToast('⚠️ El nombre de la actividad es obligatorio');
    return;
  }

  const activityObj = {
    id: id || generateId('act'),
    nombre,
    descripcion,
    tipo,
    puntos,
    fechaLimite,
    grupo,
    createdAt: id
      ? (state.activities.find((a) => a.id === id)?.createdAt || Date.now())
      : Date.now()
  };

  await dbPut('activities', activityObj);
  await loadAllDataFromDB();

  // Seleccionar automáticamente como actividad activa si es nueva
  if (!id) {
    state.activeActivityId = activityObj.id;
    await saveSetting('activeActivityId', activityObj.id);
  }

  closeModal('modal-activity');
  renderAll();
  showToast(id ? '✅ Actividad actualizada' : '✅ Actividad creada y seleccionada');
}

async function duplicateActivity(activityId) {
  const orig = state.activities.find((a) => a.id === activityId);
  if (!orig) return;

  const copy = {
    ...orig,
    id: generateId('act'),
    nombre: `${orig.nombre} (Copia)`,
    createdAt: Date.now()
  };

  await dbPut('activities', copy);
  await loadAllDataFromDB();
  state.activeActivityId = copy.id;
  await saveSetting('activeActivityId', copy.id);
  renderAll();
  showToast('📋 Actividad duplicada');
}

async function deleteActivity(activityId) {
  const act = state.activities.find((a) => a.id === activityId);
  if (!act) return;

  const count = state.deliveries.filter((d) => d.activityId === activityId).length;
  const confirmDel = window.confirm(
    `¿Eliminar la actividad "${act.nombre}" y sus ${count} entregas registradas?`
  );
  if (!confirmDel) return;

  await dbDelete('activities', activityId);
  const related = state.deliveries.filter((d) => d.activityId === activityId);
  for (const d of related) {
    await dbDelete('deliveries', d.id);
  }

  await loadAllDataFromDB();
  if (state.activeActivityId === activityId) {
    state.activeActivityId = state.activities[0]?.id || '';
    await saveSetting('activeActivityId', state.activeActivityId);
  }
  renderAll();
  showToast('🗑️ Actividad eliminada');
}

function renderActivitiesList() {
  const listEl = document.getElementById('activities-list');
  const searchVal = document.getElementById('filter-activities-search').value.trim().toLowerCase();
  const typeVal = document.getElementById('filter-activities-type').value;
  const groupVal = document.getElementById('filter-activities-group').value;

  const filtered = state.activities.filter((a) => {
    const matchType = !typeVal || a.tipo === typeVal;
    const matchGroup = !groupVal || (a.grupo || '') === groupVal;
    const matchSearch =
      !searchVal ||
      a.nombre.toLowerCase().includes(searchVal) ||
      (a.descripcion || '').toLowerCase().includes(searchVal);
    return matchType && matchGroup && matchSearch;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state card">
        <div class="empty-icon">📝</div>
        <h3>No hay actividades registradas</h3>
        <p>Crea una tarea, actividad en clase, proyecto o examen antes de escanear códigos QR.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = filtered
    .map((a) => {
      const deliveriesForAct = state.deliveries.filter((d) => d.activityId === a.id);
      const targetStudents = getApplicableStudentsForActivity(a);
      const isCurrentActive = a.id === state.activeActivityId;

      return `
        <div class="item-card">
          <div class="item-card-header">
            <div>
              <div class="item-card-title">
                ${escapeHtml(a.nombre)}
                ${isCurrentActive ? '<span class="badge badge-success">Activa para escanear</span>' : ''}
              </div>
              <div class="item-card-meta">
                <span class="badge badge-primary">${escapeHtml(a.tipo)}</span>
                <span class="badge">⭐ ${a.puntos} pts</span>
                <span class="badge">👥 ${a.grupo ? `Grupo ${escapeHtml(a.grupo)}` : 'Todos los grupos'}</span>
                <span class="badge">⏰ ${escapeHtml(formatDeadlineDisplay(a.fechaLimite))}</span>
                <span class="badge">📬 ${deliveriesForAct.length}/${targetStudents.length} entregados</span>
              </div>
              ${a.descripcion ? `<p class="activity-desc-small">${escapeHtml(a.descripcion)}</p>` : ''}
            </div>
          </div>
          <div class="item-card-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="scan-this-activity" data-id="${a.id}">
              📷 Escanear esta
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-activity" data-id="${a.id}">
              ✏️ Editar
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="duplicate-activity" data-id="${a.id}">
              📋 Duplicar
            </button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-activity" data-id="${a.id}">
              🗑️ Eliminar
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

/* ============================================================================
 * 6. ESCANEO Y REGISTRO DE ENTREGAS (CÁMARA EN VIVO + FOTO + MANUAL)
 * ============================================================================ */

function getApplicableStudentsForActivity(activity) {
  if (!activity) return state.students;
  if (!activity.grupo || !activity.grupo.trim()) {
    return state.students;
  }
  return state.students.filter(
    (s) => (s.grupo || '').toLowerCase() === activity.grupo.trim().toLowerCase()
  );
}

function renderScannerHeaderAndWorkspace() {
  const selectEl = document.getElementById('select-active-activity');
  const detailsBox = document.getElementById('active-activity-details');
  const noActWarning = document.getElementById('no-activity-warning');
  const workspace = document.getElementById('scanner-workspace');
  const counterEl = document.getElementById('scan-live-counter');
  const typeBadge = document.getElementById('scan-activity-type');

  selectEl.innerHTML = '<option value="">-- Selecciona una actividad para escanear --</option>';
  for (const a of state.activities) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.nombre} (${a.tipo}${a.grupo ? ` • ${a.grupo}` : ''})`;
    selectEl.appendChild(opt);
  }

  const activeAct = state.activities.find((a) => a.id === state.activeActivityId);

  if (!activeAct) {
    selectEl.value = '';
    detailsBox.classList.add('hidden');
    noActWarning.classList.remove('hidden');
    workspace.classList.add('hidden');
    typeBadge.textContent = 'Sin actividad activa';
    counterEl.textContent = '0/0 entregados';
    stopLiveCamera();
    return;
  }

  selectEl.value = activeAct.id;
  detailsBox.classList.remove('hidden');
  noActWarning.classList.add('hidden');
  workspace.classList.remove('hidden');

  typeBadge.textContent = activeAct.tipo;
  document.getElementById('scan-activity-points').textContent = `⭐ ${activeAct.puntos} pts`;
  document.getElementById('scan-activity-group').textContent = `👥 ${activeAct.grupo ? `Grupo ${activeAct.grupo}` : 'Todos los grupos'}`;
  document.getElementById('scan-activity-deadline').textContent = `⏰ ${formatDeadlineDisplay(activeAct.fechaLimite)}`;
  document.getElementById('scan-activity-desc').textContent = activeAct.descripcion || '';

  updateLiveCounterAndDeliveries();
  renderManualStudentSearch();

  const scanTab = document.getElementById('tab-escanear');
  if (scanTab && scanTab.classList.contains('active')) {
    startLiveCamera();
  }
}

function updateLiveCounterAndDeliveries() {
  const activeAct = state.activities.find((a) => a.id === state.activeActivityId);
  if (!activeAct) return;

  const applicableStudents = getApplicableStudentsForActivity(activeAct);
  const deliveriesForAct = state.deliveries.filter((d) => d.activityId === activeAct.id);

  const counterEl = document.getElementById('scan-live-counter');
  counterEl.textContent = `${deliveriesForAct.length}/${applicableStudents.length} entregados`;

  const badgeEl = document.getElementById('recent-count-badge');
  badgeEl.textContent = String(deliveriesForAct.length);

  // Barra Deshacer última entrega
  const undoBar = document.getElementById('undo-bar');
  const lastDelivery = state.deliveries.find((d) => d.id === state.lastDeliveryId);
  if (lastDelivery && lastDelivery.activityId === activeAct.id) {
    const stu = state.students.find((s) => s.id === lastDelivery.studentId);
    document.getElementById('undo-student-name').textContent = stu ? stu.nombre : 'Alumno';
    document.getElementById('undo-time').textContent = `${lastDelivery.formattedDate} (${lastDelivery.status})`;
    undoBar.classList.remove('hidden');
  } else {
    undoBar.classList.add('hidden');
  }

  const listEl = document.getElementById('active-deliveries-list');
  if (deliveriesForAct.length === 0) {
    listEl.innerHTML = '<p class="settings-desc">Aún no hay entregas registradas en esta actividad.</p>';
    return;
  }

  listEl.innerHTML = deliveriesForAct
    .map((d) => {
      const stu = state.students.find((s) => s.id === d.studentId);
      const isLate = d.status === 'Entrega tardía';
      return `
        <div class="delivery-item ${isLate ? 'late' : ''}">
          <div class="delivery-item-info">
            <strong>${escapeHtml(stu ? stu.nombre : d.studentMatricula)}</strong>
            <small>
              ID: ${escapeHtml(stu ? stu.matricula : d.studentMatricula)}
              • ${escapeHtml(d.formattedDate)}
              • <span class="${isLate ? 'status-late' : 'status-ok'}">${escapeHtml(d.status)}</span>
            </small>
          </div>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            data-action="delete-delivery"
            data-id="${d.id}"
            title="Eliminar entrega registrada por error"
          >
            🗑️
          </button>
        </div>
      `;
    })
    .join('');
}

function showScanFeedback(kind, title, studentLine, metaLine) {
  const box = document.getElementById('scan-feedback-box');
  const icon = document.getElementById('feedback-icon');
  const titleEl = document.getElementById('feedback-title');
  const studentEl = document.getElementById('feedback-student');
  const metaEl = document.getElementById('feedback-meta');

  box.classList.remove('hidden', 'feedback-success', 'feedback-warning', 'feedback-error');

  if (kind === 'success') {
    box.classList.add('feedback-success');
    icon.textContent = '✓';
  } else if (kind === 'warning') {
    box.classList.add('feedback-warning');
    icon.textContent = '⚠️';
  } else {
    box.classList.add('feedback-error');
    icon.textContent = '✕';
  }

  titleEl.textContent = title;
  studentEl.textContent = studentLine;
  metaEl.textContent = metaLine;
}

async function processStudentCodeOrId(rawCode, isFromCamera = true) {
  const activeAct = state.activities.find((a) => a.id === state.activeActivityId);
  if (!activeAct) {
    showToast('⚠️ Primero selecciona una actividad activa');
    return;
  }

  const code = String(rawCode || '').trim();
  if (!code) return;

  // Buscar alumno por matrícula o ID interno
  const student = state.students.find(
    (s) =>
      s.matricula.toLowerCase() === code.toLowerCase() ||
      s.id.toLowerCase() === code.toLowerCase()
  );

  if (!student) {
    playBeep('error');
    triggerVibration('error');
    showScanFeedback(
      'error',
      'Código QR no reconocido',
      `Valor leído: "${code}"`,
      'No corresponde a la matrícula de ningún alumno registrado.'
    );
    if (isFromCamera) startScanCooldown();
    return;
  }

  // Verificar si ya entregó esta actividad (evitar duplicados)
  const existingDelivery = state.deliveries.find(
    (d) => d.activityId === activeAct.id && d.studentId === student.id
  );

  if (existingDelivery) {
    playBeep('warning');
    triggerVibration('warning');
    showScanFeedback(
      'warning',
      `Ya entregó el ${existingDelivery.formattedDate}`,
      `${student.nombre} (${student.matricula})`,
      `Actividad: ${activeAct.nombre} • No se registró duplicado.`
    );
    if (isFromCamera) startScanCooldown();
    return;
  }

  // Registrar nueva entrega con fecha y hora exacta de México
  const ts = getMexicoTimestampObj(new Date());
  let status = 'A tiempo';

  if (activeAct.fechaLimite) {
    const deadlineEpoch = new Date(activeAct.fechaLimite).getTime();
    if (!isNaN(deadlineEpoch) && ts.epoch > deadlineEpoch) {
      status = 'Entrega tardía';
    }
  }

  const newDelivery = {
    id: generateId('del'),
    activityId: activeAct.id,
    studentId: student.id,
    studentMatricula: student.matricula,
    isoDate: ts.iso,
    formattedDate: ts.formatted,
    fecha: ts.fecha,
    hora: ts.hora,
    ymd: ts.ymd,
    epoch: ts.epoch,
    status
  };

  await dbPut('deliveries', newDelivery);
  state.deliveries.unshift(newDelivery);
  state.lastDeliveryId = newDelivery.id;

  playBeep('success');
  triggerVibration('success');

  showScanFeedback(
    'success',
    status === 'Entrega tardía' ? 'Registrada (Entrega tardía ⏰)' : '¡Entrega registrada con éxito!',
    `${student.nombre} (${student.matricula})`,
    `${activeAct.nombre} • ${ts.formatted}`
  );

  updateLiveCounterAndDeliveries();
  renderManualStudentSearch();

  if (isFromCamera) {
    startScanCooldown();
  }
}

function startScanCooldown() {
  state.isScanCooldown = true;
  const overlay = document.getElementById('scan-cooldown-overlay');
  overlay.classList.remove('hidden');

  if (state.cooldownTimer) {
    clearTimeout(state.cooldownTimer);
  }
  state.cooldownTimer = setTimeout(() => {
    state.isScanCooldown = false;
    overlay.classList.add('hidden');
  }, 2000);
}

async function startLiveCamera() {
  if (state.isCameraRunning || state.isCameraStarting) return;

  const errorBox = document.getElementById('camera-error-box');
  const fallbackControls = document.getElementById('fallback-file-controls');
  errorBox.classList.add('hidden');
  if (fallbackControls) fallbackControls.classList.add('hidden');

  if (typeof Html5Qrcode === 'undefined') {
    errorBox.classList.remove('hidden');
    if (fallbackControls) fallbackControls.classList.remove('hidden');
    document.getElementById('camera-error-msg').textContent =
      'La librería local html5-qrcode no se pudo inicializar.';
    return;
  }

  state.isCameraStarting = true;
  try {
    if (!state.scanner) {
      state.scanner = new Html5Qrcode('qr-reader');
    }

    const scanConfig = {
      fps: 12,
      qrbox: { width: 240, height: 240 },
      aspectRatio: 1.0
    };
    const onDecode = (decodedText) => {
      if (state.isScanCooldown) return;
      processStudentCodeOrId(decodedText, true);
    };

    try {
      await state.scanner.start({ facingMode: 'environment' }, scanConfig, onDecode, () => {});
    } catch (envErr) {
      // Fallback automático a cualquier cámara disponible (ej. webcam de Mac/laptop)
      await state.scanner.start({ facingMode: 'user' }, scanConfig, onDecode, () => {});
    }

    state.isCameraRunning = true;
  } catch (err) {
    state.isCameraRunning = false;
    errorBox.classList.remove('hidden');
    if (fallbackControls) fallbackControls.classList.remove('hidden');
    document.getElementById('camera-error-msg').textContent =
      `Detalle: ${err?.message || err || 'Permiso de cámara denegado o cámara no disponible.'}`;
  } finally {
    state.isCameraStarting = false;
  }
}

async function stopLiveCamera() {
  if (!state.scanner || !state.isCameraRunning) return;
  try {
    await state.scanner.stop();
  } catch (e) {
    // Ignorar error al detener
  }
  state.isCameraRunning = false;
}

async function handleFileQrScan(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    // Si la cámara en vivo está corriendo, detenerla temporalmente para escanear archivo
    if (state.isCameraRunning) {
      await stopLiveCamera();
    }
    const fileScanner = new Html5Qrcode('qr-file-temp-reader');
    const decodedText = await fileScanner.scanFile(file, true);
    await processStudentCodeOrId(decodedText, false);
    fileScanner.clear();
  } catch (err) {
    playBeep('error');
    triggerVibration('error');
    showScanFeedback(
      'error',
      'No se detectó ningún código QR en la imagen',
      'Intenta tomar la foto más cerca y con buena iluminación.',
      'O bien utiliza el buscador de registro manual abajo.'
    );
  } finally {
    event.target.value = '';
  }
}

function renderManualStudentSearch() {
  const resultsEl = document.getElementById('manual-search-results');
  const query = document.getElementById('manual-student-search').value.trim().toLowerCase();
  const activeAct = state.activities.find((a) => a.id === state.activeActivityId);

  if (!activeAct) {
    resultsEl.innerHTML = '';
    return;
  }

  const pool = getApplicableStudentsForActivity(activeAct);
  const matches = pool
    .filter((s) => {
      if (!query) return true;
      return (
        s.nombre.toLowerCase().includes(query) ||
        s.matricula.toLowerCase().includes(query)
      );
    })
    .slice(0, 12);

  if (matches.length === 0) {
    resultsEl.innerHTML = '<p class="settings-desc">No se encontraron alumnos con ese criterio.</p>';
    return;
  }

  resultsEl.innerHTML = matches
    .map((s) => {
      const delivered = state.deliveries.find(
        (d) => d.activityId === activeAct.id && d.studentId === s.id
      );
      return `
        <div class="manual-student-row">
          <div class="manual-student-info">
            <strong>${escapeHtml(s.nombre)}</strong>
            <small>ID: ${escapeHtml(s.matricula)}${s.grupo ? ` • Grupo ${escapeHtml(s.grupo)}` : ''}</small>
          </div>
          ${
            delivered
              ? `<span class="badge badge-success">✓ Entregó (${escapeHtml(delivered.hora)})</span>`
              : `<button type="button" class="btn btn-primary btn-sm" data-action="manual-deliver" data-matricula="${escapeHtml(s.matricula)}">
                  Registrar
                </button>`
          }
        </div>
      `;
    })
    .join('');
}

async function undoLastDelivery() {
  if (!state.lastDeliveryId) return;
  const del = state.deliveries.find((d) => d.id === state.lastDeliveryId);
  if (!del) return;

  await dbDelete('deliveries', del.id);
  state.lastDeliveryId = null;
  await loadAllDataFromDB();
  updateLiveCounterAndDeliveries();
  renderManualStudentSearch();
  showToast('↩ Última entrega deshecha');
}

async function deleteDeliveryById(deliveryId) {
  const del = state.deliveries.find((d) => d.id === deliveryId);
  if (!del) return;
  const stu = state.students.find((s) => s.id === del.studentId);

  const ok = window.confirm(
    `¿Eliminar la entrega de "${stu ? stu.nombre : del.studentMatricula}" (${del.formattedDate})?`
  );
  if (!ok) return;

  await dbDelete('deliveries', deliveryId);
  if (state.lastDeliveryId === deliveryId) {
    state.lastDeliveryId = null;
  }
  await loadAllDataFromDB();
  renderAll();
  showToast('🗑️ Entrega eliminada');
}

/* ============================================================================
 * 7. SUMATORIA Y REPORTES (TABLA GENERAL, POR ALUMNO, POR ACTIVIDAD)
 * ============================================================================ */

function getFilteredReportContext() {
  const groupVal = document.getElementById('report-filter-group').value;
  const typeVal = document.getElementById('report-filter-type').value;
  const dateFrom = document.getElementById('report-filter-date-from').value;
  const dateTo = document.getElementById('report-filter-date-to').value;
  const studentSearch = document.getElementById('report-filter-student-search').value.trim().toLowerCase();

  const students = state.students.filter((s) => {
    const matchGroup = !groupVal || (s.grupo || '') === groupVal;
    const matchSearch =
      !studentSearch ||
      s.nombre.toLowerCase().includes(studentSearch) ||
      s.matricula.toLowerCase().includes(studentSearch);
    return matchGroup && matchSearch;
  });

  const activities = state.activities.filter((a) => {
    const matchGroup = !groupVal || !a.grupo || a.grupo === groupVal;
    const matchType = !typeVal || a.tipo === typeVal;
    return matchGroup && matchType;
  });

  const deliveries = state.deliveries.filter((d) => {
    if (dateFrom && d.ymd < dateFrom) return false;
    if (dateTo && d.ymd > dateTo) return false;
    return true;
  });

  // Ordenar actividades cronológicamente de más antigua a más reciente para las columnas
  const sortedActivities = [...activities].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return { students, activities: sortedActivities, deliveries };
}

function renderReportsSection() {
  const ctx = getFilteredReportContext();
  renderReportMatrix(ctx);
  renderReportByStudent(ctx);
  renderReportByActivity(ctx);
}

function renderReportMatrix({ students, activities, deliveries }) {
  const container = document.getElementById('report-matrix-container');

  if (students.length === 0 || activities.length === 0) {
    container.innerHTML = `
      <p class="settings-desc">
        Registra alumnos y actividades (o ajusta los filtros) para visualizar la Tabla General.
      </p>
    `;
    return;
  }

  const totalPossiblePoints = activities.reduce((acc, a) => acc + (Number(a.puntos) || 0), 0);

  let html = `
    <table class="matrix-table">
      <thead>
        <tr>
          <th class="student-col">Alumno (Matrícula)</th>
          <th>Grupo</th>
          ${activities.map((a) => `<th title="${escapeHtml(a.descripcion || a.tipo)}">${escapeHtml(a.nombre)}<br/><small>(${a.puntos} pts)</small></th>`).join('')}
          <th>Entregadas</th>
          <th>Puntos</th>
          <th>%</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const s of students) {
    let deliveredCount = 0;
    let earnedPoints = 0;

    const cellsHtml = activities
      .map((a) => {
        const del = deliveries.find((d) => d.studentId === s.id && d.activityId === a.id);
        if (!del) {
          return `<td class="status-miss" title="No entregado">✗</td>`;
        }
        deliveredCount++;
        earnedPoints += Number(a.puntos) || 0;
        if (del.status === 'Entrega tardía') {
          return `<td class="status-late" title="Entrega tardía: ${escapeHtml(del.formattedDate)}">⏰</td>`;
        }
        return `<td class="status-ok" title="Entregado a tiempo: ${escapeHtml(del.formattedDate)}">✓</td>`;
      })
      .join('');

    const pct = activities.length > 0 ? Math.round((deliveredCount / activities.length) * 100) : 0;

    html += `
      <tr>
        <td class="student-col">
          <strong>${escapeHtml(s.nombre)}</strong><br/>
          <small>${escapeHtml(s.matricula)}</small>
        </td>
        <td>${escapeHtml(s.grupo || '-')}</td>
        ${cellsHtml}
        <td><strong>${deliveredCount}/${activities.length}</strong></td>
        <td><strong>${earnedPoints}/${totalPossiblePoints}</strong></td>
        <td><strong>${pct}%</strong></td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderReportByStudent({ students, activities, deliveries }) {
  const listEl = document.getElementById('report-students-cards');

  if (students.length === 0) {
    listEl.innerHTML = '<div class="card"><p class="settings-desc">No hay alumnos que coincidan con el filtro.</p></div>';
    return;
  }

  const totalPointsPossible = activities.reduce((sum, a) => sum + (Number(a.puntos) || 0), 0);

  listEl.innerHTML = students
    .map((s) => {
      const stuDeliveries = deliveries.filter(
        (d) => d.studentId === s.id && activities.some((a) => a.id === d.activityId)
      );
      const deliveredCount = stuDeliveries.length;
      const lateCount = stuDeliveries.filter((d) => d.status === 'Entrega tardía').length;
      const pointsEarned = stuDeliveries.reduce((sum, d) => {
        const act = activities.find((a) => a.id === d.activityId);
        return sum + (Number(act?.puntos) || 0);
      }, 0);
      const pct = activities.length > 0 ? Math.round((deliveredCount / activities.length) * 100) : 0;

      return `
        <div class="item-card">
          <div class="item-card-header">
            <div>
              <div class="item-card-title">${escapeHtml(s.nombre)}</div>
              <div class="item-card-meta">
                <span class="badge badge-primary">ID: ${escapeHtml(s.matricula)}</span>
                ${s.grupo ? `<span class="badge">Grupo ${escapeHtml(s.grupo)}</span>` : ''}
              </div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-action="student-history" data-id="${s.id}">
              📋 Ver historial
            </button>
          </div>
          <div class="stats-pills">
            <div class="stat-pill">
              <span>Entregas</span>
              <strong>${deliveredCount} / ${activities.length} (${pct}%)</strong>
            </div>
            <div class="stat-pill">
              <span>Puntos acumulados</span>
              <strong>${pointsEarned} / ${totalPointsPossible} pts</strong>
            </div>
            <div class="stat-pill">
              <span>A tiempo</span>
              <strong>${deliveredCount - lateCount}</strong>
            </div>
            <div class="stat-pill">
              <span>Entregas tardías ⏰</span>
              <strong>${lateCount}</strong>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderReportByActivity({ students, activities, deliveries }) {
  const selectEl = document.getElementById('report-select-single-activity');
  const container = document.getElementById('report-activity-detail-container');

  const currentVal = selectEl.value;
  selectEl.innerHTML = '';

  if (activities.length === 0) {
    selectEl.innerHTML = '<option value="">Sin actividades</option>';
    container.innerHTML = '<div class="card"><p class="settings-desc">No hay actividades para mostrar.</p></div>';
    return;
  }

  for (const a of activities) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.nombre} (${a.tipo})`;
    selectEl.appendChild(opt);
  }

  if (activities.some((a) => a.id === currentVal)) {
    selectEl.value = currentVal;
  } else {
    selectEl.value = activities[activities.length - 1].id;
  }

  const selectedAct = activities.find((a) => a.id === selectEl.value);
  if (!selectedAct) return;

  const targetStudents = students.filter(
    (s) => !selectedAct.grupo || (s.grupo || '').toLowerCase() === selectedAct.grupo.toLowerCase()
  );

  const deliveredRows = [];
  const missingRows = [];

  for (const s of targetStudents) {
    const del = deliveries.find((d) => d.activityId === selectedAct.id && d.studentId === s.id);
    if (del) {
      deliveredRows.push({ student: s, delivery: del });
    } else {
      missingRows.push(s);
    }
  }

  container.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(selectedAct.nombre)}</h3>
      <p class="settings-desc">
        Tipo: <strong>${escapeHtml(selectedAct.tipo)}</strong> •
        Valor: <strong>${selectedAct.puntos} pts</strong> •
        Entregaron: <strong>${deliveredRows.length} de ${targetStudents.length}</strong> •
        Faltan: <strong>${missingRows.length}</strong>
      </p>

      <h4 style="margin: 12px 0 8px;">✅ Quiénes YA entregaron (${deliveredRows.length})</h4>
      <div class="deliveries-list">
        ${
          deliveredRows.length === 0
            ? '<p class="settings-desc">Nadie ha entregado aún.</p>'
            : deliveredRows
                .map(
                  ({ student, delivery }) => `
                  <div class="delivery-item ${delivery.status === 'Entrega tardía' ? 'late' : ''}">
                    <div class="delivery-item-info">
                      <strong>${escapeHtml(student.nombre)} (${escapeHtml(student.matricula)})</strong>
                      <small>${escapeHtml(delivery.formattedDate)} • ${escapeHtml(delivery.status)}</small>
                    </div>
                    <button type="button" class="btn btn-danger btn-sm" data-action="delete-delivery" data-id="${delivery.id}">
                      🗑️
                    </button>
                  </div>
                `
                )
                .join('')
        }
      </div>

      <h4 style="margin: 16px 0 8px;">❌ Quiénes NO han entregado (${missingRows.length})</h4>
      <div class="deliveries-list">
        ${
          missingRows.length === 0
            ? '<p class="settings-desc">¡Todos los alumnos entregaron esta actividad!</p>'
            : missingRows
                .map(
                  (s) => `
                  <div class="manual-student-row">
                    <div class="manual-student-info">
                      <strong>${escapeHtml(s.nombre)}</strong>
                      <small>ID: ${escapeHtml(s.matricula)}${s.grupo ? ` • Grupo ${escapeHtml(s.grupo)}` : ''}</small>
                    </div>
                    <span class="badge badge-warning">Pendiente</span>
                  </div>
                `
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function openStudentHistoryModal(studentId) {
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return;

  document.getElementById('student-history-title').textContent = `${student.nombre} (${student.matricula})`;

  const applicableActivities = state.activities.filter(
    (a) => !a.grupo || (student.grupo || '').toLowerCase() === a.grupo.toLowerCase()
  );
  const stuDeliveries = state.deliveries.filter((d) => d.studentId === student.id);
  const lateCount = stuDeliveries.filter((d) => d.status === 'Entrega tardía').length;

  const earnedPoints = stuDeliveries.reduce((sum, d) => {
    const act = state.activities.find((a) => a.id === d.activityId);
    return sum + (Number(act?.puntos) || 0);
  }, 0);
  const totalPoints = applicableActivities.reduce((sum, a) => sum + (Number(a.puntos) || 0), 0);
  const pct =
    applicableActivities.length > 0
      ? Math.round((stuDeliveries.length / applicableActivities.length) * 100)
      : 0;

  document.getElementById('student-history-summary').innerHTML = `
    <div class="stat-pill"><span>Actividades entregadas</span><strong>${stuDeliveries.length} / ${applicableActivities.length} (${pct}%)</strong></div>
    <div class="stat-pill"><span>Puntos acumulados</span><strong>${earnedPoints} / ${totalPoints} pts</strong></div>
    <div class="stat-pill"><span>Entregas a tiempo</span><strong>${stuDeliveries.length - lateCount}</strong></div>
    <div class="stat-pill"><span>Entregas tardías</span><strong>${lateCount}</strong></div>
  `;

  const listEl = document.getElementById('student-history-list');
  if (stuDeliveries.length === 0) {
    listEl.innerHTML = '<p class="settings-desc">Este alumno no tiene entregas registradas.</p>';
  } else {
    listEl.innerHTML = stuDeliveries
      .map((d) => {
        const act = state.activities.find((a) => a.id === d.activityId);
        const isLate = d.status === 'Entrega tardía';
        return `
          <div class="delivery-item ${isLate ? 'late' : ''}">
            <div class="delivery-item-info">
              <strong>${escapeHtml(act ? act.nombre : 'Actividad eliminada')}</strong>
              <small>
                ${escapeHtml(d.formattedDate)} •
                ${act ? `${act.puntos} pts • ` : ''}
                <span class="${isLate ? 'status-late' : 'status-ok'}">${escapeHtml(d.status)}</span>
              </small>
            </div>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-delivery" data-id="${d.id}">
              🗑️
            </button>
          </div>
        `;
      })
      .join('');
  }

  document.getElementById('modal-student-history').classList.remove('hidden');
}

/* ============================================================================
 * 8. RESPALDO, EXPORTACIÓN A CSV (UTF-8 CON BOM) Y BORRADO SEGURO
 * ============================================================================ */

function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCsvWithBom(filename, rows) {
  const csvContent = rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportDeliveriesToCSV() {
  // Columnas requeridas: matrícula, alumno, grupo, actividad, descripción, tipo, puntos, fecha, hora, estado (a tiempo/tardía)
  const headers = [
    'matrícula',
    'alumno',
    'grupo',
    'actividad',
    'descripción',
    'tipo',
    'puntos',
    'fecha',
    'hora',
    'estado'
  ];

  const rows = [headers];

  for (const d of state.deliveries) {
    const stu = state.students.find((s) => s.id === d.studentId);
    const act = state.activities.find((a) => a.id === d.activityId);

    rows.push([
      stu ? stu.matricula : d.studentMatricula,
      stu ? stu.nombre : 'Alumno eliminado',
      stu?.grupo || '',
      act ? act.nombre : 'Actividad eliminada',
      act?.descripcion || '',
      act?.tipo || '',
      act ? act.puntos : '',
      d.fecha || d.formattedDate.split(' ')[0] || '',
      d.hora || d.formattedDate.split(' ')[1] || '',
      d.status === 'Entrega tardía' ? 'tardía' : 'a tiempo'
    ]);
  }

  const ts = getMexicoTimestampObj();
  downloadCsvWithBom(`entregas_qr_${ts.ymd}.csv`, rows);
  showToast('📊 CSV de entregas descargado (compatible con Excel)');
}

function exportGeneralMatrixToCSV() {
  const { students, activities, deliveries } = getFilteredReportContext();
  if (students.length === 0) {
    showToast('⚠️ No hay datos en la tabla general para exportar');
    return;
  }

  const headers = [
    'Matrícula',
    'Alumno',
    'Grupo',
    ...activities.map((a) => `${a.nombre} (${a.puntos} pts)`),
    'Total Entregadas',
    'Total Actividades',
    'Puntos Acumulados',
    'Porcentaje'
  ];

  const rows = [headers];

  for (const s of students) {
    let count = 0;
    let points = 0;

    const activityCells = activities.map((a) => {
      const del = deliveries.find((d) => d.studentId === s.id && d.activityId === a.id);
      if (!del) return '✗';
      count++;
      points += Number(a.puntos) || 0;
      return del.status === 'Entrega tardía' ? '⏰' : '✓';
    });

    const pct = activities.length > 0 ? `${Math.round((count / activities.length) * 100)}%` : '0%';

    rows.push([
      s.matricula,
      s.nombre,
      s.grupo || '',
      ...activityCells,
      count,
      activities.length,
      points,
      pct
    ]);
  }

  const ts = getMexicoTimestampObj();
  downloadCsvWithBom(`tabla_general_qr_${ts.ymd}.csv`, rows);
  showToast('📋 CSV de Tabla General descargado');
}

async function exportFullJsonBackup() {
  const ts = getMexicoTimestampObj();
  const payload = {
    app: 'registro-qr',
    version: 1,
    exportedAt: ts.iso,
    exportedAtFormatted: ts.formatted,
    students: state.students,
    activities: state.activities,
    deliveries: state.deliveries
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `respaldo_registro_qr_${ts.ymd}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  await saveSetting('lastBackupEpoch', Date.now());
  await saveSetting('lastBackupFormatted', ts.formatted);
  updateBackupStatusUI();
  document.getElementById('backup-reminder-banner').classList.add('hidden');
  showToast('💾 Respaldo JSON descargado correctamente');
}

async function handleImportJsonBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (
      !data ||
      !Array.isArray(data.students) ||
      !Array.isArray(data.activities) ||
      !Array.isArray(data.deliveries)
    ) {
      showToast('❌ El archivo JSON no tiene un formato de respaldo válido');
      return;
    }

    const confirmImport = window.confirm(
      `Se restaurarán ${data.students.length} alumnos, ${data.activities.length} actividades y ${data.deliveries.length} entregas. ¿Deseas continuar?`
    );
    if (!confirmImport) return;

    await dbClearStore('students');
    await dbClearStore('activities');
    await dbClearStore('deliveries');

    for (const s of data.students) await dbPut('students', s);
    for (const a of data.activities) await dbPut('activities', a);
    for (const d of data.deliveries) await dbPut('deliveries', d);

    await loadAllDataFromDB();
    renderAll();
    showToast('✅ Respaldo restaurado exitosamente');
  } catch (err) {
    showToast('❌ Error al leer el archivo de respaldo JSON');
  } finally {
    event.target.value = '';
  }
}

function updateBackupStatusUI() {
  const infoEl = document.getElementById('last-backup-info');
  if (!infoEl) return;
  if (state.settings.lastBackupFormatted) {
    infoEl.textContent = `Último respaldo: ${state.settings.lastBackupFormatted}`;
  } else {
    infoEl.textContent = 'Último respaldo: Nunca';
  }
}

function checkBackupReminder() {
  const hasData =
    state.students.length > 0 || state.activities.length > 0 || state.deliveries.length > 0;
  if (!hasData) return;

  const lastEpoch = Number(state.settings.lastBackupEpoch || 0);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (!lastEpoch || now - lastEpoch > sevenDaysMs) {
    document.getElementById('backup-reminder-banner').classList.remove('hidden');
  }
}

async function handleWipeAllDataSubmit(event) {
  event.preventDefault();
  const c1 = document.getElementById('wipe-confirm-check-1').checked;
  const c2 = document.getElementById('wipe-confirm-check-2').checked;

  if (!c1 || !c2) {
    showToast('⚠️ Debes marcar ambas casillas de confirmación');
    return;
  }

  await dbClearStore('students');
  await dbClearStore('activities');
  await dbClearStore('deliveries');

  state.activeActivityId = '';
  state.lastDeliveryId = null;
  await saveSetting('activeActivityId', '');

  await loadAllDataFromDB();
  document.getElementById('form-wipe-data').reset();
  closeModal('modal-wipe-data');
  renderAll();
  showToast('🗑️ Todos los datos han sido eliminados');
}

/* ============================================================================
 * 9. SERVICE WORKER Y AVISO DE ACTUALIZACIÓN
 * ============================================================================ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const doRegister = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');

      if (reg.waiting) {
        showUpdateBanner(reg.waiting);
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    } catch (err) {
      // Service worker falló o entorno sin soporte
    }
  };

  if (document.readyState === 'complete') {
    doRegister();
  } else {
    window.addEventListener('load', doRegister);
  }
}

function showUpdateBanner(worker) {
  state.waitingWorker = worker;
  const banner = document.getElementById('update-banner');
  banner.classList.remove('hidden');
}

/* ============================================================================
 * 10. NAVEGACIÓN, TEMA OSCURO Y EVENTOS DE INTERFAZ
 * ============================================================================ */

function switchTab(tabId) {
  document.querySelectorAll('.tab-view').forEach((sec) => {
    sec.classList.toggle('active', sec.id === tabId);
  });
  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  if (tabId !== 'tab-escanear' && state.isCameraRunning) {
    stopLiveCamera();
  }

  renderAll();
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('hidden');
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-mode', isDark);
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

function renderAll() {
  populateGroupDropdowns();
  renderScannerHeaderAndWorkspace();
  renderActivitiesList();
  renderStudentsList();
  renderReportsSection();
  updateBackupStatusUI();
}

function bindEvents() {
  // Modo oscuro
  document.getElementById('btn-theme-toggle').addEventListener('click', async () => {
    const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
    applyTheme(nextTheme);
    await saveSetting('theme', nextTheme);
  });

  // Banner de actualización SW
  document.getElementById('update-banner').addEventListener('click', () => {
    if (state.waitingWorker) {
      state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  });

  // Banner recordatorio de respaldo
  document.getElementById('btn-banner-backup').addEventListener('click', exportFullJsonBackup);
  document.getElementById('btn-banner-dismiss').addEventListener('click', () => {
    document.getElementById('backup-reminder-banner').classList.add('hidden');
  });

  // Navegación inferior
  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Pestaña Escanear
  document.getElementById('select-active-activity').addEventListener('change', async (e) => {
    state.activeActivityId = e.target.value;
    await saveSetting('activeActivityId', state.activeActivityId);
    renderScannerHeaderAndWorkspace();
  });

  document.getElementById('btn-quick-new-activity').addEventListener('click', () => openActivityModal());
  document.getElementById('btn-goto-create-activity').addEventListener('click', () => openActivityModal());
  document.getElementById('qr-file-input').addEventListener('change', handleFileQrScan);
  document.getElementById('btn-undo-last').addEventListener('click', undoLastDelivery);
  document.getElementById('manual-student-search').addEventListener('input', renderManualStudentSearch);

  // Pestaña Actividades
  document.getElementById('btn-open-activity-modal').addEventListener('click', () => openActivityModal());
  document.getElementById('form-activity').addEventListener('submit', handleSaveActivity);
  document.getElementById('filter-activities-search').addEventListener('input', renderActivitiesList);
  document.getElementById('filter-activities-type').addEventListener('change', renderActivitiesList);
  document.getElementById('filter-activities-group').addEventListener('change', renderActivitiesList);

  // Pestaña Alumnos
  document.getElementById('quick-excel-upload').addEventListener('change', handleQuickExcelUpload);
  document.getElementById('btn-open-student-modal').addEventListener('click', () => openStudentModal());
  document.getElementById('form-student').addEventListener('submit', handleSaveStudent);
  document.getElementById('filter-students-search').addEventListener('input', renderStudentsList);
  document.getElementById('filter-students-group').addEventListener('change', renderStudentsList);

  document.getElementById('btn-open-import-modal').addEventListener('click', () => {
    document.getElementById('modal-import-students').classList.remove('hidden');
  });
  document.getElementById('form-import-students').addEventListener('submit', handleImportStudents);
  document.getElementById('import-csv-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const lines = await readSpreadsheetFileToLines(file);
      document.getElementById('import-students-textarea').value = lines.join('\n');
      showToast(`📗 ${lines.length} alumnos detectados del archivo Excel`);
    } catch (err) {
      showToast('❌ Error al leer el archivo');
    }
  });

  document.getElementById('btn-download-single-qr').addEventListener('click', downloadSingleStudentQR);

  // Credenciales QR e Impresión Carta
  document.getElementById('btn-open-print-view').addEventListener('click', openPrintCredentialsView);
  document.getElementById('print-filter-group').addEventListener('change', renderPrintCredentialsSheet);
  document.getElementById('btn-trigger-print').addEventListener('click', () => window.print());
  document.getElementById('btn-download-qr-sheet-png').addEventListener('click', downloadCredentialsSheetAsPNG);
  document.getElementById('btn-close-print-view').addEventListener('click', () => {
    document.getElementById('print-sheet-overlay').classList.add('hidden');
  });

  // Pestaña Reportes
  document.querySelectorAll('.subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.reportView;
      document.getElementById('report-view-matrix').classList.toggle('hidden', view !== 'matrix');
      document.getElementById('report-view-by-student').classList.toggle('hidden', view !== 'by-student');
      document.getElementById('report-view-by-activity').classList.toggle('hidden', view !== 'by-activity');
    });
  });

  ['report-filter-group', 'report-filter-type', 'report-filter-date-from', 'report-filter-date-to'].forEach((id) => {
    document.getElementById(id).addEventListener('change', renderReportsSection);
  });
  document.getElementById('report-filter-student-search').addEventListener('input', renderReportsSection);
  document.getElementById('report-select-single-activity').addEventListener('change', () => {
    renderReportByActivity(getFilteredReportContext());
  });

  document.getElementById('btn-export-deliveries-csv').addEventListener('click', exportDeliveriesToCSV);
  document.getElementById('btn-export-matrix-csv').addEventListener('click', exportGeneralMatrixToCSV);

  // Pestaña Configuración
  document.getElementById('btn-settings-csv-deliveries').addEventListener('click', exportDeliveriesToCSV);
  document.getElementById('btn-settings-csv-matrix').addEventListener('click', exportGeneralMatrixToCSV);
  document.getElementById('btn-export-json-backup').addEventListener('click', exportFullJsonBackup);
  document.getElementById('input-import-json-backup').addEventListener('change', handleImportJsonBackup);

  document.getElementById('btn-wipe-all-data').addEventListener('click', () => {
    document.getElementById('form-wipe-data').reset();
    document.getElementById('modal-wipe-data').classList.remove('hidden');
  });
  document.getElementById('form-wipe-data').addEventListener('submit', handleWipeAllDataSubmit);

  // Cerrar modales
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });

  // Delegación global de botones de acción en tarjetas y listas
  document.body.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('[data-action]');
    if (!actionBtn) return;

    const action = actionBtn.dataset.action;
    const id = actionBtn.dataset.id;

    if (action === 'view-qr') {
      openSingleStudentQR(id);
    } else if (action === 'edit-student') {
      const stu = state.students.find((s) => s.id === id);
      if (stu) openStudentModal(stu);
    } else if (action === 'delete-student') {
      await deleteStudent(id);
    } else if (action === 'student-history') {
      openStudentHistoryModal(id);
    } else if (action === 'scan-this-activity') {
      state.activeActivityId = id;
      await saveSetting('activeActivityId', id);
      switchTab('tab-escanear');
    } else if (action === 'edit-activity') {
      const act = state.activities.find((a) => a.id === id);
      if (act) openActivityModal(act);
    } else if (action === 'duplicate-activity') {
      await duplicateActivity(id);
    } else if (action === 'delete-activity') {
      await deleteActivity(id);
    } else if (action === 'manual-deliver') {
      const mat = actionBtn.dataset.matricula;
      await processStudentCodeOrId(mat, false);
    } else if (action === 'delete-delivery') {
      await deleteDeliveryById(id);
    }
  });
}

/* ============================================================================
 * 11. INICIALIZACIÓN DE LA APLICACIÓN
 * ============================================================================ */

async function initApp() {
  try {
    state.db = await openDatabase();
    await loadAllDataFromDB();

    const savedTheme = state.settings.theme || 'dark';
    applyTheme(savedTheme);

    bindEvents();
    renderAll();
    checkBackupReminder();
    registerServiceWorker();
  } catch (err) {
    console.error('Error inicializando la aplicación:', err);
  }
}

document.addEventListener('DOMContentLoaded', initApp);
