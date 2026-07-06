# AutoEscuela CRM — Guía de puesta en marcha

## Arquitectura

```
GitHub Pages  ←──── CRM (index.html) ──────→ Supabase
                           ↕ polling 15s
Railway       ←──── Bot (bot-server.js) ────→ Supabase
                           ↕ Twilio webhook
                        WhatsApp alumnos
```

---

## Paso 1 — Supabase (base de datos) ✅ HECHO (6 jul 2026)

El proyecto ya está creado y el esquema ejecutado:

| Dato | Valor |
|---|---|
| Proyecto | `autoescuela-crm` (región eu-west-3, París) |
| `SUPABASE_URL` | `https://vxpavrtjgvrxqimsemku.supabase.co` |
| Anon key (CRM) | Dashboard → Settings → API → `anon public` |
| `SCHOOL_ID` | `4a443e53-2cfd-45df-b360-616d7e309687` |

**Solo falta**: copiar la `service_role` key desde
[Dashboard → Settings → API](https://supabase.com/dashboard/project/vxpavrtjgvrxqimsemku/settings/api)
y pegarla en `.env` (local) y en Railway como `SUPABASE_SERVICE_KEY`.

> Nota: el esquema usa IDs de tipo TEXT (no UUID) para ser compatible con los
> IDs que generan el CRM y el bot (`stu_…`, `prof_…`, `slot_…`).

---

## Paso 2 — CRM (GitHub Pages)

El CRM ya está desplegado en GitHub Pages automáticamente.

1. Abrir el CRM → login como Admin (contraseña: `1234`)
2. Ir a **Configuración**
3. Rellenar:
   - Nombre de la autoescuela
   - Color principal
   - **Supabase URL** (del paso 1)
   - **Supabase Anon Key** (del paso 1)
   - Pulsar **"Probar conexión"** → debe aparecer ✅
4. Pulsar **"Sincronizar con Supabase"** para subir los datos existentes
5. Cambiar contraseñas en la sección de contraseñas

---

## Paso 3 — Bot en Railway

1. Crear cuenta en [railway.app](https://railway.app)
2. **New Project → Deploy from GitHub repo** → seleccionar `autoescuela-crm`
3. En **Variables** añadir:

| Variable | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | De Twilio Console |
| `TWILIO_AUTH_TOKEN` | De Twilio Console |
| `TWILIO_SANDBOX_NUM` | `whatsapp:+14155238886` |
| `SUPABASE_URL` | Del paso 1 |
| `SUPABASE_SERVICE_KEY` | Service role key de Supabase |
| `SCHOOL_ID` | UUID de la escuela (paso 1) |
| `NOTIFY_ADMIN` | Teléfono admin con prefijo: `+34600000000` |

4. Railway despliega automáticamente → copiar la URL pública (ej: `autoescuela-bot.up.railway.app`)
5. En **Twilio Console → Sandbox Settings** → pegar: `https://autoescuela-bot.up.railway.app/bot`
6. En **CRM → Configuración** → URL del bot: `https://autoescuela-bot.up.railway.app`

---

## Paso 4 — WhatsApp Business (producción)

Para usar el número propio de la autoescuela en lugar del sandbox de Twilio:

1. La autoescuela necesita tener una cuenta de **Meta Business Manager** verificada
2. En Twilio → **Messaging → Senders → WhatsApp** → solicitar número
3. Meta aprueba en 1-2 semanas
4. Una vez aprobado: cambiar `TWILIO_SANDBOX_NUM` por el número real en Railway
5. Los alumnos ya no necesitan enviar el código de "join" — recibirán mensajes directamente

---

## Verificar que todo funciona

```bash
# Ping al bot
curl https://tu-bot.railway.app/api/ping

# Estado del bot
curl https://tu-bot.railway.app/status

# Lanzar reservas de prueba (fuerza el envío aunque no sea Mar-Jue)
curl https://tu-bot.railway.app/test/reservas
```

---

## Credenciales por defecto del CRM

| Usuario | Contraseña |
|---|---|
| Admin | `1234` |
| Profesores | `1234` |

Cambiarlas en Configuración → Contraseñas de acceso.
