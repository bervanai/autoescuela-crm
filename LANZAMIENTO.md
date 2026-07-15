# 🚀 Lanzamiento — pasos finales (todo lo demás está hecho)

Datos que ya tienes listos (para copiar/pegar):
- **Webhook del bot:** `https://autoescuela-bot-production.up.railway.app/bot`
- **Verify token:** `exit_autoescuela_2026`  *(ya puesto en Railway)*
- **Panel Railway:** https://railway.com/project/86139dc4-3425-4eb6-9398-212da0197c68

---

## PASO 1 — SIM prepago española *(10 min, en una tienda o online)*
- Compra una SIM prepago (Vodafone/Orange/Simyo/Lowi, ~5-10 €)
- Es el número del bot (los alumnos lo verán como "Autoescuela Exit")
- Solo necesita recibir 1 SMS de verificación

## PASO 2 — Crear la app de Meta *(15 min)*
1. Entra en **developers.facebook.com** → **Create App** → tipo **Business**
2. En el panel → **Add Product → WhatsApp → Set up**
3. Añade tu número (el de la SIM) en **API Setup** y verifícalo con el SMS
4. Copia estos 2 datos:
   - **Phone number ID**
   - **Temporary access token** (luego lo haremos permanente)

## PASO 3 — Pegar los tokens en Railway *(3 min)*
En Railway → `autoescuela-bot` → **Variables** → añade:
```
META_TOKEN            = (el access token)
META_PHONE_NUMBER_ID  = (el phone number ID)
```
Al guardar, el bot cambia solo a modo Meta.

## PASO 4 — Conectar el webhook en Meta *(5 min)*
En Meta → WhatsApp → **Configuration → Webhook → Edit**:
- **Callback URL:** `https://autoescuela-bot-production.up.railway.app/bot`
- **Verify token:** `exit_autoescuela_2026`
- Guarda → en **Webhook fields** suscríbete a **messages** ✅

## PASO 5 — Crear las 2 plantillas *(5 min + espera de Meta)*
En Meta → **WhatsApp → Message Templates → Create**:

**Plantilla 1** — nombre `propuesta_clase`, categoría **Utility**, idioma Español:
```
Hola {{1}} 👋 Soy el asistente de Autoescuela Exit.
Te propongo clase: {{2}}.
Responde SÍ para confirmar o NO para ver otro hueco. El plazo cierra el jueves.
```

**Plantilla 2** — nombre `recordatorio_clase`, categoría **Utility**, idioma Español:
```
Recordatorio de Autoescuela Exit ⏰
Hola {{1}}, tienes clase el {{2}}. Si no puedes venir, responde CANCELAR.
```
> Meta las aprueba en horas-1 día. Avísame cuando estén aprobadas.

## PASO 6 — Token permanente *(10 min, para que no caduque)*
El token del paso 2 caduca en 24h. Para uno permanente:
- Meta → **Business Settings → Users → System Users** → crear uno →
  **Generate token** → app tuya → permisos `whatsapp_business_messaging`
  y `whatsapp_business_management` → copiar y actualizar `META_TOKEN` en Railway.

---

## PASO 7 — Ajustar datos reales en el CRM *(cuando quieras)*
En https://exitautoescuelacrm.es (admin):
- **Disponibilidad** → horario real de Roberto
- **Horario de pista** → horas reales del circuito
- **Alumnos** → revisar fase (Pista/Circulación) de cada uno
- Corregir el teléfono duplicado (Inés Osle / Paula Glez Muñiz)

## PASO 8 — Encender el bot y probar *(el momento del lanzamiento)*
1. Prueba primero contigo: crea un alumno con TU móvil, actívale el bot,
   y usa el botón **Reserva** → deberías recibir el WhatsApp real.
2. Cuando funcione, activa el bot (botón verde) de los alumnos reales.
3. El **martes a las 9:00** el bot escribe solo a los activos.

---

## Verificación rápida (dímelo y lo compruebo yo)
```
curl https://autoescuela-bot-production.up.railway.app/status
```
Debe decir `"whatsapp":"meta"` cuando los tokens estén puestos.

## Resumen de tiempos
| | |
|---|---|
| Pasos 1-4 (SIM + Meta + Railway) | ~30 min tú, hoy |
| Paso 5 (plantillas aprobadas) | horas-1 día (Meta) |
| Enviando a alumnos reales | **mañana** |
