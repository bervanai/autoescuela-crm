# Guía — Bot con Meta WhatsApp Cloud API (lo controlas tú, gratis)

Esta es la vía recomendada para tu modelo: montas todo bajo TU propio
negocio, sin pedir datos a la autoescuela, gratis hasta 1.000 conversaciones
al mes, y puedes empezar a **probar hoy mismo** con un número de test.

El bot ya está preparado para Meta. Solo tienes que crear la app y poner
4 variables en Railway.

---

## FASE 1 — Crear la app de Meta (15 min) — puedes empezar HOY

1. Ve a **https://developers.facebook.com** e inicia sesión con tu Facebook.
2. **My Apps → Create App** → tipo **"Business"** → dale un nombre
   (ej: "Autoescuela Exit Bot").
3. En el panel de la app → **Add Product** → busca **WhatsApp** → **Set up**.
4. Te pedirá asociar/crear un **Meta Business Portfolio** (tu negocio).
   Créalo con tus datos de autónomo (esto es lo que verificarás una vez y
   reutilizas para todos tus clientes).

---

## FASE 2 — Número de PRUEBAS (instantáneo, para empezar hoy)

En **WhatsApp → API Setup** verás:
- Un **número de prueba** de Meta ya asignado (gratis)
- **From** → el `Phone number ID` (un número largo, NO el teléfono) → apúntalo
- **Temporary access token** (dura 24h) → apúntalo
- Abajo, **"To"**: añade tu móvil como destinatario de prueba (hasta 5).
  Meta te manda un código para verificarlo.

Con esto ya puedes probar el bot enviándote mensajes a ti mismo, sin
esperar nada.

---

## FASE 3 — Conectar al bot (5 min)

En **Railway → proyecto autoescuela-bot → Variables**, añade:

| Variable | De dónde sale |
|---|---|
| `META_TOKEN` | El access token de la Fase 2 |
| `META_PHONE_NUMBER_ID` | El "Phone number ID" de la Fase 2 |
| `META_VERIFY_TOKEN` | Una palabra que inventas tú (ej: `exit_2026`) |

Al guardar, Railway redespliega y el bot pasa a modo Meta (compruébalo:
`curl https://autoescuela-bot-production.up.railway.app/status` → debe
decir `"whatsapp":"meta"`).

---

## FASE 4 — Configurar el webhook (5 min)

Para que el bot RECIBA las respuestas de los alumnos:

1. En la app de Meta → **WhatsApp → Configuration → Webhook** → **Edit**
2. **Callback URL**: `https://autoescuela-bot-production.up.railway.app/bot`
3. **Verify token**: la misma palabra que pusiste en `META_VERIFY_TOKEN`
4. **Verify and save** (el bot responde solo al reto de Meta)
5. En **Webhook fields** → suscríbete a **messages** ✅

Ya está: envías desde el bot y recibes las respuestas.

---

## FASE 5 — Token permanente (importante)

El token de la Fase 2 caduca en 24h. Para uno que no caduque:

1. Meta Business Settings → **System Users** → crea un usuario de sistema
2. Asígnale permiso sobre la app de WhatsApp
3. **Generate token** con permisos `whatsapp_business_messaging` y
   `whatsapp_business_management` → márcalo **sin caducidad**
4. Pon ese token en `META_TOKEN` en Railway

---

## FASE 6 — Producción (número propio + verificación)

Para dejar de usar el número de prueba y enviar a todos los alumnos:

1. **WhatsApp → API Setup → Add phone number** → añade tu número dedicado
   (uno que NO esté en la app de WhatsApp) con el nombre **"Autoescuela Exit"**.
2. **Verifica tu negocio** en Meta Business Settings (subes tus datos de
   autónomo UNA vez). Mientras está sin verificar, puedes enviar con límite
   de ~250 conversaciones/día (de sobra para una autoescuela).
3. **Plantillas**: para el mensaje del martes (que inicia la conversación)
   Meta exige plantilla aprobada. En **WhatsApp → Message Templates** crea:
   - `propuesta_clase` (Utility) — la propuesta de clase
   - `recordatorio_clase` (Utility) — el recordatorio 48h
   (Meta las aprueba en 1-3 días.)
4. Avísame los nombres de las plantillas aprobadas y adapto el bot para
   enviarlas en los mensajes iniciales (el bot ya tiene `sendTemplateMeta`).

---

## Resumen de tiempos

| Fase | Tiempo |
|---|---|
| App Meta + número de prueba | 20 min (HOY) |
| Conectar al bot + webhook | 10 min (HOY) |
| **→ Ya puedes probar contigo mismo hoy** | |
| Token permanente | 10 min |
| Número propio + verificación negocio | días (en paralelo, límite 250/día mientras) |
| Plantillas aprobadas | 1-3 días |

**Ventaja clave:** lo verificas UNA vez con tu negocio y sirve para todas
las autoescuelas que vendas. Cada cliente nuevo = añadir un número.
