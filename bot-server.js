// ============================================================
// AutoEscuela WhatsApp Bot — bot-server.js
// Supabase (con fallback a JSON local si no hay credenciales)
// ============================================================

require('dotenv').config();

const express = require('express');
const twilio  = require('twilio');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');

// ── Supabase (opcional) ───────────────────────────────────
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
let supabase = null;

if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  console.log('✅ Modo Supabase activado');
} else {
  console.log('⚠️  Sin credenciales Supabase → usando archivos JSON locales');
}

const SCHOOL_ID = process.env.SCHOOL_ID || null;

// ── Nombre de la escuela (leído de Supabase, con fallback) ──
let SCHOOL_NAME = process.env.SCHOOL_NAME || 'Autoescuela Exit';
async function refreshSchoolName() {
  if (!USE_SUPABASE || !SCHOOL_ID) return;
  try {
    const { data } = await supabase.from('schools').select('name').eq('id', SCHOOL_ID).single();
    if (data?.name) SCHOOL_NAME = data.name;
  } catch (e) {}
}

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Twilio ────────────────────────────────────────────────
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const SANDBOX_NUM = process.env.TWILIO_SANDBOX_NUM || 'whatsapp:+14155238886';
// Sin credenciales el bot arranca igualmente (API REST disponible), solo
// que no puede enviar WhatsApp — evita crash-loop en Railway antes de
// configurar las variables secretas.
const client = (ACCOUNT_SID && AUTH_TOKEN) ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;
if (!client) console.log('⚠️  Sin credenciales Twilio → envío de WhatsApp desactivado');

// ── Notificaciones ────────────────────────────────────────
const NOTIFY_ADMIN = process.env.NOTIFY_ADMIN || '+34644299702';

// ── Archivos JSON de fallback ─────────────────────────────
const STUDENTS_FILE  = path.join(__dirname, 'crm_students.json');
const SLOTS_FILE     = path.join(__dirname, 'crm_slots.json');
const BLOCKED_FILE   = path.join(__dirname, 'crm_blocked.json');
const AVAIL_FILE     = path.join(__dirname, 'crm_availability.json');

// ── Constantes de disponibilidad ─────────────────────────
const HOURS_DEFAULT = ['09:00','10:00','11:00','12:00','16:00','17:00','18:00','19:00'];
const DAY_KEY_MAP   = { 1:'lun', 2:'mar', 3:'mie', 4:'jue', 5:'vie', 6:'sab' };

// ── Conversaciones activas (siempre en RAM) ───────────────
const pending = {};

// ── Normalización de teléfonos ────────────────────────────
// Las autoescuelas escriben los números sin prefijo ("644299702"):
// añadimos +34 a los números españoles de 9 cifras para que Twilio
// y las claves de `pending` coincidan siempre.
function normalizePhone(p) {
  if (!p) return p;
  let s = String(p).replace(/[\s\-\.\(\)]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (/^[679]\d{8}$/.test(s))      s = '+34' + s; // móvil/fijo España
    else if (/^34\d{9}$/.test(s))    s = '+' + s;
  }
  return s;
}

// ════════════════════════════════════════════════════════════
// CAPA DE DATOS — async, con Supabase o JSON según config
// ════════════════════════════════════════════════════════════

// ── Students ──────────────────────────────────────────────
async function loadStudents() {
  if (USE_SUPABASE) {
    const q = supabase.from('students').select('*');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadStudents:', error.message); return []; }
    // Normalizar nombres de campos snake_case → camelCase para compatibilidad
    return (data || []).map(normalizeStudent);
  }
  try {
    if (fs.existsSync(STUDENTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
      return arr.map(s => ({ ...s, phone: normalizePhone(s.phone) }));
    }
  } catch (e) {}
  return [
    { id: 's1', name: 'Carlos Mendoza',  phone: '+34644299702', profId: 'prof_inaki',  active: true, botActive: true },
    { id: 's2', name: 'Laura Fernández', phone: '+34600000001', profId: 'prof_carlos', active: true, botActive: true },
  ];
}

async function saveStudents(students) {
  if (USE_SUPABASE) return; // Supabase: las actualizaciones se hacen por registro
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(students, null, 2));
}

async function updateStudent(studentId, fields) {
  if (USE_SUPABASE) {
    // Convertir camelCase → snake_case para Supabase
    const dbFields = denormalizeStudent(fields);
    const { data, error } = await supabase
      .from('students')
      .update(dbFields)
      .eq('id', studentId)
      .select()
      .single();
    if (error) { console.error('Supabase updateStudent:', error.message); return null; }
    return normalizeStudent(data);
  }
  const students = await loadStudents();
  const idx = students.findIndex(s => s.id === studentId);
  if (idx < 0) return null;
  students[idx] = { ...students[idx], ...fields };
  await saveStudents(students);
  return students[idx];
}

// ── Slots ─────────────────────────────────────────────────
async function loadSlots() {
  if (USE_SUPABASE) {
    const q = supabase.from('slots').select('*');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadSlots:', error.message); return []; }
    return (data || []).map(normalizeSlot);
  }
  try {
    if (fs.existsSync(SLOTS_FILE)) return JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

async function saveSlots(slots) {
  if (USE_SUPABASE) return; // Supabase: las actualizaciones se hacen por registro
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2));
}

async function insertSlot(slot) {
  if (USE_SUPABASE) {
    const dbSlot = denormalizeSlot(slot);
    if (SCHOOL_ID) dbSlot.school_id = SCHOOL_ID;
    const { data, error } = await supabase
      .from('slots')
      .insert(dbSlot)
      .select()
      .single();
    if (error) { console.error('Supabase insertSlot:', error.message); return null; }
    return normalizeSlot(data);
  }
  const slots = await loadSlots();
  slots.push(slot);
  await saveSlots(slots);
  return slot;
}

async function updateSlot(slotId, fields) {
  if (USE_SUPABASE) {
    const dbFields = denormalizeSlot(fields);
    const { data, error } = await supabase
      .from('slots')
      .update(dbFields)
      .eq('id', slotId)
      .select()
      .single();
    if (error) { console.error('Supabase updateSlot:', error.message); return null; }
    return normalizeSlot(data);
  }
  const slots = await loadSlots();
  const idx = slots.findIndex(s => s.id === slotId);
  if (idx < 0) return null;
  slots[idx] = { ...slots[idx], ...fields };
  await saveSlots(slots);
  return slots[idx];
}

async function deleteSlot(slotId) {
  if (USE_SUPABASE) {
    // Obtener antes de borrar para devolver el objeto eliminado
    const { data: removed } = await supabase
      .from('slots')
      .select('*')
      .eq('id', slotId)
      .single();
    const { error } = await supabase
      .from('slots')
      .delete()
      .eq('id', slotId);
    if (error) { console.error('Supabase deleteSlot:', error.message); return null; }
    return removed ? normalizeSlot(removed) : null;
  }
  const slots = await loadSlots();
  const idx = slots.findIndex(s => s.id === slotId);
  if (idx < 0) return null;
  const [removed] = slots.splice(idx, 1);
  await saveSlots(slots);
  return removed;
}

async function upsertSlot(slot) {
  if (USE_SUPABASE) {
    const dbSlot = denormalizeSlot(slot);
    if (SCHOOL_ID) dbSlot.school_id = SCHOOL_ID;
    const { data, error } = await supabase
      .from('slots')
      .upsert(dbSlot, { onConflict: 'id' })
      .select()
      .single();
    if (error) { console.error('Supabase upsertSlot:', error.message); return null; }
    return normalizeSlot(data);
  }
  const slots = await loadSlots();
  const idx = slots.findIndex(s => s.id === slot.id);
  if (idx >= 0) slots[idx] = { ...slots[idx], ...slot };
  else slots.push(slot);
  await saveSlots(slots);
  return slot;
}

// ── Availability ──────────────────────────────────────────
async function loadAvailability() {
  if (USE_SUPABASE) {
    const q = supabase.from('availability').select('prof_id, day_key, hours');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadAvailability:', error.message); return null; }
    if (!data || !data.length) return null;
    // Convertir a formato { profId: { lun: [...], mar: [...] } }
    const avail = {};
    for (const row of data) {
      if (!avail[row.prof_id]) avail[row.prof_id] = {};
      avail[row.prof_id][row.day_key] = row.hours;
    }
    return avail;
  }
  try {
    if (fs.existsSync(AVAIL_FILE)) return JSON.parse(fs.readFileSync(AVAIL_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

// ── Días de examen (bloquean el día entero para clases) ───
async function loadExamDays() {
  if (USE_SUPABASE) {
    const q = supabase.from('school_config').select('extra_config');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadExamDays:', error.message); return []; }
    const ec = data?.[0]?.extra_config;
    return Array.isArray(ec?.exam_days) ? ec.exam_days.map(d => String(d).substring(0, 10)) : [];
  }
  return [];
}

// ── Blocked hours ─────────────────────────────────────────
async function loadBlocked() {
  if (USE_SUPABASE) {
    const q = supabase.from('blocked_hours').select('prof_id, date, hour');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadBlocked:', error.message); return {}; }
    const blocked = {};
    for (const row of data) {
      // Normalizar hora: Supabase devuelve TIME como "10:00:00", necesitamos "10:00"
      const hour = (row.hour || '').substring(0, 5);
      blocked[`${row.prof_id}_${row.date}_${hour}`] = true;
    }
    return blocked;
  }
  try {
    if (fs.existsSync(BLOCKED_FILE)) return JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

// ════════════════════════════════════════════════════════════
// NORMALIZADORES (snake_case ↔ camelCase)
// ════════════════════════════════════════════════════════════

function normalizeStudent(row) {
  if (!row) return null;
  return {
    id:          row.id,
    schoolId:    row.school_id,
    profId:      row.prof_id,
    name:        row.name,
    phone:       normalizePhone(row.phone),
    vehicleType: row.vehicle_type,
    numClases:   row.num_clases,
    active:      row.active,
    botActive:   row.bot_active,
    examDate:    row.exam_date,
    examResult:  row.exam_result,
    // campos JSON legacy (por si acaso)
    ...(row.profId      !== undefined ? { profId:    row.profId }    : {}),
    ...(row.botActive   !== undefined ? { botActive: row.botActive } : {}),
    ...(row.numClases   !== undefined ? { numClases: row.numClases } : {}),
  };
}

function denormalizeStudent(obj) {
  const out = {};
  if (obj.profId      !== undefined) out.prof_id      = obj.profId;
  if (obj.prof_id     !== undefined) out.prof_id      = obj.prof_id;
  if (obj.name        !== undefined) out.name         = obj.name;
  if (obj.phone       !== undefined) out.phone        = obj.phone;
  if (obj.vehicleType !== undefined) out.vehicle_type = obj.vehicleType;
  if (obj.vehicle_type!== undefined) out.vehicle_type = obj.vehicle_type;
  if (obj.numClases   !== undefined) out.num_clases   = obj.numClases;
  if (obj.num_clases  !== undefined) out.num_clases   = obj.num_clases;
  if (obj.active      !== undefined) out.active       = obj.active;
  if (obj.botActive   !== undefined) out.bot_active   = obj.botActive;
  if (obj.bot_active  !== undefined) out.bot_active   = obj.bot_active;
  if (obj.examDate    !== undefined) out.exam_date    = obj.examDate;
  if (obj.exam_date   !== undefined) out.exam_date    = obj.exam_date;
  if (obj.examResult  !== undefined) out.exam_result  = obj.examResult;
  if (obj.exam_result !== undefined) out.exam_result  = obj.exam_result;
  return out;
}

function normalizeSlot(row) {
  if (!row) return null;
  // Normalizar time: Supabase devuelve TIME como "10:00:00"
  const time = row.time ? String(row.time).substring(0, 5) : row.time;
  return {
    id:           row.id,
    schoolId:     row.school_id,
    studentId:    row.student_id  ?? row.studentId,
    profId:       row.prof_id     ?? row.profId,
    date:         row.date ? String(row.date).substring(0, 10) : row.date,
    time:         time,
    duration:     row.duration,
    slotType:     row.slot_type   ?? row.slotType   ?? row.type,
    type:         row.slot_type   ?? row.slotType   ?? row.type,
    status:       row.status,
    reminderSent: row.reminder_sent ?? row.reminderSent,
    createdBy:    row.created_by  ?? row.createdBy,
    dayName:      row.dayName     ?? row.day_name,
  };
}

function denormalizeSlot(obj) {
  const out = {};
  if (obj.id          !== undefined) out.id           = obj.id;
  if (obj.studentId   !== undefined) out.student_id   = obj.studentId;
  if (obj.student_id  !== undefined) out.student_id   = obj.student_id;
  if (obj.profId      !== undefined) out.prof_id      = obj.profId;
  if (obj.prof_id     !== undefined) out.prof_id      = obj.prof_id;
  if (obj.date        !== undefined) out.date         = obj.date;
  if (obj.time        !== undefined) out.time         = obj.time;
  if (obj.duration    !== undefined) out.duration     = obj.duration;
  const slotType = obj.slotType ?? obj.slot_type ?? obj.type;
  if (slotType        !== undefined) out.slot_type    = slotType;
  if (obj.status      !== undefined) out.status       = obj.status;
  const reminderSent = obj.reminderSent ?? obj.reminder_sent;
  if (reminderSent    !== undefined) out.reminder_sent = reminderSent;
  const createdBy = obj.createdBy ?? obj.created_by;
  if (createdBy       !== undefined) out.created_by   = createdBy;
  return out;
}

// ════════════════════════════════════════════════════════════
// HELPERS DE DISPONIBILIDAD
// ════════════════════════════════════════════════════════════

// Versiones síncronas sobre datos ya cargados (evitan una consulta
// a Supabase por cada día/hora — el cuello de botella de velocidad)
function hoursForProfDaySync(avail, profId, dowNum) {
  const dayKey = DAY_KEY_MAP[dowNum];
  const hours = avail?.[profId]?.[dayKey]?.length ? avail[profId][dayKey] : HOURS_DEFAULT;
  return [...hours].sort(); // siempre en orden cronológico
}

function isBlockedSlotSync(blocked, profId, date, hour) {
  return !!blocked[`${profId}_${date}_${hour}`];
}

async function isBlockedSlot(profId, date, hour) {
  const blocked = await loadBlocked();
  return isBlockedSlotSync(blocked, profId, date, hour);
}

// ════════════════════════════════════════════════════════════
// HELPERS DE FECHA
// ════════════════════════════════════════════════════════════

const DAY_NAMES  = { lunes:1, martes:2, miercoles:3, 'miércoles':3, jueves:4, viernes:5, sabado:6, 'sábado':6 };
const DAY_LABELS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MONTH_NAMES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function todayDow() { return new Date().getDay(); }

// Fecha YYYY-MM-DD en hora LOCAL (toISOString usa UTC y desplaza un día
// cuando el servidor no está en UTC — bug sutil de zona horaria)
function ymdLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nextWeekMonday() {
  const now  = new Date();
  const dow  = now.getDay();
  const diff = dow === 0 ? 1 : 8 - dow;
  const mon  = new Date(now);
  mon.setDate(now.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function nextWeekDates() {
  const mon = nextWeekMonday();
  return [0,1,2,3,4,5].map(i => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return {
      date:    ymdLocal(d),
      dayName: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][i],
      dow:     i + 1,
    };
  });
}

function formatDate(dateStr) {
  const [, m, d] = String(dateStr).substring(0, 10).split('-');
  return `${parseInt(d)} de ${MONTH_NAMES[parseInt(m) - 1]}`;
}

function hoursUntil(dateStr, timeStr) {
  const d = String(dateStr).substring(0, 10);
  const t = String(timeStr).substring(0, 5);
  return (new Date(`${d}T${t}:00`) - Date.now()) / 3600000;
}

function bookingWindowOpen() {
  const dow = todayDow(); // 2=mar, 3=mié, 4=jue
  return dow >= 2 && dow <= 4;
}

function thuExpiry() {
  const now = new Date();
  // En jueves la ventana cierra ESTA noche (antes saltaba al jueves siguiente)
  const daysToThu = (4 - now.getDay() + 7) % 7;
  const thu = new Date(now);
  thu.setDate(now.getDate() + daysToThu);
  thu.setHours(23, 59, 0, 0);
  return thu.getTime();
}

function dateForDow(dow) {
  const week = nextWeekDates();
  return week.find(w => w.dow === dow) || null;
}

// ════════════════════════════════════════════════════════════
// LÓGICA PRINCIPAL — HUECOS LIBRES
// ════════════════════════════════════════════════════════════

async function nextFreeSlots(profId, count = 8, fromDate = null) {
  // Una sola ronda de consultas en paralelo (antes: una por día/hora → lento)
  const [slots, examDays, avail, blocked] = await Promise.all([
    loadSlots(), loadExamDays(), loadAvailability(), loadBlocked(),
  ]);
  // Anclar al mediodía local: evita desplazamientos de día por zona horaria
  const start = fromDate ? new Date(`${String(fromDate).substring(0, 10)}T12:00:00`) : new Date();
  if (!fromDate) start.setDate(start.getDate() + 1);
  start.setHours(12, 0, 0, 0);

  const free = [];
  for (let d = 0; d < 60 && free.length < count; d++) {
    const dt  = new Date(start);
    dt.setDate(start.getDate() + d);
    const dow  = dt.getDay();
    if (dow === 0) continue; // sin domingos
    const date  = ymdLocal(dt);
    if (examDays.includes(date)) continue; // día de examen: sin clases

    for (const hour of hoursForProfDaySync(avail, profId, dow)) {
      if (free.length >= count) break;
      if (isBlockedSlotSync(blocked, profId, date, hour)) continue;
      const taken = slots.some(
        s => (s.profId === profId || s.prof_id === profId)
          && String(s.date).substring(0, 10) === date
          && String(s.time).substring(0, 5) === hour
          && (s.studentId || s.student_id)
          && s.status !== 'cancelled'
      );
      if (!taken) {
        free.push({
          date,
          time:    hour,
          dayName: DAY_LABELS[dow],
        });
      }
    }
  }
  return free;
}

async function isSlotFree(profId, date, time) {
  const [slots, examDays, blocked] = await Promise.all([
    loadSlots(), loadExamDays(), loadBlocked(),
  ]);
  if (examDays.includes(String(date).substring(0, 10))) return false;
  if (isBlockedSlotSync(blocked, profId, date, String(time).substring(0, 5))) return false;
  return !slots.some(
    s => (s.profId === profId || s.prof_id === profId)
      && String(s.date).substring(0, 10) === date
      && String(s.time).substring(0, 5) === time
      && (s.studentId || s.student_id)
      && s.status !== 'cancelled'
  );
}

// ── Próximas clases reservadas de un alumno (ordenadas) ──
async function upcomingSlotsFor(studentId, max = 8) {
  const slots = await loadSlots();
  const now = Date.now();
  return slots
    .filter(s => {
      const sid = s.studentId ?? s.student_id;
      if (sid !== studentId || s.status === 'cancelled') return false;
      const d = String(s.date).substring(0, 10);
      const t = String(s.time).substring(0, 5);
      return new Date(`${d}T${t}:00`).getTime() > now;
    })
    .sort((a, b) => (String(a.date) + a.time).localeCompare(String(b.date) + b.time))
    .slice(0, max);
}

function slotLabel(s) {
  const d = String(s.date).substring(0, 10);
  const dow = new Date(d + 'T12:00:00').getDay();
  return `${DAY_LABELS[dow]} ${formatDate(d)} — ${String(s.time).substring(0, 5)}h`;
}

// ════════════════════════════════════════════════════════════
// NORMALIZADORES DE RESPUESTA WHATSAPP
// ════════════════════════════════════════════════════════════

function norm(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function isYes(t) {
  const n = norm(t);
  return ['si','sí','yes','ok','vale','claro','perfecto','de acuerdo','confirmado','adelante','genial'].some(w => n.includes(w));
}
function isNo(t) {
  const n = norm(t);
  return ['no','no puedo','no me viene','imposible','otro','otra','cambia','diferente'].some(w => n.startsWith(w) || n === w);
}
function isDone(t) {
  const n = norm(t);
  return ['listo','gracias','ya','fin','nada mas','nada más','suficiente'].some(w => n.includes(w));
}

// ── Parser de texto libre ─────────────────────────────────
function parseBookingText(text) {
  const t = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[áàä]/g,'a').replace(/[éèë]/g,'e')
    .replace(/[íìï]/g,'i').replace(/[óòö]/g,'o').replace(/[úùü]/g,'u');

  let dow = null;
  for (const [name, num] of Object.entries(DAY_NAMES)) {
    const n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(n)) { dow = num; break; }
  }

  let hour = null;
  const m1 = t.match(/(\d{1,2}):(\d{2})/);
  if (m1) {
    hour = m1[1].padStart(2, '0') + ':' + m1[2];
  } else {
    const m2 = t.match(/(\d{1,2})\s*h/);
    if (m2) hour = m2[1].padStart(2, '0') + ':00';
    else {
      const m3 = t.match(/las\s+(\d{1,2})/);
      if (m3) hour = m3[1].padStart(2, '0') + ':00';
      else {
        const m4 = t.match(/\b(\d{1,2})\b/);
        if (m4 && parseInt(m4[1]) >= 7 && parseInt(m4[1]) <= 20)
          hour = m4[1].padStart(2, '0') + ':00';
      }
    }
  }

  return { dow, hour };
}

// ════════════════════════════════════════════════════════════
// WHATSAPP Y NOTIFICACIONES
// ════════════════════════════════════════════════════════════

async function sendWA(to, body) {
  to = normalizePhone(to);
  if (!client) {
    console.log(`🚫 (Twilio no configurado) mensaje NO enviado a ${to}: ${body.substring(0, 60).replace(/\n/g, ' ')}`);
    return;
  }
  try {
    await client.messages.create({ from: SANDBOX_NUM, to: `whatsapp:${to}`, body });
    console.log(`📤 → ${to}: ${body.substring(0, 80).replace(/\n/g, ' ')}`);
  } catch (e) {
    console.error(`❌ Error → ${to}:`, e.message);
  }
}

async function notifyProf(profId, body) {
  // Buscar el teléfono real del profesor; si no tiene, avisar al admin
  let phone = null;
  if (USE_SUPABASE && profId) {
    const { data } = await supabase
      .from('professors')
      .select('phone')
      .eq('id', profId)
      .single();
    phone = data?.phone || null;
  }
  await sendWA(phone || NOTIFY_ADMIN, body);
}

// ════════════════════════════════════════════════════════════
// ESTADO DE CONVERSACIÓN
// ════════════════════════════════════════════════════════════

function makeSuggestState(st, freeSlots, weekMode = false) {
  return {
    type:        'suggest',
    studentId:   st.id,
    studentName: st.name,
    profId:      st.profId ?? st.prof_id,
    slots:       freeSlots,
    idx:         0,
    booked:      [],       // clases reservadas en esta conversación
    weekMode,              // true: solo ofrecer huecos de la semana que viene
    expires:     thuExpiry(),
  };
}

// Fecha de inicio para ofrecer huecos según el modo
function suggestFromDate(state) {
  return state?.weekMode ? ymdLocal(nextWeekMonday()) : null;
}

// ════════════════════════════════════════════════════════════
// INCREMENTAR NUM_CLASES (solo para fallback JSON)
// En Supabase lo hace el trigger trg_slots_num_clases
// ════════════════════════════════════════════════════════════

async function incrementClases(studentId) {
  if (USE_SUPABASE) return; // el trigger lo gestiona
  const students = await loadStudents();
  const idx = students.findIndex(s => s.id === studentId);
  if (idx >= 0) {
    students[idx].numClases = (students[idx].numClases || 0) + 1;
    await saveStudents(students);
    console.log(`📈 ${students[idx].name}: numClases → ${students[idx].numClases}`);
  }
}

// ════════════════════════════════════════════════════════════
// FLUJO 1: RESERVAS (Mar-Jue 9:00)
// ════════════════════════════════════════════════════════════

async function sendBookingRequests(force = false) {
  console.log('\n📅 [RESERVAS] Campaña semanal...');
  if (!force && !bookingWindowOpen()) {
    console.log('⏭️  Fuera de ventana (solo Mar-Jue)');
    return;
  }

  const allStudents = await loadStudents();
  const students = allStudents.filter(s => s.active && s.phone && s.botActive !== false);
  const slots    = await loadSlots();
  const weekDates = nextWeekDates().map(w => w.date);
  const dow = todayDow(); // 2=mar (inicial), 3=mié (recordatorio), 4=jue (último día)
  let sent = 0, skipped = 0;

  const nextMon = ymdLocal(nextWeekMonday());
  for (const st of students) {
    if (pending[st.phone]) { console.log(`⏭️  ${st.name} ya en conversación`); continue; }

    // Si ya tiene clases la semana que viene, no molestar en los recordatorios
    const yaReservo = slots.some(
      s => (s.studentId ?? s.student_id) === st.id
        && weekDates.includes(String(s.date).substring(0, 10))
        && s.status !== 'cancelled'
    );
    if (yaReservo && !force) { skipped++; continue; }

    const profId = st.profId ?? st.prof_id;
    const free = await nextFreeSlots(profId, 8, nextMon);
    if (!free.length) {
      await sendWA(st.phone, `Hola ${st.name} 👋\nNo hay huecos disponibles la semana que viene. Contacta con la autoescuela.`);
      continue;
    }

    const slot = free[0];
    const urgencia =
      dow === 4 ? `⚠️ *ÚLTIMO DÍA*: el plazo cierra HOY a medianoche.` :
      dow === 3 ? `⚠️ El plazo cierra mañana jueves.` :
                  `⚠️ Tienes hasta el jueves para reservar.`;

    // Martes (o manual): presentación completa. Mié/Jue: recordatorio directo.
    const esInicial = dow === 2 || force;
    const msg = esInicial
      ? `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*.\n\n` +
        `Vamos a organizar tus clases de la semana que viene. Te propongo:\n\n` +
        `📅 *${slot.dayName} ${formatDate(slot.date)} a las ${slot.time}h*\n\n` +
        `¿Te viene bien? Responde *SÍ* para confirmar o *NO* para ver otro hueco.\n` +
        `💡 Atajo: responde con un número (ej: *3*) y te reservo esas clases repartidas en la semana de una vez.\n` +
        urgencia
      : `Hola ${st.name} 👋 Aún no tienes clases reservadas para la semana que viene.\n\n` +
        `Te propongo:\n📅 *${slot.dayName} ${formatDate(slot.date)} a las ${slot.time}h*\n\n` +
        `Responde *SÍ*, un número (ej: *3* clases de golpe), o *NO* para ver más huecos.\n` +
        urgencia;

    await sendWA(st.phone, msg);
    pending[st.phone] = makeSuggestState({ ...st, profId }, free, true);
    sent++;
  }
  console.log(`✅ Campaña: ${sent} contactados · ${skipped} ya tenían clases (no molestados)`);
}

// ════════════════════════════════════════════════════════════
// FLUJO 2: RECORDATORIOS 48h
// ════════════════════════════════════════════════════════════

async function sendReminders() {
  console.log('\n⏰ [RECORDATORIOS] Comprobando clases en 48h...');

  const slots    = await loadSlots();
  const students = await loadStudents();
  let sent = 0;

  const toRemind = slots.filter(s => {
    const studentId = s.studentId ?? s.student_id;
    const reminderSent = s.reminderSent ?? s.reminder_sent;
    if (!studentId || s.status === 'cancelled' || reminderSent) return false;
    const h = hoursUntil(s.date, s.time);
    return h > 0 && h <= 48;
  });

  for (const slot of toRemind) {
    const studentId = slot.studentId ?? slot.student_id;
    const st = students.find(s => s.id === studentId);
    if (!st?.phone) continue;

    const msg =
      `⏰ *Recordatorio de ${SCHOOL_NAME}*\n\n` +
      `Hola ${st.name}, tienes clase el *${slot.dayName || formatDate(slot.date)}* a las *${slot.time}h*.\n\n` +
      `Si no puedes venir, responde *CANCELAR*.\n` +
      `Si no respondes, la clase se mantiene. ✅`;

    await sendWA(st.phone, msg);
    await updateSlot(slot.id, { reminderSent: true });

    const profId = slot.profId ?? slot.prof_id;
    pending[st.phone] = {
      type:        'reminder',
      studentId:   st.id,
      studentName: st.name,
      profId:      profId,
      slotId:      slot.id,
      expires:     Date.now() + 50 * 3600000,
    };
    sent++;
  }

  console.log(`✅ Recordatorios enviados: ${sent}`);
}

// ════════════════════════════════════════════════════════════
// RESERVAR SLOT
// ════════════════════════════════════════════════════════════

async function bookSlot(studentId, studentName, profId, slot) {
  const newSlot = {
    id:           `slot_${Date.now()}`,
    studentId,
    profId,
    date:         slot.date,
    time:         slot.time,
    dayName:      slot.dayName,
    slotType:     'practica',
    type:         'practica',
    status:       'confirmed',
    createdBy:    'bot',
    reminderSent: false,
  };
  await insertSlot(newSlot);
  await incrementClases(studentId);
  await notifyProf(profId,
    `📌 *Nueva clase reservada*\n👤 ${studentName}\n📅 ${slot.dayName} ${formatDate(slot.date)} a las ${slot.time}h`
  );
  console.log(`✅ Reserva: ${studentName} → ${slot.date} ${slot.time}`);
  return newSlot;
}

// ════════════════════════════════════════════════════════════
// WEBHOOK — /bot
// ════════════════════════════════════════════════════════════

app.post('/bot', async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '') || '';
  const body = (req.body.Body || '').trim();
  console.log(`\n📥 ${from}: "${body}"`);

  let state = pending[from];

  // ── Sin contexto: alumno escribe espontáneamente ──────
  if (!state) {
    const allStudents = await loadStudents();
    const st = allStudents.find(s => s.phone === from && s.active);
    if (!st) {
      await sendWA(from, `Hola 👋 Soy el asistente de *${SCHOOL_NAME}*. No encuentro tu número en el sistema — contacta con la autoescuela para darte de alta.`);
      res.send('<Response></Response>');
      return;
    }

    const profId = st.profId ?? st.prof_id;
    const t0 = norm(body);

    // ── "¿qué clases tengo?": consultar reservas ──
    if (/\bclases?\b/.test(t0) && /(mis|ver|que|cuando|tengo)/.test(t0) && !/cancel|anula/.test(t0)) {
      const mine = await upcomingSlotsFor(st.id);
      if (!mine.length) {
        await sendWA(from, `Hola ${st.name} 👋 No tienes clases reservadas ahora mismo. Escríbeme *hola* y organizamos tu semana.`);
      } else {
        await sendWA(from,
          `📋 *Tus próximas clases:*\n` +
          mine.map(s => `• ${slotLabel(s)}`).join('\n') +
          `\n\nSi quieres anular alguna, responde *cancelar*.`
        );
      }
      res.send('<Response></Response>');
      return;
    }

    // ── "cancelar": anular una clase reservada ──
    if (/cancel|anula/.test(t0)) {
      const mine = await upcomingSlotsFor(st.id);
      if (!mine.length) {
        await sendWA(from, `No tienes clases reservadas que cancelar 👍`);
        res.send('<Response></Response>');
        return;
      }
      pending[from] = {
        type:        'cancel',
        studentId:   st.id,
        studentName: st.name,
        profId:      profId,
        slots:       mine,
        expires:     Date.now() + 3600000, // 1h para decidir
      };
      await sendWA(from,
        `Estas son tus próximas clases:\n\n` +
        mine.map((s, i) => `*${i + 1}.* ${slotLabel(s)}`).join('\n') +
        `\n\n¿Cuál quieres cancelar? Responde con el número, o *listo* para salir.`
      );
      res.send('<Response></Response>');
      return;
    }

    const nextMon = ymdLocal(nextWeekMonday());
    const free = await nextFreeSlots(profId, 8, nextMon);
    if (!free.length) {
      await sendWA(from, `Hola ${st.name} 👋\nNo hay huecos disponibles la semana que viene. Llama a la autoescuela.`);
      res.send('<Response></Response>');
      return;
    }

    const slot = free[0];
    const msg =
      `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*.\n\n` +
      `Vamos a organizar tus clases de la semana que viene. Te propongo:\n\n` +
      `📅 *${slot.dayName} ${formatDate(slot.date)} a las ${slot.time}h*\n\n` +
      `¿Te viene bien? Responde *SÍ* para confirmar o *NO* para ver otro hueco.\n` +
      `💡 Atajo: responde con un número (ej: *3*) y te reservo esas clases repartidas en la semana de una vez.`;

    await sendWA(from, msg);
    pending[from] = makeSuggestState({ ...st, profId }, free, true);
    res.send('<Response></Response>');
    return;
  }

  // ── Conversación expirada ─────────────────────────────
  if (Date.now() > state.expires) {
    delete pending[from];
    await sendWA(from, `El plazo de reserva ha cerrado. Te contactaremos el próximo martes. ¡Hasta pronto! 👋`);
    res.send('<Response></Response>');
    return;
  }

  // ── FLUJO: Cancelación ────────────────────────────────
  if (state.type === 'cancel') {
    if (isDone(body) || isNo(body)) {
      delete pending[from];
      await sendWA(from, `De acuerdo, no cancelo nada. ¡Hasta pronto! 👋`);
      res.send('<Response></Response>');
      return;
    }
    const n = parseInt(norm(body), 10);
    if (n >= 1 && n <= state.slots.length) {
      const s = state.slots[n - 1];
      await updateSlot(s.id, { status: 'cancelled' });
      delete pending[from];
      await sendWA(from, `❌ Clase cancelada: *${slotLabel(s)}*\n\nSi quieres recuperar el hueco otro día, escríbeme *hola*. 👋`);
      await notifyProf(state.profId,
        `❌ *Clase cancelada por el alumno*\n👤 ${state.studentName}\n📅 ${slotLabel(s)}`
      );
    } else {
      await sendWA(from, `Responde con el número de la clase (1-${state.slots.length}), o *listo* para salir.`);
    }
    res.send('<Response></Response>');
    return;
  }

  // ── FLUJO: Recordatorio ───────────────────────────────
  if (state.type === 'reminder') {
    if (isNo(body) || norm(body) === 'cancelar') {
      const slot = await updateSlot(state.slotId, { status: 'cancelled' });
      delete pending[from];
      await sendWA(from, `Entendido ${state.studentName}, clase cancelada. ¡Hasta la próxima! 👋`);
      await notifyProf(state.profId,
        `❌ *Clase cancelada*\n👤 ${state.studentName}\n📅 ${slot?.dayName || ''} ${slot?.date || ''} a las ${slot?.time || ''}h`
      );
    } else {
      delete pending[from];
      await sendWA(from, `¡Perfecto! Te esperamos. 🚗`);
    }
    res.send('<Response></Response>');
    return;
  }

  // ── FLUJO: Sugerencia ─────────────────────────────────
  if (state.type === 'suggest') {
    if (isDone(body)) {
      delete pending[from];
      const booked = state.booked || [];
      const resumen = booked.length
        ? `\n\n📋 *Tus clases reservadas:*\n` +
          booked.map(b => `• ${b.dayName} ${formatDate(b.date)} — ${b.time}h`).join('\n') +
          `\n\nTe recordaremos cada una 48h antes.`
        : '';
      await sendWA(from, `¡Perfecto ${state.studentName}!${resumen} 🚗`);
      res.send('<Response></Response>');
      return;
    }

    const currentSlot = state.slots[state.idx];

    // ── Atajo: un número ("3" o "quiero 3 clases") reserva N clases
    //    de golpe, repartidas en días distintos de la semana ──
    const multiMatch = norm(body).match(/^([1-6])$/) || norm(body).match(/\b([1-6])\s*clases?\b/);
    if (multiMatch) {
      const wanted = parseInt(multiMatch[1]);
      const all = await nextFreeSlots(state.profId, 30, suggestFromDate(state));
      // Repartir: primera hora de cada día distinto; si pide más que días, segundas horas
      const byDate = {};
      all.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });
      const dates = Object.keys(byDate).sort();
      const picked = [];
      for (let ronda = 0; picked.length < wanted && ronda < 8; ronda++) {
        let added = false;
        for (const d of dates) {
          if (picked.length >= wanted) break;
          if (byDate[d][ronda]) { picked.push(byDate[d][ronda]); added = true; }
        }
        if (!added) break;
      }
      if (!picked.length) {
        await sendWA(from, `No quedan huecos disponibles la semana que viene 😔 Llama a la autoescuela.`);
        res.send('<Response></Response>');
        return;
      }
      picked.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      for (const s of picked) {
        await bookSlot(state.studentId, state.studentName, state.profId, s);
      }
      state.booked = (state.booked || []).concat(picked);
      state.slots = await nextFreeSlots(state.profId, 8, suggestFromDate(state));
      state.idx = 0;

      const resumen = state.booked.map(b => `• ${b.dayName} ${formatDate(b.date)} — ${b.time}h`).join('\n');
      await sendWA(from,
        `✅ ¡Hechas! He reservado tus ${picked.length} clases:\n\n📋 *Tus clases de la semana:*\n${resumen}\n\n` +
        `¿Quieres alguna más? Responde *SÍ*, otro número, o *listo* para terminar.`
      );
      res.send('<Response></Response>');
      return;
    }

    if (isYes(body)) {
      // Verificar que sigue libre
      if (!(await isSlotFree(state.profId, currentSlot.date, currentSlot.time))) {
        const fresh = await nextFreeSlots(state.profId, 8, suggestFromDate(state));
        if (!fresh.length) {
          delete pending[from];
          await sendWA(from, `Lo siento, ese hueco acaba de ocuparse y no hay más disponibles. Llama a la autoescuela.`);
          res.send('<Response></Response>');
          return;
        }
        state.slots = fresh; state.idx = 0;
        const ns = fresh[0];
        await sendWA(from, `Ese hueco acaba de ocuparse 😅\n\nTe propongo:\n📅 *${ns.dayName} ${formatDate(ns.date)} a las ${ns.time}h*\n\n¿Te viene bien? *SÍ* o *NO*`);
        res.send('<Response></Response>');
        return;
      }

      await bookSlot(state.studentId, state.studentName, state.profId, currentSlot);
      state.booked = state.booked || [];
      state.booked.push(currentSlot);
      const remaining = await nextFreeSlots(state.profId, 8, suggestFromDate(state));
      state.slots = remaining; state.idx = 0;

      const resumen = state.booked.map(b => `• ${b.dayName} ${formatDate(b.date)} — ${b.time}h`).join('\n');
      await sendWA(from,
        `✅ ¡Reservada!\n\n📋 *Tus clases de la semana:*\n${resumen}\n\n` +
        `¿Quieres otra? Responde *SÍ* para el siguiente hueco, *NO* para ver opciones, o *listo* para terminar.`
      );

    } else if (isNo(body)) {
      state.idx++;
      if (state.idx >= state.slots.length) {
        const more = await nextFreeSlots(state.profId, 8, suggestFromDate(state));
        state.slots = more; state.idx = 0;
      }
      if (!state.slots.length) {
        delete pending[from];
        await sendWA(from, `No hay más huecos disponibles en los próximos días. Llama a la autoescuela. 📞`);
        res.send('<Response></Response>');
        return;
      }
      const next = state.slots[state.idx];
      await sendWA(from,
        `De acuerdo, te propongo:\n\n📅 *${next.dayName} ${formatDate(next.date)} a las ${next.time}h*\n\n` +
        `¿Te viene bien? *SÍ* o *NO* — o pregúntame directamente (ej: *"¿el martes a las 10 está libre?"*)`
      );

    } else {
      // Texto libre — el alumno pregunta por un día/hora concreto
      const { dow, hour } = parseBookingText(body);
      if (dow || hour) {
        const allFree = await nextFreeSlots(state.profId, 60, suggestFromDate(state));
        const hh = hour ? hour.padStart(5, '0') : null;
        const NOMBRE_DIA = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

        // Fecha objetivo cuando pregunta por un día
        const targetDate = dow
          ? (state.weekMode
              ? (dateForDow(dow)?.date || null)
              : (allFree.find(s => new Date(s.date + 'T12:00:00').getDay() === dow)?.date || null))
          : null;

        if (dow && hh) {
          // Pregunta concreta: "¿el martes a las 10 está libre?"
          const exact = allFree.find(s => s.date === targetDate && s.time === hh);
          if (exact) {
            state.slots = [exact, ...allFree.filter(s => s !== exact)];
            state.idx = 0;
            await sendWA(from,
              `✅ ¡Está libre!\n\n📅 *${exact.dayName} ${formatDate(exact.date)} a las ${exact.time}h*\n\n¿Lo reservo? *SÍ* o *NO*`
            );
          } else {
            const sameDay = targetDate ? allFree.filter(s => s.date === targetDate) : [];
            if (sameDay.length) {
              state.slots = [...sameDay, ...allFree.filter(s => !sameDay.includes(s))];
              state.idx = 0;
              await sendWA(from,
                `❌ El ${NOMBRE_DIA[dow]} a las ${hh}h *no está disponible*.\n\n` +
                `Ese día quedan libres: *${sameDay.map(s => s.time).join('h, ')}h*\n\n` +
                `Dime cuál te va (ej: *"a las ${sameDay[0].time}"*), o *NO* para ver otros días.`
              );
            } else {
              const cur = state.slots[state.idx];
              await sendWA(from,
                `❌ El ${NOMBRE_DIA[dow]} *no queda ningún hueco libre*.\n\n` +
                `El siguiente disponible es:\n📅 *${cur?.dayName} ${formatDate(cur?.date)} a las ${cur?.time}h*\n\n¿Te viene bien? *SÍ* o *NO*`
              );
            }
          }
        } else if (dow) {
          // Pregunta por un día: "¿el martes está libre?"
          const sameDay = targetDate ? allFree.filter(s => s.date === targetDate) : [];
          if (sameDay.length) {
            state.slots = [...sameDay, ...allFree.filter(s => !sameDay.includes(s))];
            state.idx = 0;
            await sendWA(from,
              `✅ El ${NOMBRE_DIA[dow]} ${formatDate(targetDate)} tiene huecos libres:\n\n` +
              `🕐 *${sameDay.map(s => s.time).join('h, ')}h*\n\n` +
              `Dime la hora que te va (ej: *"a las ${sameDay[0].time}"*), o *SÍ* para reservar la de las ${sameDay[0].time}h.`
            );
          } else {
            const cur = state.slots[state.idx];
            await sendWA(from,
              `❌ El ${NOMBRE_DIA[dow]} *no queda ningún hueco libre*.\n\n` +
              `El siguiente disponible es:\n📅 *${cur?.dayName} ${formatDate(cur?.date)} a las ${cur?.time}h*\n\n¿Te viene bien? *SÍ* o *NO*`
            );
          }
        } else {
          // Pregunta por una hora: "¿a las 10 está libre?"
          // Priorizar el orden de la conversación (si acaba de preguntar por
          // un día, state.slots empieza por ese día)
          const exact = state.slots.find(s => s.time === hh) || allFree.find(s => s.time === hh);
          if (exact) {
            state.slots = [exact, ...allFree.filter(s => s !== exact)];
            state.idx = 0;
            await sendWA(from,
              `✅ Las ${hh}h están libres el *${exact.dayName} ${formatDate(exact.date)}*.\n\n¿Lo reservo? *SÍ* o *NO*`
            );
          } else {
            const cur = state.slots[state.idx];
            await sendWA(from,
              `❌ A las ${hh}h *no queda hueco* esta semana.\n\n` +
              `El siguiente disponible es:\n📅 *${cur?.dayName} ${formatDate(cur?.date)} a las ${cur?.time}h*\n\n¿Te viene bien? *SÍ* o *NO*`
            );
          }
        }
      } else {
        await sendWA(from, `Responde *SÍ* para confirmar, *NO* para ver otro hueco, o pregúntame por una hora (ej: *"¿el martes a las 10 está libre?"*) 😊`);
      }
    }
    res.send('<Response></Response>');
    return;
  }

  res.send('<Response></Response>');
});

// ════════════════════════════════════════════════════════════
// CRONS
// ════════════════════════════════════════════════════════════

// Mar, Mié, Jue a las 9:00 → solicitar reservas
cron.schedule('0 9 * * 2,3,4', sendBookingRequests, { timezone: 'Europe/Madrid' });

// Cada hora → comprobar recordatorios 48h
cron.schedule('0 * * * *', sendReminders, { timezone: 'Europe/Madrid' });

// Jueves 23:59 → avisar a quien no reservó y limpiar pendientes
cron.schedule('59 23 * * 4', async () => {
  console.log('\n🔒 Cerrando ventana de reservas...');
  const students  = await loadStudents();
  const slots     = await loadSlots();
  const week      = nextWeekDates();
  const weekDates = week.map(w => w.date);

  for (const st of students.filter(s => s.active && s.phone)) {
    const stPending = pending[st.phone];
    if (!stPending || stPending.type !== 'suggest') continue;
    const alreadyHas = slots.some(
      s => (s.studentId ?? s.student_id) === st.id
        && weekDates.includes(String(s.date).substring(0, 10))
        && s.status !== 'cancelled'
    );
    if (!alreadyHas) {
      await sendWA(st.phone,
        `Hola ${st.name}, el plazo de reserva para la semana que viene ha cerrado.\nSi necesitas clase, llama a la autoescuela. ¡Hasta pronto! 👋`
      );
    }
    delete pending[st.phone];
  }
}, { timezone: 'Europe/Madrid' });

// ════════════════════════════════════════════════════════════
// RUTAS DE TEST
// ════════════════════════════════════════════════════════════

app.get('/test/hola', async (req, res) => {
  await sendWA(NOTIFY_ADMIN, '👋 ¡Bot AutoEscuela activo!\n\nFlujos:\n📅 Mar-Jue 9:00 → solicitud de reserva\n⏰ Cada hora → recordatorios 48h antes\n🔒 Jue 23:59 → cierre de reservas');
  res.json({ ok: true });
});

app.get('/test/reservas', async (req, res) => {
  await sendBookingRequests(true);
  res.json({ ok: true });
});

app.get('/test/recordatorios', async (req, res) => {
  await sendReminders();
  res.json({ ok: true });
});

app.get('/test/add-demo-slot', async (req, res) => {
  const students = (await loadStudents()).filter(s => s.active);
  if (!students.length) return res.json({ ok: false, msg: 'Sin alumnos' });
  const st  = students[0];
  const dt  = new Date(Date.now() + 47 * 3600000);
  const date = dt.toISOString().split('T')[0];
  const hour = dt.getHours().toString().padStart(2, '0') + ':00';
  const profId = st.profId ?? st.prof_id;
  const slot = {
    id:          `slot_demo_${Date.now()}`,
    studentId:   st.id,
    profId:      profId,
    date,
    time:        hour,
    dayName:     DAY_LABELS[dt.getDay()],
    slotType:    'practica',
    type:        'practica',
    status:      'confirmed',
    reminderSent: false,
    createdBy:   'admin',
  };
  await insertSlot(slot);
  res.json({ ok: true, slot, alumno: st.name });
});

app.get('/pending', (req, res) => res.json(pending));

app.get('/status', async (req, res) => {
  const students = await loadStudents();
  const slots    = await loadSlots();
  res.json({
    modo:            USE_SUPABASE ? 'supabase' : 'json_local',
    alumnos_activos: students.filter(s => s.active).length,
    total_slots:     slots.length,
    pendientes_bot:  Object.keys(pending).length,
    proximas_48h:    slots.filter(s => {
      const studentId = s.studentId ?? s.student_id;
      const reminderSent = s.reminderSent ?? s.reminder_sent;
      return studentId && s.status !== 'cancelled' && !reminderSent
        && hoursUntil(s.date, s.time) > 0 && hoursUntil(s.date, s.time) <= 48;
    }).length,
    ventana_reserva: bookingWindowOpen() ? 'ABIERTA (Mar-Jue)' : 'CERRADA',
  });
});

// ════════════════════════════════════════════════════════════
// REST API — sincronización con el CRM
// ════════════════════════════════════════════════════════════

// GET /api/ping
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: '3.0', modo: USE_SUPABASE ? 'supabase' : 'json_local' });
});

// GET /api/slots
app.get('/api/slots', async (req, res) => {
  res.json(await loadSlots());
});

// POST /api/slots — crear o actualizar slot desde el CRM
app.post('/api/slots', async (req, res) => {
  const slot = req.body;
  if (!slot || !slot.id) return res.status(400).json({ error: 'Slot inválido (requiere id)' });
  const result = await upsertSlot(slot);
  console.log(`📥 CRM → slot creado/actualizado: ${slot.id}`);
  res.json({ ok: true, slot: result });
});

// PATCH /api/slots/:id
app.patch('/api/slots/:id', async (req, res) => {
  const existing = (await loadSlots()).find(s => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Slot no encontrado' });

  const updated = await updateSlot(req.params.id, req.body);
  console.log(`📝 CRM → slot actualizado: ${req.params.id} → ${req.body.status || 'sin cambio de status'}`);

  // Si se cancela, notificar al profesor
  if (req.body.status === 'cancelled') {
    const studentId = updated?.studentId ?? updated?.student_id ?? existing.studentId ?? existing.student_id;
    const profId    = updated?.profId    ?? updated?.prof_id    ?? existing.profId    ?? existing.prof_id;
    if (studentId) {
      const students = await loadStudents();
      const st = students.find(s => s.id === studentId);
      if (st) {
        notifyProf(profId,
          `❌ *Clase cancelada desde CRM*\n👤 ${st.name}\n📅 ${updated?.date || existing.date} a las ${updated?.time || existing.time}h`
        ).catch(() => {});
      }
    }
  }
  res.json({ ok: true, slot: updated });
});

// DELETE /api/slots/:id
app.delete('/api/slots/:id', async (req, res) => {
  const removed = await deleteSlot(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Slot no encontrado' });
  console.log(`🗑️  CRM → slot eliminado: ${req.params.id}`);
  res.json({ ok: true, removed });
});

// GET /api/students
app.get('/api/students', async (req, res) => {
  res.json(await loadStudents());
});

// PATCH /api/students/:id
app.patch('/api/students/:id', async (req, res) => {
  const students = await loadStudents();
  const existing = students.find(s => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Alumno no encontrado' });

  const updated = await updateStudent(req.params.id, req.body);
  console.log(`📝 CRM → alumno actualizado: ${updated?.name || req.params.id}`);
  res.json({ ok: true, student: updated });
});

// POST /api/send-booking/:studentId
app.post('/api/send-booking/:studentId', async (req, res) => {
  const students = await loadStudents();
  const st = students.find(s => s.id === req.params.studentId);
  if (!st)             return res.status(404).json({ error: 'Alumno no encontrado' });
  if (!st.phone)       return res.status(400).json({ error: 'El alumno no tiene teléfono' });
  if (st.botActive === false) return res.status(400).json({ error: 'Bot desactivado para este alumno' });

  const profId = st.profId ?? st.prof_id;
  const nextMon = ymdLocal(nextWeekMonday());
  const free = await nextFreeSlots(profId, 8, nextMon);
  if (!free.length) return res.status(409).json({ error: 'No hay huecos disponibles para este profesor' });

  const slot = free[0];
  const msg =
    `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*.\n\n` +
    `Vamos a organizar tus clases de la semana que viene. Te propongo:\n\n` +
    `📅 *${slot.dayName} ${formatDate(slot.date)} a las ${slot.time}h*\n\n` +
    `¿Te viene bien? Responde *SÍ* para confirmar o *NO* para ver otro hueco.\n` +
    `💡 Atajo: responde con un número (ej: *3*) y te reservo esas clases repartidas en la semana de una vez.\n` +
    `⚠️ El plazo cierra el jueves.`;

  await sendWA(st.phone, msg);
  pending[st.phone] = makeSuggestState({ ...st, profId }, free, true);

  console.log(`📤 CRM → mensaje manual enviado a ${st.name} (${st.phone})`);
  res.json({ ok: true, student: st.name, phone: st.phone });
});

// POST /api/send-reminder/:slotId
app.post('/api/send-reminder/:slotId', async (req, res) => {
  const slots = await loadSlots();
  const slot  = slots.find(s => s.id === req.params.slotId);
  if (!slot) return res.status(404).json({ error: 'Clase no encontrada' });

  const studentId = slot.studentId ?? slot.student_id;
  const students  = await loadStudents();
  const st = students.find(s => s.id === studentId);
  if (!st?.phone) return res.status(400).json({ error: 'Alumno sin teléfono' });

  const msg =
    `⏰ *Recordatorio de clase*\n\n` +
    `Hola ${st.name}, tienes clase el *${slot.dayName || formatDate(slot.date)}* a las *${slot.time}h*.\n\n` +
    `Si no puedes venir, responde *CANCELAR*.\n` +
    `Si no respondes, la clase se mantiene. ✅`;

  await sendWA(st.phone, msg);
  await updateSlot(slot.id, { reminderSent: true });

  const profId = slot.profId ?? slot.prof_id;
  pending[st.phone] = {
    type:        'reminder',
    studentId:   st.id,
    studentName: st.name,
    profId:      profId,
    slotId:      slot.id,
    expires:     Date.now() + 50 * 3600000,
  };

  console.log(`📤 CRM → recordatorio manual enviado a ${st.name}`);
  res.json({ ok: true, student: st.name });
});

// ════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => {
  refreshSchoolName();                             // nombre real desde Supabase
  setInterval(refreshSchoolName, 3600000);         // refrescar cada hora
  console.log(`\n🚗 AutoEscuela Bot — Puerto ${PORT}`);
  console.log('────────────────────────────────────────');
  console.log(`💾 Modo datos:   ${USE_SUPABASE ? 'Supabase' : 'JSON local'}`);
  console.log('📅 Reservas:     Mar-Jue 9:00');
  console.log('🔒 Cierre:       Jue 23:59');
  console.log('⏰ Recordatorios: cada hora (48h antes)');
  console.log('────────────────────────────────────────');
  console.log('GET  /test/hola          → ping WhatsApp');
  console.log('GET  /test/reservas      → lanzar reservas ahora');
  console.log('GET  /test/recordatorios → comprobar 48h');
  console.log('GET  /test/add-demo-slot → slot en 47h para test');
  console.log('GET  /status             → estado del bot');
  console.log('POST /bot                → webhook Twilio');
  console.log('────────────────────────────────────────');
  console.log('GET  /api/slots          → listar slots');
  console.log('POST /api/slots          → crear/actualizar slot');
  console.log('PATCH/DELETE /api/slots/:id');
  console.log('GET  /api/students       → listar alumnos');
  console.log('PATCH /api/students/:id');
  console.log('POST /api/send-booking/:studentId');
  console.log('POST /api/send-reminder/:slotId');
  console.log('GET  /api/ping           → health check');
});
