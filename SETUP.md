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
   - **School ID** (del paso 1)
   - Pulsar **"Probar conexión"** → debe aparecer ✅
4. **Cerrar sesión y volver a entrar** (admin / `1234`) — al haber Supabase
   configurado, el login ya valida contra la nube y abre una sesión de 12h
5. Pulsar **"Subir a Supabase"** para la primera subida de datos
6. Cambiar la contraseña del admin en la sección de contraseñas

### Cómo funciona la sincronización

- **Login**: valida contra `app_users` en Supabase (hash bcrypt). Devuelve un
  token de sesión de 12 horas guardado en el navegador.
- **Auto-sync**: con sesión de admin activa, el CRM sube todos los datos a
  Supabase cada 60 segundos (indicador "Nube · HH:MM" en el sidebar).
- **Disponibilidad**: al pulsar "Guardar cambios" se sube al instante — el bot
  la lee de Supabase para ofrecer huecos a los alumnos.
- **Cargar desde Supabase**: restaura todos los datos de la nube en cualquier
  ordenador (Configuración → "Cargar desde Supabase").
- Las tablas tienen RLS y **no** son accesibles directamente con el anon key:
  todo pasa por funciones RPC que validan el token de sesión.

---

## Paso 3 — Bot en Railway ✅ DESPLEGADO (7 jul 2026)

| Dato | Valor |
|---|---|
| Proyecto | `autoescuela-bot` (cuenta legionthunder2@gmail.com) |
| URL pública | `https://autoescuela-bot-production.up.railway.app` |
| Healthcheck | `/api/ping` → responde ✅ |

Variables ya configuradas: `SUPABASE_URL`, `SCHOOL_ID`, `NOTIFY_ADMIN`, `TWILIO_SANDBOX_NUM`.

**Falta añadir en [Railway → Variables](https://railway.com/project/86139dc4-3425-4eb6-9398-212da0197c68)** (secretos, los pega el dueño):

| Variable | De dónde |
|---|---|
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → `service_role` |
| `TWILIO_ACCOUNT_SID` | Twilio Console |
| `TWILIO_AUTH_TOKEN` | Twilio Console |

Al guardarlas, Railway redepliega solo y el bot pasa de modo `json_local` a `supabase`
(verificar con `curl https://autoescuela-bot-production.up.railway.app/api/ping`).

**Último paso**: en **Twilio Console → Sandbox Settings** pegar como webhook:
`https://autoescuela-bot-production.up.railway.app/bot`

> Deploy manual desde este Mac: `cd ~/Desktop/autoescuela-crm && railway up --detach`

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
