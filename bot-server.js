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
const crypto  = require('crypto');

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

// ── Cancelaciones: las gestiona la OFICINA, no el bot ──────
// Decisión de la autoescuela: el alumno NO cancela desde el chat. Cuando pide
// cancelar (o responde que no puede venir al recordatorio), el bot no toca la
// agenda: le da el móvil de la oficina para que lo gestionen allí.
const OFFICE_PHONE = process.env.OFFICE_PHONE || '684 632 975';
function cancelRedirectMsg(name) {
  return (
    `Hola${name ? ' ' + name : ''} 👋 Las cancelaciones y los cambios los gestiona directamente la oficina.\n\n` +
    `📞 Escribe o llama al *${OFFICE_PHONE}* y te atienden para cancelar tu clase.\n\n` +
    `_Yo no puedo anularla desde aquí, así que tu clase sigue reservada hasta que hables con ellos._`
  );
}

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
// Guardamos el cuerpo sin procesar: la firma de Meta se calcula sobre los
// bytes exactos que llegaron, así que hay que conservarlos antes del parseo.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

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
// Modo SMS: si hay TWILIO_SMS_NUM, el bot envía SMS normal (sin Meta, sin
// "join", funciona hoy). El alumno recibe un texto y responde por SMS.
const SMS_NUM     = process.env.TWILIO_SMS_NUM || null;  // ej: +34XXXXXXXXX
const USE_SMS     = !!(SMS_NUM && ACCOUNT_SID && AUTH_TOKEN);
// Sin credenciales el bot arranca igualmente (API REST disponible), solo
// que no puede enviar WhatsApp — evita crash-loop en Railway antes de
// configurar las variables secretas.
const client = (ACCOUNT_SID && AUTH_TOKEN) ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;

// ── Meta WhatsApp Cloud API (gratis, lo controla el dueño) ─
const META_TOKEN        = process.env.META_TOKEN;                 // token de acceso
const META_PHONE_ID     = process.env.META_PHONE_NUMBER_ID;       // ID del número
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'autoescuela_exit_verify';
// Secreto de la app (Meta → Configuración → Básica → Clave secreta). Si está
// puesto, se valida la firma de cada webhook; si no, no se puede validar y se
// aceptan igual (evita romper una instalación que aún no lo tenga configurado).
const META_APP_SECRET   = process.env.META_APP_SECRET || null;
const META_API_VER      = process.env.META_API_VERSION || 'v21.0';
// Nombres de las plantillas aprobadas en Meta (para mensajes que INICIA el bot)
const TPL_PROPUESTA    = process.env.META_TPL_PROPUESTA    || 'reserva_semana';
const TPL_RECORDATORIO = process.env.META_TPL_RECORDATORIO || 'recordatorio_clase';
const TPL_CANCELADA    = process.env.META_TPL_CANCELADA    || 'clase_cancelada';
const TPL_MOVIDA       = process.env.META_TPL_MOVIDA       || 'clase_movida';
const USE_META = !!(META_TOKEN && META_PHONE_ID);

// Proveedor activo: SMS > Meta > Twilio WhatsApp > ninguno
const PROVIDER = USE_SMS ? 'sms' : (USE_META ? 'meta' : (client ? 'twilio' : 'none'));
console.log(`📡 Proveedor de mensajes: ${PROVIDER}`);
if (PROVIDER === 'none') console.log('⚠️  Sin proveedor → envío desactivado');

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

// ── Conversaciones activas ────────────────────────────────
// En RAM para acceso rápido, PERO también se guardan en Supabase (tabla
// bot_pending) para que sobrevivan a los reinicios/despliegues de Railway.
// Sin esto, cada despliegue borraba las conversaciones a medias.
const pending = {};

// Guarda (o borra) en la nube el estado de conversación de un teléfono.
// Se llama tras cada mutación de `pending` para no perder el hilo.
async function persistPending(phone) {
  if (!USE_SUPABASE || !phone) return;
  try {
    const st = pending[phone];
    if (st) {
      await supabase.from('bot_pending').upsert({
        phone,
        school_id:  SCHOOL_ID || null,
        state:      st,
        expires_at: st.expires ? new Date(st.expires).toISOString() : null,
        updated_at: new Date().toISOString(),
      });
    } else {
      await supabase.from('bot_pending').delete().eq('phone', phone);
    }
  } catch (e) { console.error('persistPending:', e.message); }
}

// Al arrancar, restaura las conversaciones no caducadas desde la nube.
async function loadPending() {
  if (!USE_SUPABASE) return;
  try {
    const { data, error } = await supabase
      .from('bot_pending').select('phone,state,expires_at');
    if (error) { console.error('loadPending:', error.message); return; }
    const now = Date.now();
    let restored = 0;
    for (const row of (data || [])) {
      const exp = row.expires_at ? new Date(row.expires_at).getTime() : null;
      if (exp && exp < now) {
        supabase.from('bot_pending').delete().eq('phone', row.phone).then(() => {}, () => {});
        continue;
      }
      pending[row.phone] = row.state;
      restored++;
    }
    if (restored) console.log(`🔄 Conversaciones restauradas desde la nube: ${restored}`);
  } catch (e) { console.error('loadPending:', e.message); }
}

// Borra las conversaciones ya caducadas, de memoria y de la nube.
// Antes solo se limpiaban al arrancar y en el cierre del jueves —y ese solo
// recorría a los alumnos activos—, así que los hilos de cualquier otro número
// se acumulaban sin fin. Importa porque un alumno con un hilo colgado se
// SALTA la campaña del martes.
async function purgeExpiredPending() {
  const now = Date.now();
  let n = 0;
  for (const [phone, st] of Object.entries(pending)) {
    if (st && st.expires && st.expires < now) {
      delete pending[phone];
      await persistPending(phone);
      n++;
    }
  }
  if (n) console.log(`🧹 Conversaciones caducadas eliminadas: ${n}`);
  return n;
}

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

// ── Horario de pista: {lun:[horas], mar:[...]} ── (null = sin restricción)
async function loadPistaHours() {
  if (USE_SUPABASE) {
    const q = supabase.from('school_config').select('extra_config');
    if (SCHOOL_ID) q.eq('school_id', SCHOOL_ID);
    const { data, error } = await q;
    if (error) { console.error('Supabase loadPistaHours:', error.message); return null; }
    const ph = data?.[0]?.extra_config?.pista_hours;
    return (ph && Object.keys(ph).length) ? ph : null;
  }
  return null;
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
    fase:        row.fase,
    license:     row.license,
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
  const profAvail = avail?.[profId];
  // Si el profesor tiene disponibilidad semanal configurada en el CRM, se
  // respeta al pie de la letra: un día sin horas = no trabaja ese día
  // (no se ofrece ningún hueco). Así la campaña del martes propone solo
  // dentro del horario semanal real de cada profesor.
  if (profAvail && Object.keys(profAvail).length) {
    return [...(profAvail[dayKey] || [])].sort();
  }
  // Profesor sin ninguna disponibilidad configurada todavía: horario por defecto.
  return [...HOURS_DEFAULT].sort();
}

// ¿Choca una clase con una hora bloqueada? Una clase ocupa [hora, hora+45), y
// la rejilla de bloqueos va de 15 en 15 min. Antes solo se miraba la hora de
// INICIO, así que al bloquear "de 9:00 a 15:00" una clase que empezara a las
// 08:45 (y terminara a las 09:30) se colaba dentro del bloqueo. Ahora se
// comprueban todos los tramos que ocupa la clase.
function isBlockedSlotSync(blocked, profId, date, hour, dur = SLOT_MIN) {
  const ini = toMin(String(hour).substring(0, 5));
  for (let m = ini; m < ini + dur; m += 15) {
    const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (blocked[`${profId}_${String(date).substring(0, 10)}_${hh}`]) return true;
  }
  return false;
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

// Última fecha (sábado) de la semana que viene. Tope para NO proponer clases
// más allá de una sola semana.
function nextWeekLastDate() {
  const w = nextWeekDates();
  return w[w.length - 1].date;
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

// Duración estándar de una clase práctica (minutos). Fuente única de verdad.
const SLOT_MIN = 45;
function toMin(t){ const [h,m] = String(t).substring(0,5).split(':').map(Number); return h*60+(m||0); }
function addMinutes(hhmm, mins){ const t = toMin(hhmm) + mins; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; }
function rangesOverlap(aStart, aDur, bStart, bDur){ return aStart < bStart+bDur && bStart < aStart+aDur; }
// ¿Existe ya una clase que SE SOLAPE con [time, time+dur) para ese profe/día?
// Clave para que clases de 45 min no se pisen (evita el "desfase" de horas).
function overlapsExisting(slots, profId, date, time, dur = SLOT_MIN){
  const aStart = toMin(time);
  const d10 = String(date).substring(0,10);
  return slots.some(s => {
    if (!(s.profId === profId || s.prof_id === profId)) return false;
    if (String(s.date).substring(0,10) !== d10) return false;
    if (!(s.studentId || s.student_id)) return false;
    if (s.status === 'cancelled') return false;
    return rangesOverlap(aStart, dur, toMin(String(s.time).substring(0,5)), s.duration || SLOT_MIN);
  });
}

// ── Buffer de cambio de vehículo (SOLO Pedro) ──
// Pedro necesita 15 min extra para cambiar de coche cuando dos clases seguidas
// son de distinto tipo de vehículo. Así el bot nunca ofrece/reserva un hueco
// pegado a otra clase de vehículo distinto: siempre deja los 15 min. Solo
// aplica a Pedro y a fechas futuras (a partir de mañana): no toca las de hoy.
const PEDRO_ID = process.env.PEDRO_PROF_ID || 'prof_pedro';
const VEH_CHANGE_MIN = 15;
function isFutureLocalDate(date) {
  return String(date).substring(0, 10) > ymdLocal(new Date());
}
async function buildVehMap() {
  const students = await loadStudents();
  const m = {};
  for (const s of students) if (s.id) m[s.id] = s.vehicleType || null;
  return m;
}
// ¿Hay una clase adyacente de OTRO tipo de vehículo a menos de 15 min? En ese
// caso Pedro no llega a cambiar de coche → ese hueco no vale. Solo para Pedro.
function pedroVehConflict(slots, date, time, bookerVeh, vehOf, dur = SLOT_MIN) {
  if (!bookerVeh || !vehOf) return false;
  const aStart = toMin(time), aEnd = aStart + dur;
  const d10 = String(date).substring(0, 10);
  return slots.some(s => {
    if (!(s.profId === PEDRO_ID || s.prof_id === PEDRO_ID)) return false;
    if (String(s.date).substring(0, 10) !== d10) return false;
    const sid = s.studentId || s.student_id;
    if (!sid) return false;
    if (s.status === 'cancelled') return false;
    const otherVeh = vehOf[sid] || null;
    if (!otherVeh || otherVeh === bookerVeh) return false; // mismo vehículo o desconocido: sin buffer
    const bStart = toMin(String(s.time).substring(0, 5));
    const bEnd = bStart + (s.duration || SLOT_MIN);
    if (aStart >= bEnd) return (aStart - bEnd) < VEH_CHANGE_MIN; // clase nueva va DESPUÉS
    if (bStart >= aEnd) return (bStart - aEnd) < VEH_CHANGE_MIN; // clase nueva va ANTES
    return false; // se solapan → ya lo pilla overlapsExisting
  });
}
// ¿Pedro ya tiene ese día una clase del MISMO vehículo pegada (o casi) a este
// hueco? Se usa para AGRUPAR: preferimos ofrecer los huecos contiguos del mismo
// coche para que las clases salgan seguidas y Pedro no cambie de coche. Solo Pedro.
function pedroSameVehAdjacent(slots, date, time, bookerVeh, vehOf, dur = SLOT_MIN) {
  if (!bookerVeh || !vehOf) return false;
  const aStart = toMin(time), aEnd = aStart + dur;
  const d10 = String(date).substring(0, 10);
  return slots.some(s => {
    if (!(s.profId === PEDRO_ID || s.prof_id === PEDRO_ID)) return false;
    if (String(s.date).substring(0, 10) !== d10) return false;
    const sid = s.studentId || s.student_id;
    if (!sid || s.status === 'cancelled') return false;
    if ((vehOf[sid] || null) !== bookerVeh) return false; // solo MISMO vehículo
    const bStart = toMin(String(s.time).substring(0, 5));
    const bEnd = bStart + (s.duration || SLOT_MIN);
    const gap = aStart >= bEnd ? aStart - bEnd : (bStart >= aEnd ? bStart - aEnd : 0);
    return gap <= VEH_CHANGE_MIN; // pegada o dentro del margen de cambio
  });
}

async function nextFreeSlots(profId, count = 8, fromDate = null, pistaHours = null, bookerVehType = null, untilDate = null) {
  // Una sola ronda de consultas en paralelo (antes: una por día/hora → lento)
  const [slots, examDays, avail, blocked] = await Promise.all([
    loadSlots(), loadExamDays(), loadAvailability(), loadBlocked(),
  ]);
  // Mapa alumno→vehículo solo si es Pedro (para el buffer de cambio de coche)
  const vehOf = (profId === PEDRO_ID && bookerVehType) ? await buildVehMap() : null;
  // Anclar al mediodía local: evita desplazamientos de día por zona horaria
  const start = fromDate ? new Date(`${String(fromDate).substring(0, 10)}T12:00:00`) : new Date();
  if (!fromDate) start.setDate(start.getDate() + 1);
  start.setHours(12, 0, 0, 0);

  const free = [];
  // Pedro: agrupar por vehículo (solo si sabemos el vehículo del alumno)
  const clusterPedro = (profId === PEDRO_ID && vehOf && bookerVehType);
  for (let d = 0; d < 60 && free.length < count; d++) {
    const dt  = new Date(start);
    dt.setDate(start.getDate() + d);
    const dow  = dt.getDay();
    if (dow === 0) continue; // sin domingos
    const date  = ymdLocal(dt);
    if (untilDate && date > untilDate) break; // no proponer más allá de la semana tope
    if (examDays.includes(date)) continue; // día de examen: sin clases
    // Horario de pista: si el alumno es de pista, solo estas horas ese día
    const pistaDia = pistaHours ? (pistaHours[DAY_KEY_MAP[dow]] || []) : null;

    // Recolectamos los huecos válidos del día y luego (Pedro) los reordenamos
    const dayHoles = [];
    for (const hour of hoursForProfDaySync(avail, profId, dow)) {
      if (pistaDia && !pistaDia.includes(hour)) continue; // fuera del horario de pista
      if (isBlockedSlotSync(blocked, profId, date, hour)) continue;
      // Ocupado si CUALQUIER clase existente se solapa con estos 45 min (no solo
      // si empieza a la misma hora). Así las clases nunca se pisan.
      const taken = overlapsExisting(slots, profId, date, hour);
      if (taken) continue;
      // Pedro: dejar 15 min si la clase de al lado es de otro tipo de vehículo
      if (profId === PEDRO_ID && isFutureLocalDate(date) &&
          pedroVehConflict(slots, date, hour, bookerVehType, vehOf)) continue;
      dayHoles.push({
        date,
        time:    hour,
        dayName: DAY_LABELS[dow],
      });
    }
    // Pedro: dentro del día, primero los huecos pegados a una clase del MISMO
    // vehículo (para que salgan seguidas); el resto conserva su orden horario.
    if (clusterPedro && dayHoles.length > 1) {
      const adj = dayHoles.filter(h => pedroSameVehAdjacent(slots, h.date, h.time, bookerVehType, vehOf));
      if (adj.length && adj.length < dayHoles.length) {
        const adjTimes = new Set(adj.map(h => h.time));
        const rest = dayHoles.filter(h => !adjTimes.has(h.time));
        dayHoles.length = 0;
        dayHoles.push(...adj, ...rest);
      }
    }
    for (const hole of dayHoles) {
      if (free.length >= count) break;
      free.push(hole);
    }
  }
  return free;
}

async function isSlotFree(profId, date, time) {
  const [slots, examDays, blocked, avail] = await Promise.all([
    loadSlots(), loadExamDays(), loadBlocked(), loadAvailability(),
  ]);
  const d10 = String(date).substring(0, 10);
  const hh  = String(time).substring(0, 5);
  if (examDays.includes(d10)) return false;
  // El profesor tiene que TRABAJAR ese día a esa hora. Faltaba comprobarlo:
  // las horas del flujo normal salen de nextFreeSlots (que sí lo respeta),
  // pero la clase doble elige la hora por su cuenta y podía colarse fuera del
  // horario del profesor (p. ej. doblar la última clase de la tarde).
  const dow = new Date(d10 + 'T12:00:00').getDay();
  if (!hoursForProfDaySync(avail, profId, dow).includes(hh)) return false;
  if (isBlockedSlotSync(blocked, profId, d10, hh)) return false;
  return !overlapsExisting(slots, profId, d10, hh);
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

// Lista formateada de TODAS las próximas clases del alumno (leídas de la base),
// para que los resúmenes muestren todas y no solo las de la conversación actual.
async function listaClasesAlumno(studentId) {
  const mine = await upcomingSlotsFor(studentId, 30);
  return mine.map(s => `• ${slotLabel(s)}`).join('\n');
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
  return ['listo','gracias','ya esta','ya está','fin','nada mas','nada más','suficiente',
          'adios','adiós','hasta luego','hasta pronto','chao','chau','eso es todo','asi esta bien','así está bien']
    .some(w => n.includes(w)) || n === 'ya';
}

// Reconocimiento suave: "ok", "vale", "perfecto"… No es una orden de reservar.
// Dentro de una conversación, si ya hay clases hechas, cierra; si no, no molesta.
function isSoftAck(t) {
  const n = norm(t);
  if (!n) return false;
  if (['ok','oka','okey','okay','vale','va','dale','bien','guay'].includes(n)) return true;
  return ['perfect','genial','estupend','fenomenal','de acuerdo','correcto','entendido','de nada','muy bien']
    .some(w => n.includes(w));
}

// ¿El alumno quiere reservar/gestionar clases? Solo entonces arranca la propuesta.
// Evita que un "gracias/ok/perfecto" reactive el menú de horas.
function wantsBooking(body) {
  const p = parseBookingText(body);
  if (p.dow || p.hour) return true;
  const n = norm(body);
  return /(hola|buenas|hey|holi|saludos|reserv|cita|apunt|conducir|practic|clase|coche|empez|empiez|organiz|quiero|queria|querria|necesito|me gustaria|puedo|podria|disponib|hueco|horario|semana|dame|ponme)/.test(n);
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

  let hour = null, dom = null;
  const setHour = (h, m) => {
    h = parseInt(h, 10); m = m == null ? 0 : parseInt(m, 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59)
      hour = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  };

  // ── Hora CON minutos, tolerando cómo la escribe la gente ──
  // 11:45 · 11.45 · 11,45 · 11y45 · 11h45 · 1145
  // Ojo: "y"/"h" solo valen de separador SIN espacios. Con espacios, "19 y 20"
  // son dos DÍAS, no las 19:20 (era un fallo real).
  const conMin = t.match(/\b(\d{1,2})\s*[:.;]\s*(\d{2})\b/)
              || t.match(/\b(\d{1,2}),(\d{2})\b/)
              || t.match(/\b(\d{1,2})[yh](\d{2})\b/)
              || t.match(/\b(\d{2})(\d{2})\b(?!\d)/);
  let resto = t;
  if (conMin) { setHour(conMin[1], conMin[2]); resto = t.replace(conMin[0], ' '); }
  if (!hour) { const m2 = resto.match(/\b(\d{1,2})\s*h\b/);   if (m2) { setHour(m2[1], 0); resto = resto.replace(m2[0], ' '); } }
  if (!hour) { const m3 = resto.match(/\blas\s+(\d{1,2})\b/); if (m3) { setHour(m3[1], 0); resto = resto.replace(m3[0], ' '); } }

  // ── Día del MES ──────────────────────────────────────────
  // La semana que se ofrece (17-22) usa números que también son horas válidas
  // (17:00-20:00), así que "miércoles 19" se leía como las 19:00. Reglas:
  //  · "el 19" / "día 19"            → fecha (nunca hora)
  //  · día de la semana + número     → fecha (nunca hora)
  //  · número suelto                 → candidato a las DOS cosas; decide el
  //    flujo, que es quien sabe qué fechas y qué horas hay libres.
  const mDia = resto.match(/\b(?:dia|el)\s+(\d{1,2})\b/);
  if (mDia) { const d = parseInt(mDia[1], 10); if (d >= 1 && d <= 31) dom = d; }
  if (dom == null) {
    const suelto = resto.match(/\b(\d{1,2})\b/);
    if (suelto) {
      const v = parseInt(suelto[1], 10);
      if (v >= 1 && v <= 31) {
        if (dow != null || hour) dom = v;                       // fecha segura
        else { dom = v; if (v >= 7 && v <= 21) setHour(v, 0); }  // ambiguo
      }
    }
  }

  return { dow, hour, dom };
}

// ════════════════════════════════════════════════════════════
// WHATSAPP Y NOTIFICACIONES
// ════════════════════════════════════════════════════════════

// fetch con reintentos para la API de Meta. Ante un fallo TRANSITORIO (red
// caída, 429 rate-limit, 5xx del servidor) reintenta con espera creciente, para
// que un bache puntual no pierda un mensaje. Ante un error DEFINITIVO (4xx como
// token inválido o número mal formado) devuelve la respuesta sin reintentar.
async function metaFetch(url, options, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, options);
      if (r.ok || (r.status < 500 && r.status !== 429)) return r;
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error('Meta no disponible tras reintentos: ' + last);
}

// Anti-duplicados: Meta puede reenviar el mismo webhook. Recordamos los últimos
// ids de mensaje procesados para no atenderlos (ni reservar) dos veces.
const seenMsgIds = new Map();
function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  if (seenMsgIds.size > 800) {                     // purga de ids con más de 10 min
    for (const [k, t] of seenMsgIds) if (now - t > 600000) seenMsgIds.delete(k);
  }
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.set(id, now);
  return false;
}

// Guarda cada mensaje (entrante/saliente) en Supabase para el historial de
// chats del CRM. Nunca lanza: si falla, solo se pierde ese registro de log.
async function logMessage(phone, direction, body) {
  if (!USE_SUPABASE || !SCHOOL_ID) return;
  try {
    await supabase.from('messages').insert({
      school_id: SCHOOL_ID,
      phone:     normalizePhone(phone),
      direction,
      body:      String(body || '').slice(0, 4000),
    });
  } catch (e) { console.error('logMessage:', e.message); }
}

async function sendWA(to, body) {
  to = normalizePhone(to);
  logMessage(to, 'out', body); // registro para el historial (no bloquea el envío)
  if (PROVIDER === 'sms')    return sendSMS(to, body);
  if (PROVIDER === 'meta')   return sendWA_meta(to, body);
  if (PROVIDER === 'twilio') return sendWA_twilio(to, body);
  console.log(`🚫 (sin proveedor) mensaje NO enviado a ${to}: ${body.substring(0, 60).replace(/\n/g, ' ')}`);
}

// ── Envío por SMS (Twilio) — sin Meta, sin "join", funciona hoy ──
async function sendSMS(to, body) {
  try {
    // SMS no admite *negritas*; las quitamos para que se vea limpio
    const txt = body.replace(/\*/g, '');
    await client.messages.create({ from: SMS_NUM, to, body: txt });
    console.log(`📤 (sms) → ${to}: ${txt.substring(0, 80).replace(/\n/g, ' ')}`);
  } catch (e) {
    console.error(`❌ SMS → ${to}:`, e.message);
  }
}

// ── Envío por Meta Cloud API ──
async function sendWA_meta(to, body) {
  const num = String(to).replace(/^\+/, ''); // Meta quiere el número sin '+'
  try {
    const r = await metaFetch(`https://graph.facebook.com/${META_API_VER}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: num,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error(`❌ Meta → ${to}: ${r.status} ${err.substring(0, 200)}`);
      return;
    }
    console.log(`📤 (meta) → ${to}: ${body.substring(0, 80).replace(/\n/g, ' ')}`);
  } catch (e) {
    console.error(`❌ Meta → ${to}:`, e.message);
  }
}

// ── Envío de PLANTILLA por Meta (para mensajes fuera de la ventana 24h) ──
// components: array de parámetros de la plantilla (opcional)
async function sendTemplateMeta(to, templateName, params = [], lang = 'es') {
  if (PROVIDER !== 'meta') return sendWA(to, '(plantilla no disponible sin Meta)');
  const num = String(normalizePhone(to)).replace(/^\+/, '');
  const body = {
    messaging_product: 'whatsapp', to: num, type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(params.length ? { components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] } : {}),
    },
  };
  try {
    const r = await metaFetch(`https://graph.facebook.com/${META_API_VER}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error(`❌ Meta plantilla → ${to}: ${r.status} ${(await r.text()).substring(0, 200)}`);
    else console.log(`📤 (meta·plantilla ${templateName}) → ${to}`);
  } catch (e) { console.error(`❌ Meta plantilla → ${to}:`, e.message); }
}

// ── Envío por Twilio ──
async function sendWA_twilio(to, body) {
  try {
    await client.messages.create({ from: SANDBOX_NUM, to: `whatsapp:${to}`, body });
    console.log(`📤 (twilio) → ${to}: ${body.substring(0, 80).replace(/\n/g, ' ')}`);
  } catch (e) {
    console.error(`❌ Twilio → ${to}:`, e.message);
  }
}

// ── Mensaje que INICIA el bot (campaña, recordatorio) ──
// Meta exige plantilla aprobada fuera de la ventana de 24h. En Meta se envía
// como plantilla; en Twilio (o dentro de la ventana) va como texto libre.
async function sendBusinessInitiated(to, templateName, params, fallbackText) {
  if (PROVIDER === 'meta') return sendTemplateMeta(to, templateName, params);
  return sendWA(to, fallbackText);
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

function makeSuggestState(st, freeSlots, weekMode = false, pistaHours = null) {
  return {
    type:        'suggest',
    studentId:   st.id,
    studentName: st.name,
    profId:      st.profId ?? st.prof_id,
    slots:       freeSlots,
    idx:         0,
    booked:      [],       // clases reservadas en esta conversación
    currentDate: null,     // día cuyas horas se le están mostrando al alumno
    weekMode,              // true: solo ofrecer huecos de la semana que viene
    pistaHours,            // filtro de horas de pista (null = sin restricción)
    vehType:     st.vehicleType ?? st.vehicle_type ?? null, // para el buffer de Pedro
    expires:     thuExpiry(),
  };
}

// Fecha de inicio para ofrecer huecos según el modo
function suggestFromDate(state) {
  return state?.weekMode ? ymdLocal(nextWeekMonday()) : null;
}

// Agrupa los huecos libres por DÍA (respetando el orden de fecha/hora) y
// devuelve [{date, dayName, slots:[...]}], saltando los días de excludeDates.
// Es la base del flujo "elige tu hora": al alumno se le muestran las horas
// libres de un día y él responde con la que quiere.
function daysWithSlots(freeSlots, excludeDates = []) {
  const skip = new Set(excludeDates.map(d => String(d).substring(0, 10)));
  const byDate = new Map();
  for (const s of freeSlots) { // freeSlots viene ordenado por fecha+hora
    const d = String(s.date).substring(0, 10);
    if (skip.has(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { date: d, dayName: s.dayName, slots: [] });
    byDate.get(d).slots.push(s);
  }
  return [...byDate.values()];
}

// Mensaje que enseña las horas libres de un día para que el alumno elija.
function dayMenuMessage(day, prefix = '') {
  const horas = day.slots.map(s => s.time).join(' · ');
  const ej = day.slots[0].time;
  return `${prefix}📅 *${day.dayName} ${formatDate(day.date)}* — horas libres:\n` +
         `🕐 ${horas}\n\n` +
         `Responde con la hora que quieras (por ej. *${ej}*). ` +
         `Para ver otro día escribe *otro día*; cuando termines, *listo*.`;
}

// Resumen de TODOS los días con hueco (cuando el alumno ya los ha visto todos).
// Evita el bucle de "otro día" entre dos días: se le enseñan todos de golpe.
function allDaysOverview(days) {
  const bloques = days.map(d =>
    `📅 *${d.dayName} ${formatDate(d.date)}*\n🕐 ${d.slots.map(s => s.time).join(' · ')}`
  ).join('\n\n');
  const ej = days[0].slots[0].time;
  return `${bloques}\n\nResponde con el día y la hora que quieras (por ej. *${days[0].dayName} ${ej}*). Cuando termines, *listo*.`;
}

// Filtro de horas de pista para un alumno según su fase
// Carnets que NO tienen examen de pista (según la tabla DGT de la autoescuela):
// su fase siempre es circulación, nunca se limita a horas de pista.
const CARNETS_SIN_PISTA = new Set(['B']);

async function pistaFilterFor(st) {
  // Un carnet sin examen de pista (p.ej. B) nunca se restringe a horas de pista,
  // aunque en los datos figure "pista" por error. Evita desfases con el carnet.
  if (st.license && CARNETS_SIN_PISTA.has(st.license)) return null;
  if ((st.fase || 'pista') !== 'pista') return null; // circulación: sin límite
  return await loadPistaHours();                      // pista: solo horas de pista
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
  // Antes de nada, quitar hilos caducados: si no, esos alumnos se saltarían la
  // campaña por una conversación vieja que ya no está viva.
  await purgeExpiredPending();

  const students = allStudents.filter(s => s.active && s.phone && s.botActive !== false);
  const slots    = await loadSlots();
  const weekDates = nextWeekDates().map(w => w.date);
  const dow = todayDow(); // 2=mar (inicial), 3=mié (recordatorio), 4=jue (último día)
  let sent = 0, skipped = 0;

  const nextMon = ymdLocal(nextWeekMonday());
  let fallidos = 0;
  for (const st of students) {
    // Red de seguridad por alumno: si uno falla (teléfono raro, bache de Meta,
    // error puntual de BD) se registra y la campaña SIGUE con los demás. Antes
    // un solo fallo cortaba el envío y el resto se quedaba sin mensaje.
    try {
    if (pending[st.phone]) { console.log(`⏭️  ${st.name} ya en conversación`); continue; }

    // Si ya tiene clases la semana que viene, no molestar en los recordatorios
    const yaReservo = slots.some(
      s => (s.studentId ?? s.student_id) === st.id
        && weekDates.includes(String(s.date).substring(0, 10))
        && s.status !== 'cancelled'
    );
    if (yaReservo && !force) { skipped++; continue; }

    const profId = st.profId ?? st.prof_id;
    const pistaHours = await pistaFilterFor(st);
    const free = await nextFreeSlots(profId, 8, nextMon, pistaHours, st.vehicleType, nextWeekLastDate());
    if (!free.length) {
      await sendWA(st.phone, `Hola ${st.name} 👋\nNo hay huecos disponibles la semana que viene. Contacta con la autoescuela.`);
      continue;
    }

    const day0 = daysWithSlots(free)[0];
    const urgencia =
      dow === 4 ? `⚠️ *ÚLTIMO DÍA*: el plazo cierra HOY a medianoche.` :
      dow === 3 ? `⚠️ El plazo cierra mañana jueves.` :
                  `⚠️ Tienes hasta el jueves para reservar.`;

    // Texto de reserva (Twilio / fallback): invita a elegir la hora directamente.
    const msg =
      `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*.\n\n` +
      `Vamos a organizar tus clases de la semana que viene.\n\n` +
      dayMenuMessage(day0, '') + `\n\n` + urgencia;

    // Mensaje que INICIA el bot → en Meta va la plantilla (solo abre la
    // conversación); al responder, el bot enseña las horas para elegir.
    await sendBusinessInitiated(st.phone, TPL_PROPUESTA, [st.name], msg);
    const stt = makeSuggestState({ ...st, profId }, free, true, pistaHours);
    stt.currentDate = day0.date;
    pending[st.phone] = stt;
    await persistPending(st.phone);
    sent++;
    } catch (e) {
      fallidos++;
      console.error(`❌ Campaña: fallo con ${st.name} (${st.phone}): ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`✅ Campaña: ${sent} contactados · ${skipped} ya tenían clases (no molestados)` +
              (fallidos ? ` · ⚠️ ${fallidos} con error` : ''));
  if (fallidos) {
    await sendWA(NOTIFY_ADMIN,
      `⚠️ *Campaña de ${SCHOOL_NAME}*\n\n${sent} alumnos contactados, pero ${fallidos} han fallado.\n` +
      `Revisa el log de Railway para ver cuáles.`).catch(() => {});
  }
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

    const cita = `${slot.dayName || formatDate(slot.date)} a las ${slot.time}h`;
    const msg =
      `⏰ *Recordatorio de ${SCHOOL_NAME}*\n\n` +
      `Hola ${st.name}, tienes clase el *${cita}*.\n\n` +
      `Si no puedes venir, avisa a la oficina: *${OFFICE_PHONE}*.\n` +
      `Si no dices nada, la clase se mantiene. ✅`;

    await sendBusinessInitiated(st.phone, TPL_RECORDATORIO, [st.name, cita], msg);
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

let _slotSeq = 0;
async function bookSlot(studentId, studentName, profId, slot, bookerVehType = null) {
  // Guarda anti-solape: entre ofrecer la hora y reservarla, otra reserva pudo
  // ocupar un tramo que se solapa (el índice único solo pilla la MISMA hora
  // exacta, no un solape de 45 min). Si se solapa, no reservamos.
  const existentes = await loadSlots();
  if (overlapsExisting(existentes, profId, slot.date, String(slot.time).substring(0,5))) {
    console.error(`❌ Reserva NO guardada (se solapa con otra clase): ${studentName} → ${slot.date} ${slot.time}`);
    return null;
  }
  // Última barrera contra las horas BLOQUEADAS por el admin. Los flujos ya
  // filtran antes, pero entre ofrecer la hora y guardarla el admin puede haber
  // bloqueado ese rango. Aquí no se reserva ni por error.
  const bloqueadas = await loadBlocked();
  if (isBlockedSlotSync(bloqueadas, profId, slot.date, String(slot.time).substring(0,5))) {
    console.error(`❌ Reserva NO guardada (hora bloqueada por la autoescuela): ${studentName} → ${slot.date} ${slot.time}`);
    return null;
  }
  // Pedro: no reservar pegado a una clase de otro vehículo (necesita 15 min
  // para el cambio de coche). Solo Pedro y solo fechas futuras.
  if (profId === PEDRO_ID && isFutureLocalDate(slot.date)) {
    const vehOf = await buildVehMap();
    const veh = bookerVehType ?? vehOf[studentId] ?? null;
    if (pedroVehConflict(existentes, slot.date, String(slot.time).substring(0,5), veh, vehOf)) {
      console.error(`❌ Reserva NO guardada (Pedro necesita 15 min para cambio de vehículo): ${studentName} → ${slot.date} ${slot.time}`);
      return null;
    }
  }
  // Sufijo incremental: evita colisión de PK al reservar varias clases
  // en el mismo milisegundo (atajo "3 clases")
  const newSlot = {
    id:           `slot_${Date.now()}_${(_slotSeq++).toString(36)}`,
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
  // Si el guardado falla (p.ej. el hueco se ocupó entre la comprobación y el
  // INSERT → viola el índice único prof+fecha+hora), NO confirmamos nada.
  const saved = await insertSlot(newSlot);
  if (!saved) {
    console.error(`❌ Reserva NO guardada (hueco ocupado o error): ${studentName} → ${slot.date} ${slot.time}`);
    return null;
  }
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

// Validación de firma: solo Twilio (que firma con el Auth Token) puede
// invocar el webhook. Se activa sola en producción (Railway); en local
// se omite. Escape de emergencia: TWILIO_VALIDATE=off
function twilioSignatureOk(req) {
  if (process.env.TWILIO_VALIDATE === 'off') return true;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain || !AUTH_TOKEN) return true; // entorno local/desarrollo
  const url = `https://${domain}${req.originalUrl}`;
  const sig = req.headers['x-twilio-signature'] || '';
  try {
    return twilio.validateRequest(AUTH_TOKEN, sig, url, req.body || {});
  } catch (e) {
    return false;
  }
}

// Validación de firma de Meta: cada webhook llega firmado con el secreto de la
// app en la cabecera X-Hub-Signature-256. Solo se exige cuando META_APP_SECRET
// está configurado; sin él no hay con qué comparar.
function metaSignatureOk(req) {
  if (!META_APP_SECRET) return true;          // no configurado: no se valida
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  // timingSafeEqual exige la misma longitud; distinta longitud ya es un fallo
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Verificación del webhook de Meta (GET) ──
// Meta llama una vez con hub.challenge para confirmar la URL.
app.get('/bot', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook de Meta verificado');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Extrae { from, body } de una petición entrante (formato Meta o Twilio)
function parseIncoming(reqBody) {
  // Meta: { entry:[{ changes:[{ value:{ messages:[{ from, text:{body}, type }] } }] }] }
  const change = reqBody?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (msg) {
    // Solo mensajes de texto; ignorar status (delivered/read) y otros tipos
    const text = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? '';
    return { from: '+' + String(msg.from).replace(/^\+/, ''), body: String(text).trim(), provider: 'meta', id: msg.id || null };
  }
  // Twilio: { From:'whatsapp:+34...', Body:'...' }
  if (reqBody?.From) {
    return { from: String(reqBody.From).replace('whatsapp:', ''), body: String(reqBody.Body || '').trim(), provider: 'twilio', id: reqBody.MessageSid || null };
  }
  return null;
}

app.post('/bot', async (req, res) => {
  const isMeta = !!req.body?.entry;
  // Cada proveedor firma a su manera: Twilio con el Auth Token, Meta con el
  // secreto de la app. Se valida la que corresponda al origen de la petición.
  if (isMeta) {
    if (!metaSignatureOk(req)) {
      console.warn('🚫 Webhook de Meta con firma inválida — rechazado');
      return res.status(403).send('Forbidden');
    }
  } else if (!twilioSignatureOk(req)) {
    console.warn('🚫 Petición al webhook con firma inválida — rechazada');
    return res.status(403).send('Forbidden');
  }
  // Meta espera 200 rápido; respondemos ya y procesamos después
  if (isMeta) res.sendStatus(200);

  // Helper para cerrar la petición según el proveedor (Meta ya respondió arriba).
  // Se declara antes de cualquier uso para evitar el TDZ de `const`.
  const done = () => { if (!isMeta) res.send('<Response></Response>'); };

  // Blindaje: cualquier error al procesar un mensaje se captura aquí para que
  // NUNCA tumbe el proceso. Un mensaje raro o un fallo puntual de Supabase no
  // puede dejar el bot sin servicio ni borrar las conversaciones en curso.
  let convPhone = null;
  try {
  const parsed = parseIncoming(req.body);
  if (!parsed || !parsed.body) {           // status update u otro evento: ignorar
    done();
    return;
  }
  const from = parsed.from;
  convPhone = from;
  const body = parsed.body;
  // Idempotencia: si Meta reenvía el mismo webhook, no lo procesamos dos veces
  // (evita respuestas y reservas duplicadas).
  if (alreadySeen(parsed.id)) {
    console.log(`↩️  Mensaje duplicado ignorado (${parsed.id})`);
    done();
    return;
  }
  console.log(`\n📥 (${parsed.provider}) ${from}: "${body}"`);
  logMessage(from, 'in', body); // registro para el historial de chats

  let state = pending[from];

  // Un recordatorio pendiente no debe "comerse" un saludo ni una petición de
  // clase. Caso real: una alumna escribió "Hola" para reservar y el bot lo
  // tomó como "sí, voy" y le contestó "¡Te esperamos!". Si el mensaje es un
  // saludo o pide clase, se cierra el recordatorio (la clase sigue en pie) y
  // se atiende como una conversación normal.
  if (state && state.type === 'reminder' && !isNo(body)
      && /\b(hola|buenas|reserv\w*|pedir|quiero|queria|querria|clases?)\b/.test(norm(body))
      && !/(cancel\w*|anul\w*|quitar)/.test(norm(body))) {
    delete pending[from];
    state = null;
  }

  // ── Cancelación → la gestiona la OFICINA ──────────────
  // El bot NO cancela ninguna clase. Detecta la intención (cancelar/anular/
  // quitar) y deriva al móvil de la oficina. Funciona aunque el alumno esté a
  // mitad de otra conversación: se cierra el hilo abierto para no dejarlo
  // colgado y que el siguiente "hola" empiece limpio.
  // Incluye también CAMBIAR/MOVER una clase: es lo que más piden los alumnos
  // ("cambiar clase jueves a las 14:45", "podemos moverla al martes?") y, como
  // implica soltar la hora que ya tienen, lo gestiona la oficina igual que una
  // cancelación. Ojo: "cambia" a secas NO entra aquí — eso significa
  // "enséñame otro día" y lo atiende el flujo normal.
  if (/(cancel\w*|anul\w*|quitar)/.test(norm(body)) ||
      /\b(cambiar|cambiarla|cambio|mover|moverla|reprogram\w*|modificar)\b/.test(norm(body))) {
    const stC = (await loadStudents()).find(s => s.phone === from && s.active);
    // Solo se cierra el hilo si era una cancelación heredada. Si estaba
    // reservando, su conversación se MANTIENE: antes se borraba y el siguiente
    // mensaje ("jueves 20") empezaba de cero ignorando el día que pedía.
    if (pending[from] && pending[from].type === 'cancel') delete pending[from];
    await sendWA(from, cancelRedirectMsg(stC ? stC.name : ''));
    done(); return;
  }

  // ── Clase DOBLE: el alumno quiere 90 min = dos clases seguidas de 45 ──
  // Reconoce "doble", "dos horas", etc. Si el alumno indica DÍA y HORA en el
  // mensaje (p.ej. "miércoles 9:30 doble") se reservan esas dos medias horas
  // seguidas. Si no indica hora, se dobla su última clase reservada.
  if (/(clase doble|\bdoble\b|dos horas|2 horas|90 ?min|hora y media)/.test(norm(body))) {
    const stD = (await loadStudents()).find(s => s.phone === from && s.active);
    if (stD) {
      const profIdD = stD.profId ?? stD.prof_id;
      const pb = parseBookingText(body);
      // Una PREGUNTA sin día ni hora NO reserva. Caso real: un alumno escribió
      // "pero es doble?" y el bot le reservó 45 minutos de más. Si la pregunta
      // sí trae día u hora ("¿puedo una doble a las 12:00?") se atiende normal.
      if (/\?/.test(body) && !pb.hour && pb.dom == null && pb.dow == null) {
        await sendWA(from,
          `Sí, puedo reservarte una clase *doble* (90 min seguidos) 👍\n` +
          `Dime el día y la hora de inicio, por ejemplo *miércoles 9:30 doble*.`);
        done(); return;
      }
      let baseDate = null, t1 = null;
      if (pb.hour) {
        // El alumno dijo una hora concreta → esa es la 1ª media hora de la doble
        t1 = pb.hour.padStart(5, '0');
        if (pb.dow) { const df = dateForDow(pb.dow); baseDate = df ? df.date : null; }
        if (!baseDate) baseDate = (state && state.currentDate) || null;
        if (!baseDate) { const up = await upcomingSlotsFor(stD.id, 1); baseDate = up[0]?.date || null; }
      } else {
        // Sin hora → doblar la última clase reservada (o la próxima)
        let base = (state && Array.isArray(state.booked) && state.booked.length) ? state.booked[state.booked.length - 1] : null;
        if (!base) { const up = await upcomingSlotsFor(stD.id, 1); base = up[0] || null; }
        if (base) { baseDate = String(base.date).substring(0, 10); t1 = String(base.time).substring(0, 5); }
      }
      if (!baseDate || !t1) {
        await sendWA(from, `Para una clase *doble* dime el día y la hora, por ej. *miércoles 9:30 doble*. 🚗`);
        done(); return;
      }
      // El mismo tope que el resto del bot: no se reserva más allá de la
      // semana que viene. Este flujo se lo saltaba porque elige la fecha solo.
      const topeDoble = nextWeekLastDate();
      if (baseDate > topeDoble) {
        await sendWA(from,
          `Solo puedo reservar hasta el *${formatDate(topeDoble)}* 🗓️\n` +
          `Dime un día antes de esa fecha y te preparo la clase doble.`);
        done(); return;
      }
      const t2 = addMinutes(t1, SLOT_MIN);
      const dayName = DAY_LABELS[new Date(baseDate + 'T12:00:00').getDay()];
      // t1 puede ser ya una clase del propio alumno (dobla sobre ella)
      const mis = await upcomingSlotsFor(stD.id, 30);
      const tieneT1 = mis.some(s => String(s.date).substring(0,10) === baseDate && String(s.time).substring(0,5) === t1);
      const t1ok = tieneT1 || (await isSlotFree(profIdD, baseDate, t1));
      const t2ok = await isSlotFree(profIdD, baseDate, t2);
      if (t1ok && t2ok) {
        let ok = true;
        if (!tieneT1) { const s1 = await bookSlot(stD.id, stD.name, profIdD, { date: baseDate, time: t1, dayName }, stD.vehicleType); ok = !!s1; }
        if (ok) { const s2 = await bookSlot(stD.id, stD.name, profIdD, { date: baseDate, time: t2, dayName }, stD.vehicleType); ok = !!s2; }
        if (ok) {
          const resumen = await listaClasesAlumno(stD.id);
          await sendWA(from,
            `✅ ¡Hecho! Clase *doble* (90 min): *${dayName} ${formatDate(baseDate)} de ${t1} a ${addMinutes(t2, SLOT_MIN)}*.\n\n` +
            `📋 *Tus clases:*\n${resumen}`);
          done(); return;
        }
      }
      await sendWA(from,
        `Para la *doble* del ${dayName} ${formatDate(baseDate)} necesito *${t1}* y *${t2}* libres seguidas, y ahora mismo no lo están. 😕\n` +
        `Dime otro día u hora (por ej. *${dayName.toLowerCase()} 9:30 doble*) y te reservo las dos seguidas. 🚗`);
      done(); return;
    }
  }

  // ── Sin contexto: alumno escribe espontáneamente ──────
  if (!state) {
    const allStudents = await loadStudents();
    const st = allStudents.find(s => s.phone === from && s.active);
    if (!st) {
      await sendWA(from, `Hola 👋 Soy el asistente de *${SCHOOL_NAME}*. No encuentro tu número en el sistema — contacta con la autoescuela para darte de alta.`);
      done();
      return;
    }

    const profId = st.profId ?? st.prof_id;
    const t0 = norm(body);

    // ── "¿qué clases tengo?": consultar reservas ──
    // Consulta "¿qué clases tengo?". Las palabras clave van con LÍMITE de
    // palabra: sin él, "Quería pedir clase..." contenía "que" dentro de
    // "quería" y se respondía con el listado en vez de ofrecer hora (caso
    // real). Y si pide hora o día explícitos, es una reserva, no una consulta.
    if (/\bclases?\b/.test(t0) && /\b(mis|ver|que|qué|cuando|cuándo|tengo)\b/.test(t0)
        && !/cancel|anula/.test(t0)
        && !/\b(pedir|reservar|coger|quiero|queria|querría|dame|apunta)\b/.test(t0)) {
      const mine = await upcomingSlotsFor(st.id);
      if (!mine.length) {
        await sendWA(from, `Hola ${st.name} 👋 No tienes clases reservadas ahora mismo. Escríbeme *hola* y organizamos tu semana.`);
      } else {
        await sendWA(from,
          `📋 *Tus próximas clases:*\n` +
          mine.map(s => `• ${slotLabel(s)}`).join('\n') +
          `\n\nPara anular o cambiar alguna, escribe o llama a la oficina: *${OFFICE_PHONE}*.`
        );
      }
      done();
      return;
    }

    // Nota: "cancelar/anular/quitar" ya se atiende antes, en el bloque de
    // cancelación global, que deriva al móvil de la oficina. Aquí no hace falta.

    // Solo arrancamos la propuesta si el alumno REALMENTE quiere reservar.
    // Un "gracias/ok/perfecto" o un mensaje suelto no debe reproponer clases.
    if (!wantsBooking(body)) {
      await sendWA(from,
        `¡Un placer, ${st.name}! 🙌\n` +
        `Cuando quieras reservar o cambiar clases, escríbeme *hola* y lo vemos. 🚗`
      );
      done();
      return;
    }

    const nextMon = ymdLocal(nextWeekMonday());
    const pistaHours = await pistaFilterFor(st);
    const free = await nextFreeSlots(profId, 80, nextMon, pistaHours, st.vehicleType, nextWeekLastDate());
    if (!free.length) {
      await sendWA(from, `Hola ${st.name} 👋\nNo hay huecos disponibles la semana que viene. Llama a la autoescuela.`);
      done();
      return;
    }

    const day0 = daysWithSlots(free)[0];
    const st2 = makeSuggestState({ ...st, profId }, free, true, pistaHours);
    st2.currentDate = day0.date;
    pending[from] = st2;
    await sendWA(from,
      `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*. Vamos a organizar tus clases de la semana que viene.\n\n` +
      dayMenuMessage(day0, '')
    );
    done();
    return;
  }

  // ── Conversación expirada ─────────────────────────────
  if (Date.now() > state.expires) {
    delete pending[from];
    await sendWA(from, `El plazo de reserva ha cerrado. Te contactaremos el próximo martes. ¡Hasta pronto! 👋`);
    done();
    return;
  }

  // ── FLUJO: Cancelación (heredado) ─────────────────────
  // Ya no se crean estados de este tipo: las cancelaciones las gestiona la
  // oficina. Se conserva para atender con sentido las conversaciones que
  // quedaran abiertas desde antes del cambio, sin anular ninguna clase.
  if (state.type === 'cancel') {
    delete pending[from];
    await sendWA(from, cancelRedirectMsg(state.studentName));
    done();
    return;
  }

  // ── FLUJO: Recordatorio ───────────────────────────────
  if (state.type === 'reminder') {
    delete pending[from];
    if (isNo(body) || /(cancel\w*|anul\w*|quitar)/.test(norm(body))) {
      // El bot NO anula: la clase sigue reservada hasta que lo gestione la
      // oficina. Así el profesor nunca se queda con un hueco fantasma.
      await sendWA(from, cancelRedirectMsg(state.studentName));
    } else {
      await sendWA(from, `¡Perfecto! Te esperamos. 🚗`);
    }
    done();
    return;
  }

  // ── FLUJO: Sugerencia ─────────────────────────────────
  if (state.type === 'suggest') {
    const yaHechas = state.booked || [];
    // Cierre explícito ("listo/gracias/adiós"), o reconocimiento suave
    // ("ok/perfecto") cuando ya hay clases hechas → terminar sin re-preguntar.
    if (isDone(body) || (isSoftAck(body) && yaHechas.length)) {
      delete pending[from];
      const lista = await listaClasesAlumno(state.studentId);
      const resumen = lista
        ? `\n\n📋 *Tus clases reservadas:*\n${lista}\n\nTe recordaremos cada una 48h antes.`
        : '';
      await sendWA(from, `¡Perfecto ${state.studentName}!${resumen} 🚗`);
      done();
      return;
    }

    // Huecos libres actuales, agrupados por día (excluyendo los ya reservados)
    const bookedDates = (state.booked || []).map(b => b.date);
    const allFree = await nextFreeSlots(state.profId, 80, suggestFromDate(state), state.pistaHours, state.vehType, nextWeekLastDate());
    const days = daysWithSlots(allFree, bookedDates);

    if (!days.length) {
      delete pending[from];
      const lista = await listaClasesAlumno(state.studentId);
      const yaTiene = lista ? `\n\n📋 *Tus clases:*\n${lista}` : '';
      await sendWA(from, `No quedan más huecos libres esta semana.${yaTiene}\n\nSi necesitas algo más, llama a la autoescuela. 📞`);
      done();
      return;
    }

    const { dow, hour, dom } = parseBookingText(body);

    // Día del MES: si el número coincide con uno de los días ofertados, manda
    // la fecha. Así "miércoles 19" ya no se interpreta como las 19:00.
    const domDay = dom != null
      ? (days.find(d => Number(String(d.date).substring(8, 10)) === dom) || null)
      : null;

    // Un "no" JUSTO DESPUÉS de reservar significa "no quiero más clases", no
    // "enséñame otro día". Antes encadenaba días y el alumno acababa
    // reservando de más a base de decir que no.
    if (state.justBooked && !hour && !domDay && (isNo(body) || isDone(body))) {
      delete pending[from];
      const resumen = await listaClasesAlumno(state.studentId);
      await sendWA(from,
        `¡Perfecto ${state.studentName}! 👌\n\n📋 *Tus clases reservadas:*\n${resumen}\n\n` +
        `Te recordaremos cada una 48h antes. 🚗`);
      done();
      return;
    }

    // El alumno RECHAZA un día ("el jueves no puedo", "el lunes 17 no"). Antes
    // se detectaba el día y se le enseñaba justo ese día que acababa de
    // descartar. Si niega y no da hora, se pasa al siguiente día.
    if (!hour && /\bno\b|no puedo|imposible|no me viene/.test(norm(body))) {
      state.justBooked = false;
      const idxN = days.findIndex(d => d.date === state.currentDate);
      const sig = (idxN >= 0 && idxN + 1 < days.length) ? days[idxN + 1] : null;
      if (sig) {
        state.currentDate = sig.date;
        await sendWA(from, dayMenuMessage(sig, 'De acuerdo, ese día no. '));
      } else {
        state.currentDate = days[0].date;
        await sendWA(from, `Esos son todos los días con hueco de la semana que viene 🗓️\n\n` + allDaysOverview(days));
      }
      done();
      return;
    }

    // Número suelto que coincide con un día ofertado ("19" = ¿día 19 o las
    // 19:00?). Se enseña el DÍA, que es lo seguro: así nunca se reserva una
    // hora que el alumno no ha pedido.
    const ambiguo = dom != null && hour === `${String(dom).padStart(2, '0')}:00`;
    if (domDay && ambiguo) {
      state.justBooked = false;
      state.currentDate = domDay.date;
      await sendWA(from, dayMenuMessage(domDay, `Te enseño el ${domDay.dayName} ${formatDate(domDay.date)}. `));
      done();
      return;
    }

    // "otro día" / "no" → AVANZAR al siguiente día con huecos (por orden).
    // Antes solo se saltaba el día actual → hacía ping-pong entre 2 días.
    // Ahora avanza por índice; cuando ya se han visto todos, se enseñan todos
    // los días de golpe y se avisa de que no hay más.
    if (!hour && !domDay && (isNo(body) || /siguiente|otro dia|proxim|otra fecha|mas dias/.test(norm(body)))) {
      state.justBooked = false;
      const idx = days.findIndex(d => d.date === state.currentDate);
      if (idx >= 0 && idx + 1 < days.length) {
        const next = days[idx + 1];
        state.currentDate = next.date;
        await sendWA(from, dayMenuMessage(next, 'De acuerdo. '));
      } else if (days.length === 1) {
        state.currentDate = days[0].date;
        await sendWA(from, `Solo queda ese día con hueco esta semana 🗓️\n\n` + dayMenuMessage(days[0], ''));
      } else {
        // Ya los ha visto todos: resumen completo, sin volver a empezar el bucle
        state.currentDate = days[0].date;
        await sendWA(from, `Esos son todos los días con hueco de la semana que viene 🗓️\n\n` + allDaysOverview(days));
      }
      done();
      return;
    }

    // El alumno eligió una hora (con o sin día): reservar esa clase
    if (hour) {
      const hh = hour.padStart(5, '0');
      // La fecha del día del mes manda sobre todo lo demás ("el 19 a las 10:15")
      let targetDate = domDay ? domDay.date : state.currentDate;
      if (!domDay && dow) {
        // Preferir un día que SE LE ESTÉ OFRECIENDO. Si no, "el martes" podía
        // resolverse a una fecha fuera de la oferta y el bot respondía "ese día
        // no quedan huecos" para, acto seguido, enseñar ese mismo día.
        const enOferta = days.find(d => new Date(d.date + 'T12:00:00').getDay() === dow);
        const df = state.weekMode ? dateForDow(dow) : null;
        targetDate = enOferta ? enOferta.date
          : (df ? df.date
                : (allFree.find(s => new Date(s.date + 'T12:00:00').getDay() === dow)?.date || null));
      }
      if (!targetDate) targetDate = days[0].date;

      const dayObj = days.find(d => d.date === targetDate);
      const match = dayObj ? dayObj.slots.find(s => s.time === hh) : null;

      if (match) {
        if (!(await isSlotFree(state.profId, match.date, match.time))) {
          const libres = dayObj.slots.filter(s => s.time !== hh);
          if (libres.length) {
            await sendWA(from, `Vaya, las ${hh}h del ${dayObj.dayName} acaban de ocuparse 😅\n\n` + dayMenuMessage({ ...dayObj, slots: libres }, ''));
          } else {
            const otro = days.find(d => d.date !== dayObj.date) || days[0];
            state.currentDate = otro.date;
            await sendWA(from, `Vaya, esa hora acaba de ocuparse 😅\n\n` + dayMenuMessage(otro, 'Te propongo otro día. '));
          }
          done();
          return;
        }
        const saved = await bookSlot(state.studentId, state.studentName, state.profId, match, state.vehType);
        if (!saved) {
          // El hueco se ocupó entre la comprobación y el guardado (o error de
          // BD): NO confirmamos. Refrescamos huecos reales y re-ofrecemos.
          const freshFree = await nextFreeSlots(state.profId, 80, suggestFromDate(state), state.pistaHours, state.vehType, nextWeekLastDate());
          const freshDays = daysWithSlots(freshFree, (state.booked || []).map(b => b.date));
          if (!freshDays.length) {
            delete pending[from];
            await sendWA(from, `Vaya, ese hueco acaba de ocuparse y no quedan más esta semana 😔\nLlama a la autoescuela y te ayudamos. 📞`);
            done();
            return;
          }
          const d = freshDays.find(x => x.date === match.date) || freshDays[0];
          state.currentDate = d.date;
          await sendWA(from, `Vaya, las ${hh}h acaban de ocuparse justo ahora 😅\n\n` + dayMenuMessage(d, ''));
          done();
          return;
        }
        state.booked = state.booked || [];
        state.booked.push(match);

        const remaining = daysWithSlots(allFree, state.booked.map(b => b.date));
        // Resumen con TODAS las clases del alumno (ya guardada la recién hecha)
        const resumen = await listaClasesAlumno(state.studentId);
        if (!remaining.length) {
          delete pending[from];
          await sendWA(from, `✅ ¡Reservada! *${match.dayName} ${formatDate(match.date)} a las ${match.time}h*\n\n📋 *Tus clases:*\n${resumen}\n\nNo quedan más días libres. ¡Listo! 👌`);
          done();
          return;
        }
        const nextDay = remaining.find(d => d.date !== match.date) || remaining[0];
        state.currentDate = nextDay.date;
        state.justBooked = true;   // un "no" ahora significa "no quiero más"
        await sendWA(from,
          `✅ ¡Reservada! *${match.dayName} ${formatDate(match.date)} a las ${match.time}h*\n\n` +
          `📋 *Tus clases:*\n${resumen}\n\n` +
          dayMenuMessage(nextDay, '¿Quieres otra? ')
        );
        done();
        return;
      }

      // La hora pedida no está entre las libres de ese día
      if (dayObj) {
        await sendWA(from, `Esa hora no está libre el ${dayObj.dayName}. 🤔\n\n` + dayMenuMessage(dayObj, ''));
      } else {
        const d0 = days[0];
        state.currentDate = d0.date;
        await sendWA(from, `Ese día no quedan huecos. Te propongo otro:\n\n` + dayMenuMessage(d0, ''));
      }
      done();
      return;
    }

    // Pidió un día por su número ("el 19", "19 y 20"): enseñar sus horas
    if (domDay) {
      state.justBooked = false;
      state.currentDate = domDay.date;
      await sendWA(from, dayMenuMessage(domDay, ''));
      done();
      return;
    }

    // Preguntó por un día concreto (sin hora): enseñar sus horas
    if (dow) {
      const enOferta = days.find(d => new Date(d.date + 'T12:00:00').getDay() === dow);
      const df = state.weekMode ? dateForDow(dow) : null;
      const targetDate = enOferta ? enOferta.date
        : (df ? df.date
              : (allFree.find(s => new Date(s.date + 'T12:00:00').getDay() === dow)?.date || null));
      const dayObj = targetDate ? days.find(d => d.date === targetDate) : null;
      if (dayObj) {
        state.currentDate = dayObj.date;
        await sendWA(from, dayMenuMessage(dayObj, ''));
      } else {
        const d0 = days[0];
        state.currentDate = d0.date;
        await sendWA(from, `Ese día no quedan huecos libres. Te propongo otro:\n\n` + dayMenuMessage(d0, ''));
      }
      done();
      return;
    }

    // Cualquier otra cosa (SÍ / saludo / no reconocido): enseñar el día actual o el primero
    const cur = (state.currentDate && days.find(d => d.date === state.currentDate)) || days[0];
    state.currentDate = cur.date;
    state.justBooked = false;
    // Si venía un número y no se ha entendido, hay que DECIRLO. Antes se
    // repetía el menú en silencio y el alumno se quedaba creyendo que había
    // reservado (caso real: escribió "11y45" y se quedó sin clase).
    const pareceHora = /\d/.test(norm(body)) && !isYes(body);
    await sendWA(from, dayMenuMessage(cur, pareceHora
      ? 'No te he entendido 🤔 Dime solo la hora, por ejemplo *11:45*.\n\n'
      : ''));
    done();
    return;
  }

  done();
  } catch (err) {
    console.error('❌ Error procesando el mensaje entrante:', err && err.message ? err.message : err);
    try { done(); } catch (_) {}
  } finally {
    // Guardar en la nube el estado (o su borrado) tras atender el mensaje,
    // para que la conversación sobreviva a cualquier reinicio del bot.
    if (convPhone) persistPending(convPhone).catch(() => {});
  }
});

// ════════════════════════════════════════════════════════════
// CRONS
// ════════════════════════════════════════════════════════════

// Martes a las 9:00 → solicitar reservas
// El bot SOLO inicia conversación los MARTES a las 9:00. La ventana de reserva
// sigue abierta hasta el jueves 23:59 para que los alumnos respondan, pero el
// bot no vuelve a escribirles miércoles/jueves.
cron.schedule('0 9 * * 2', sendBookingRequests, { timezone: 'Europe/Madrid' });

// Cada hora → comprobar recordatorios 48h
cron.schedule('0 * * * *', sendReminders, { timezone: 'Europe/Madrid' });

// Comprueba a diario que el token de Meta sigue funcionando. Si deja de valer
// (caducó o perdió permisos), el bot no podría enviar mensajes: avisa al admin
// por WhatsApp para poder renovarlo antes de que afecte a los alumnos.
async function checkMetaToken() {
  if (PROVIDER !== 'meta') return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(
      `https://graph.facebook.com/${META_API_VER}/${META_PHONE_ID}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${META_TOKEN}` }, signal: ctl.signal }
    );
    clearTimeout(timer);
    if (r.ok) {
      console.log('✅ Token de Meta verificado (chequeo diario)');
    } else if (r.status >= 400 && r.status < 500) {
      // Solo un 4xx (token caducado / sin permisos) es un fallo DEFINITIVO del
      // token. Un 5xx o un timeout son baches de Meta: no disparan falsa alarma.
      const body = await r.json().catch(() => ({}));
      const motivo = body?.error?.message || `HTTP ${r.status}`;
      console.error(`🚨 Token de Meta NO válido: ${motivo}`);
      await sendWA(NOTIFY_ADMIN,
        `🚨 *Aviso del bot de ${SCHOOL_NAME}*\n\n` +
        `El token de WhatsApp ha dejado de funcionar (${motivo}).\n` +
        `El bot no puede enviar mensajes hasta renovarlo en Railway (META_TOKEN).`
      );
    } else {
      console.warn(`⚠️  Chequeo de token: Meta respondió ${r.status} (bache temporal, sin alarma)`);
    }
  } catch (e) { console.error('checkMetaToken (sin alarma):', e.message); }
}
// Todos los días a las 8:00 (antes de la campaña de los martes a las 9:00)
cron.schedule('0 8 * * *', checkMetaToken, { timezone: 'Europe/Madrid' });

// Jueves 23:59 → avisar a quien no reservó y limpiar pendientes
cron.schedule('59 23 * * 4', async () => {
  console.log('\n🔒 Cerrando ventana de reservas...');
  // Cierre en SILENCIO: el bot no escribe fuera del martes. Se limpian TODAS
  // las conversaciones abiertas, no solo las de alumnos activos: si no, los
  // hilos de cualquier otro número se quedaban para siempre.
  let n = 0;
  for (const phone of Object.keys(pending)) {
    delete pending[phone];
    await persistPending(phone);
    n++;
  }
  console.log(`🧹 Conversaciones cerradas: ${n}`);
}, { timezone: 'Europe/Madrid' });

// Cada hora, barrido de conversaciones caducadas (evita que se acumulen)
cron.schedule('30 * * * *', purgeExpiredPending, { timezone: 'Europe/Madrid' });

// ════════════════════════════════════════════════════════════
// RUTAS DE TEST
// ════════════════════════════════════════════════════════════

app.get('/test/hola', async (req, res) => {
  if (!requireKey(req, res)) return;
  await sendWA(NOTIFY_ADMIN, '👋 ¡Bot AutoEscuela activo!\n\nFlujos:\n📅 Mar-Jue 9:00 → solicitud de reserva\n⏰ Cada hora → recordatorios 48h antes\n🔒 Jue 23:59 → cierre de reservas');
  res.json({ ok: true });
});

// Los disparadores masivos requieren clave (BOT_API_KEY) si está configurada:
// evita que cualquiera con la URL lance campañas de WhatsApp a los alumnos.
function requireKey(req, res) {
  const key = process.env.BOT_API_KEY;
  if (!key) return true; // sin clave configurada: abierto (modo desarrollo)
  if ((req.query.key || req.headers['x-api-key']) === key) return true;
  res.status(403).json({ error: 'Clave incorrecta. Añade ?key=... o cabecera x-api-key' });
  return false;
}

app.get('/test/reservas', async (req, res) => {
  if (!requireKey(req, res)) return;
  await sendBookingRequests(true);
  res.json({ ok: true });
});

app.get('/test/recordatorios', async (req, res) => {
  if (!requireKey(req, res)) return;
  await sendReminders();
  res.json({ ok: true });
});

app.get('/status', async (req, res) => {
  const students = await loadStudents();
  const slots    = await loadSlots();
  res.json({
    modo:            USE_SUPABASE ? 'supabase' : 'json_local',
    whatsapp:        PROVIDER,
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

// GET /health — diagnóstico de la conexión con WhatsApp.
// Pregunta a Meta por el número configurado usando el token actual: si
// responde, el token es válido; si no, devuelve el motivo. Es la forma rápida
// de detectar la causa más habitual de que el bot deje de enviar mensajes
// (token caducado o sin acceso a la cuenta de WhatsApp).
app.get('/health', async (req, res) => {
  const out = {
    proveedor: PROVIDER,
    modo:      USE_SUPABASE ? 'supabase' : 'json_local',
  };
  if (PROVIDER !== 'meta') {
    out.ok = PROVIDER !== 'none';
    out.aviso = 'El proveedor activo no es Meta: no hay token de Meta que comprobar.';
    return res.json(out);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(
      `https://graph.facebook.com/${META_API_VER}/${META_PHONE_ID}` +
      `?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${META_TOKEN}` }, signal: ctl.signal }
    );
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      out.ok             = true;
      out.token_valido   = true;
      out.numero         = body.display_phone_number || null;
      out.nombre_visible = body.verified_name || null;
      out.calidad        = body.quality_rating || null;
    } else {
      out.ok           = false;
      out.token_valido = false;
      out.error        = body?.error?.message || `HTTP ${r.status}`;
      out.solucion     = 'Genera un token permanente en Meta (con acceso a todas las cuentas) y actualiza META_TOKEN en Railway.';
    }
  } catch (e) {
    out.ok           = false;
    out.token_valido = false;
    out.error = e.name === 'AbortError' ? 'Meta no respondió (timeout)' : e.message;
  } finally {
    clearTimeout(timer);
  }
  res.json(out);
});

// GET /api/ping
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: '3.0', modo: USE_SUPABASE ? 'supabase' : 'json_local' });
});

// NOTA: la API de datos (GET/POST/PATCH/DELETE de slots y students) se
// eliminó: exponía teléfonos de alumnos y permitía modificar datos sin
// autenticación. El CRM y el bot comparten los datos a través de Supabase.

// POST /api/send-booking/:studentId
app.post('/api/send-booking/:studentId', async (req, res) => {
  const students = await loadStudents();
  const st = students.find(s => s.id === req.params.studentId);
  if (!st)             return res.status(404).json({ error: 'Alumno no encontrado' });
  if (!st.phone)       return res.status(400).json({ error: 'El alumno no tiene teléfono' });
  if (st.botActive === false) return res.status(400).json({ error: 'Bot desactivado para este alumno' });
  // force=1 (o una conversación ya caducada) → reiniciar la charla desde cero.
  const forceRestart = req.query.force === '1' || req.body?.force === true;
  const cur = pending[st.phone];
  const caducada = cur && cur.expires && cur.expires < Date.now();
  if (cur && (forceRestart || caducada)) {
    delete pending[st.phone];
    await persistPending(st.phone); // sin estado en memoria → borra la fila
  }
  // Si ya está en una conversación abierta (y no forzamos), no reenviar el
  // saludo (evita el "Hola 👋" duplicado encima de una charla en curso).
  if (pending[st.phone]) return res.json({ ok: true, student: st.name, note: 'ya en conversación' });

  const profId = st.profId ?? st.prof_id;
  const nextMon = ymdLocal(nextWeekMonday());
  const pistaHours = await pistaFilterFor(st);
  const free = await nextFreeSlots(profId, 80, nextMon, pistaHours, st.vehicleType, nextWeekLastDate());
  if (!free.length) return res.status(409).json({ error: 'No hay huecos disponibles para este profesor' });

  const day0 = daysWithSlots(free)[0];
  const msg =
    `Hola ${st.name} 👋 Soy el asistente de *${SCHOOL_NAME}*.\n\n` +
    `Vamos a organizar tus clases de la semana que viene.\n\n` +
    dayMenuMessage(day0, '') + `\n\n⚠️ El plazo cierra el jueves.`;

  await sendBusinessInitiated(st.phone, TPL_PROPUESTA, [st.name], msg);
  const stt = makeSuggestState({ ...st, profId }, free, true, pistaHours);
  stt.currentDate = day0.date;
  pending[st.phone] = stt;
  await persistPending(st.phone);

  console.log(`📤 CRM → mensaje manual enviado a ${st.name}`);
  res.json({ ok: true, student: st.name });
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

  const cita = `${slot.dayName || formatDate(slot.date)} a las ${slot.time}h`;
  const msg =
    `⏰ *Recordatorio de ${SCHOOL_NAME}*\n\n` +
    `Hola ${st.name}, tienes clase el *${cita}*.\n\n` +
    `Si no puedes venir, avisa a la oficina: *${OFFICE_PHONE}*.\n` +
    `Si no dices nada, la clase se mantiene. ✅`;

  await sendBusinessInitiated(st.phone, TPL_RECORDATORIO, [st.name, cita], msg);
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
  await persistPending(st.phone);

  console.log(`📤 CRM → recordatorio manual enviado a ${st.name}`);
  res.json({ ok: true, student: st.name });
});

// POST /api/notify-cancel — el ADMIN canceló una clase en el panel y quiere
// avisar al alumno por WhatsApp. Recibe los datos de la clase (el slot puede
// que ya no exista en la BD). Envía la plantilla clase_cancelada.
app.post('/api/notify-cancel', async (req, res) => {
  const { studentId, phone, date, time, dayName, end } = req.body || {};
  let name = req.body?.name || '';
  let to = phone || null;
  if (!to && studentId) {
    const st = (await loadStudents()).find(s => s.id === studentId);
    if (st) { to = st.phone; name = name || st.name; }
  }
  if (!to) return res.status(400).json({ error: 'Falta el teléfono del alumno' });
  // Igual que en el aviso de cambio: inicio y fin, para que una clase doble se
  // entienda ("de 11:00 a 12:30") y no parezca que solo se anula media.
  const diaTxt = dayName || (date ? formatDate(date) : '');
  const iniTxt = time ? String(time).substring(0, 5) : '';
  const finTxt = end ? String(end).substring(0, 5) : (iniTxt ? addMinutes(iniTxt, SLOT_MIN) : '');
  const cita = (iniTxt ? `${diaTxt} de ${iniTxt} a ${finTxt}` : diaTxt).trim() || 'tu próxima clase';
  const msg =
    `❌ *Clase cancelada — ${SCHOOL_NAME}*\n\n` +
    `Hola ${name || ''}, tu clase del *${cita}* ha sido *cancelada* por la autoescuela.\n\n` +
    `Si quieres reprogramarla, escríbeme *hola* y te ayudo. 🚗`;
  await sendBusinessInitiated(to, TPL_CANCELADA, [name || '', cita], msg);
  console.log(`📤 CRM → aviso de cancelación enviado a ${name || to}`);
  res.json({ ok: true });
});

// POST /api/notify-move — el ADMIN movió una clase en el panel a otra hora/día
// y quiere avisar al alumno por WhatsApp. Envía la plantilla clase_movida.
app.post('/api/notify-move', async (req, res) => {
  const b = req.body || {};
  let name = b.name || '';
  let to = b.phone || null;
  if (!to && b.studentId) {
    const st = (await loadStudents()).find(s => s.id === b.studentId);
    if (st) { to = st.phone; name = name || st.name; }
  }
  if (!to) return res.status(400).json({ error: 'Falta el teléfono del alumno' });
  // La cita indica SIEMPRE inicio y fin. Es lo que hace que una clase doble
  // (90 min) se entienda: "de 11:00 a 12:30" en vez de solo "a las 11:00".
  // El fin llega del CRM (oldEnd/newEnd) o se calcula con la duración.
  const citaOf = (dayName, date, time, end, dur) => {
    const dia = dayName || (date ? formatDate(date) : '');
    const ini = time ? String(time).substring(0, 5) : '';
    if (!ini) return dia.trim();
    const fin = end ? String(end).substring(0, 5) : addMinutes(ini, Number(dur) || SLOT_MIN);
    return `${dia} de ${ini} a ${fin}`.trim();
  };
  const citaVieja = citaOf(b.oldDayName, b.oldDate, b.oldTime, b.oldEnd, b.oldDuration) || 'tu clase';
  const citaNueva = citaOf(b.newDayName, b.newDate, b.newTime, b.newEnd, b.newDuration) || 'una nueva hora';
  const msg =
    `🔄 *Cambio de horario — ${SCHOOL_NAME}*\n\n` +
    `Hola ${name || ''}, tu clase del *${citaVieja}* se ha *movido*.\n` +
    `Nueva cita: *${citaNueva}*.\n\n` +
    `Si no te viene bien, escríbeme *hola* y lo reorganizamos. 🚗`;
  await sendBusinessInitiated(to, TPL_MOVIDA, [name || '', citaVieja, citaNueva], msg);
  console.log(`📤 CRM → aviso de cambio de horario enviado a ${name || to}`);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => {
  refreshSchoolName();                             // nombre real desde Supabase
  setInterval(refreshSchoolName, 3600000);         // refrescar cada hora
  loadPending();                                   // restaurar conversaciones en curso
  console.log(`\n🚗 AutoEscuela Bot — Puerto ${PORT}`);
  console.log('────────────────────────────────────────');
  console.log(`💾 Modo datos:   ${USE_SUPABASE ? 'Supabase' : 'JSON local'}`);
  console.log('📅 Reservas:     Mar-Jue 9:00');
  console.log('🔒 Cierre:       Jue 23:59');
  console.log('⏰ Recordatorios: cada hora (48h antes)');
  console.log('────────────────────────────────────────');
  console.log('POST /bot                → webhook Twilio (firma validada)');
  console.log('GET  /api/ping           → health check');
  console.log('GET  /status             → estado agregado');
  console.log('POST /api/send-booking/:studentId');
  console.log('POST /api/send-reminder/:slotId');
  console.log(`GET  /test/reservas | /test/recordatorios ${process.env.BOT_API_KEY ? '(protegidos con clave)' : '(SIN clave — configurar BOT_API_KEY)'}`);
});

// ── Red de seguridad global ──────────────────────────────────────────────
// Última barrera: si un error async se escapa de todos los try/catch, aquí se
// registra en vez de tumbar el proceso. Mantiene el bot vivo (y las
// conversaciones en curso) ante cualquier fallo imprevisto.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  unhandledRejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  uncaughtException:', err && err.message ? err.message : err);
});
