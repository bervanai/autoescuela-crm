# Guía — Poner el bot con número propio de WhatsApp (Twilio + Meta)

Objetivo: pasar del sandbox de pruebas a un número real que envíe mensajes
a los alumnos con el nombre "Autoescuela Exit". Meta tarda 1-2 semanas en
aprobar, así que conviene arrancar cuanto antes.

---

## FASE 0 — Requisitos previos (reúne esto antes de empezar)

- [ ] **Cuenta de Twilio** (ya la tienes)
- [ ] **Tarjeta de crédito** para el upgrade de Twilio
- [ ] **Número de teléfono nuevo y dedicado** que NO esté en la app de
      WhatsApp (recomendado: comprar uno en Twilio, ~1 €/mes). Puede recibir
      SMS/llamada para verificar.
- [ ] **Cuenta de Meta Business** (Business Manager) de la autoescuela:
      https://business.facebook.com — con el nombre, CIF y datos reales.
- [ ] Logo de la autoescuela (foto de perfil) y una descripción corta.

---

## FASE 1 — Upgrade de Twilio (5 min) ⚡ HAZLO YA

Quita el "Sent from your Twilio trial account" y desbloquea el envío real.

1. Entra en https://console.twilio.com
2. Arriba verás "Trial" → botón **Upgrade**
3. Añade una tarjeta y una recarga inicial (con 20 € sobra para empezar)
4. Listo: cuenta de pago activa

---

## FASE 2 — Comprar el número (5 min)

1. Twilio Console → **Phone Numbers → Buy a number**
2. País: España (+34). Marca la capacidad **SMS** (para verificar)
3. Compra el número (~1 €/mes) → apúntalo

> Alternativa: usar un número físico propio (SIM). Recuerda que ese número
> dejará de funcionar en la app normal de WhatsApp.

---

## FASE 3 — Solicitar el WhatsApp Sender (el paso de Meta)

1. Twilio Console → **Messaging → Senders → WhatsApp senders**
2. Botón **Create new sender** → sigue el asistente ("embedded signup")
3. Te pedirá:
   - Conectar / crear tu **Meta Business Manager**
   - El **número** comprado en la Fase 2
   - **Nombre para mostrar**: `Autoescuela Exit`
   - **Categoría**: Educación / Autoescuela
   - Foto de perfil (logo) y descripción
4. Meta te pedirá **verificar el negocio** (subir CIF/documentación de la
   autoescuela). Este es el paso que tarda **1-2 semanas**.
5. Verifica el número con el código SMS que llega al número comprado.

> Mientras Meta revisa, puedes seguir con la Fase 4 (plantillas).

---

## FASE 4 — Plantillas de mensaje (obligatorio para el mensaje del martes)

WhatsApp exige que el **primer mensaje** (el que inicia la conversación,
como la campaña del martes) use una **plantilla aprobada**. Una vez el
alumno responde, ya se puede hablar libre durante 24 h (el resto del flujo
del bot funciona sin plantilla).

En Twilio Console → **Messaging → Content Template Builder** → crea estas:

### Plantilla 1 — Propuesta de clase (categoría: Utility)
Nombre: `propuesta_clase`
```
Hola {{1}} 👋 Soy el asistente de Autoescuela Exit.

Vamos a organizar tus clases de la semana que viene. Te propongo:
📅 {{2}}

¿Te viene bien? Responde SÍ para confirmar o NO para ver otro hueco.
El plazo cierra el jueves.
```
Variables: {{1}} = nombre del alumno · {{2}} = día y hora

### Plantilla 2 — Recordatorio 48h (categoría: Utility)
Nombre: `recordatorio_clase`
```
Recordatorio de Autoescuela Exit ⏰

Hola {{1}}, tienes clase el {{2}}.
Si no puedes venir, responde CANCELAR.
```
Variables: {{1}} = nombre · {{2}} = día y hora

> Meta aprueba las plantillas en 1-3 días. Envíalas cuanto antes.

---

## FASE 5 — Conectar el número al bot (cuando Meta apruebe)

1. En Railway → proyecto `autoescuela-bot` → **Variables**:
   - Cambiar `TWILIO_SANDBOX_NUM` por `whatsapp:+34XXXXXXXXX` (tu número)
2. En Twilio → el sender → configurar el webhook entrante:
   `https://autoescuela-bot-production.up.railway.app/bot`
3. Adaptar el bot para enviar las plantillas aprobadas en los mensajes
   iniciales (esto lo hace Claude en el código cuando tengas los IDs de
   plantilla; avísame).
4. Activar el bot de los alumnos en el CRM (botón verde por alumno).

---

## Resumen de tiempos

| Fase | Tiempo |
|---|---|
| Upgrade Twilio | 5 min (hoy) |
| Comprar número | 5 min (hoy) |
| Solicitar sender + verificación Meta | **1-2 semanas** (Meta) |
| Aprobar plantillas | 1-3 días (en paralelo) |
| Conectar al bot | 10 min (cuando aprueben) |

**Arranca hoy las fases 1, 2, 3 y 4 para que el reloj de Meta corra.**
